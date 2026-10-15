import { createEffect, Show, onCleanup, onMount, createSignal } from 'solid-js'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import CollapsedPill from './CollapsedPill'
import ExpandedPanel from './ExpandedPanel'
import AmbientBackground from './AmbientBackground'
import FileDropToast, { type FileDropTarget } from './FileDropToast'
import EventPeek from './EventPeek'
import {
  expanded,
  open,
  hovering,
  setHovering,
  expandIsland,
  collapseIsland,
  pinned,
  closing,
} from '../../state/ui'
import { spotlightOpen } from '../../state/spotlight'
import { flushSettings, settings } from '../../state/settings'
import { nearby } from '../../state/nearby'
import { peek, transientPeek, promotePeek } from '../../state/peek'
import { maximizedForeground } from '../../state/window'
import { browserPreview, cmd, listen, onIslandHover } from '../../lib/ipc'
import { reportError } from '../../state/feedback'
import { createIslandSpring, createMagneticSpring, type SpringFrame } from '../../state/motion'
import { refreshTransfer, uploads } from '../../state/transfer'
import { filesFromDrop } from '../../lib/droppedFiles'
import { canExpandOnHover, fileDropActionAtRelease, fileDropDestinationAt, physicalDragPositionToCss, updateFileDropPreview, type FileDropPreviewState } from '../../lib/fileDropTargets'
import { shouldExpandAfterSustainedHover } from '../../state/hover'
import { beginIslandPlacementDrag, cancelIslandPlacementDrag, consumePlacementClick, finishIslandPlacementDrag, isPlacementDragging, isPlacementGesturePending, moveIslandPlacementDrag } from '../../state/placement'
import { canStartIslandPlacementDrag } from '../../lib/placementPointerDrag'
import './IslandPlacement.css'

export default function Island() {
  let enterTimer: ReturnType<typeof setTimeout> | undefined
  let leaveTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let unsubscribe: (() => void) | undefined
  let islandElement: HTMLDivElement | undefined
  let shapeSpring: ReturnType<typeof createIslandSpring> | undefined
  let magneticSpring: ReturnType<typeof createMagneticSpring> | undefined
  let reduceMotion = false
  let motionPreference: MediaQueryList | undefined
  let leavePending = false
  let unsubscribeProximity: (() => void) | undefined
  let fileDropBoundsActive = false
  let fileDragActive = false
  let dropRevision = 0
  let dropFeedbackTimer: ReturnType<typeof setTimeout> | undefined
  const [pointerInside, setPointerInside] = createSignal(false)
  const [viewport, setViewport] = createSignal({ width: window.innerWidth, height: window.innerHeight })
  const [fileDrop, setFileDrop] = createSignal<(FileDropPreviewState & { message?: string }) | null>(null)
  const beginFileDrag = () => {
    if (!fileDragActive) { dropRevision++; clearTimeout(dropFeedbackTimer) }
    fileDragActive = true
  }
  const cancelFileDrag = () => {
    fileDragActive = false
    dropRevision++
    clearTimeout(dropFeedbackTimer)
    setFileDrop(null)
  }
  const dropFeedback = (revision: number, state: FileDropPreviewState & { message?: string }, delay = 1700) => {
    if (disposed || revision !== dropRevision) return
    setFileDrop(state)
    clearTimeout(dropFeedbackTimer)
    dropFeedbackTimer = setTimeout(() => {
      if (!disposed && revision === dropRevision) setFileDrop(null)
    }, delay)
  }
  // Every activity temporarily owns the visible notch surface. The dashboard
  // underneath keeps its state and returns when the activity expires.
  const compactPeek = () => !!peek()
  const sideEdge = () => settings.placement.edge === 'left' || settings.placement.edge === 'right'
  const sideNotch = () => settings.placement.mode === 'notch' && sideEdge()
  const sideDock = () => settings.placement.mode === 'sidebar' || (settings.placement.mode === 'notch' && sideEdge())
  const barDock = () => settings.placement.mode === 'bar'
  const devicePeek = () => compactPeek() && ['Bluetooth', 'Battery', 'Do Not Disturb', 'Volume', 'Brightness'].includes(peek()?.app ?? '')
  const transferPeek = () => compactPeek() && (peek()?.category === 'transfer' || peek()?.app === 'Phone bucket')
  const targetAt = (x: number, y: number): FileDropTarget => {
    const rect = (destination: 'recycle' | 'beam') => {
      const bounds = document.querySelector<HTMLElement>(`[data-drop-target="${destination}"]`)?.getBoundingClientRect()
      return bounds ? { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom } : undefined
    }
    return fileDropDestinationAt({ x, y }, { recycle: rect('recycle'), beam: rect('beam') })
  }

  // Hide behind a maximized window until the pointer enters the notch region.
  const veiled = () =>
    settings.hideBehindWindows &&
    maximizedForeground() &&
    !hovering() &&
    !expanded() &&
    !pinned() &&
    !peek() &&
    !fileDrop()

  const canClose = () =>
    !pinned() &&
    !isPlacementDragging() &&
    !isPlacementGesturePending() &&
    !fileDrop() &&
    !spotlightOpen() &&
    (!peek() || !transientPeek()) &&
    !uploads().some((upload) => !upload.error) &&
    !nearby().transfers.some((transfer) => transfer.status === 'pending') &&
    !document.activeElement?.matches('input, textarea, select, [role="slider"]')

  const attemptClose = () => {
    if (!leavePending || hovering() || !canClose()) return
    leavePending = false
    void flushSettings().catch(() => {})
    collapseIsland()
  }

  const scheduleHoverOpen = () => {
    clearTimeout(enterTimer)
    if (!canExpandOnHover({ enabled: settings.interaction.hoverOpen, alreadyOpen: open(), placementDragging: isPlacementDragging() || isPlacementGesturePending(), fileDragging: !!fileDrop() })) return
    const enteredAt = performance.now()
    const delay = settings.interaction.openDelayMs
    enterTimer = setTimeout(() => {
      enterTimer = undefined
      if (shouldExpandAfterSustainedHover(enteredAt, performance.now(), delay, pointerInside() && canExpandOnHover({ enabled: true, alreadyOpen: open(), placementDragging: isPlacementDragging() || isPlacementGesturePending(), fileDragging: !!fileDrop() }) && !document.querySelector('.pill__compact-controls:hover, .pill__alert-badge:hover'))) {
        expandIsland()
      }
    }, delay)
  }

  createEffect(() => {
    canClose()
    if (leavePending) attemptClose()
  })

  const leave = () => {
    if (!pointerInside()) return
    setPointerInside(false)
    clearTimeout(enterTimer)
    clearTimeout(leaveTimer)
    leaveTimer = setTimeout(() => {
      if (pointerInside()) return
      leavePending = true
      setHovering(false)
      attemptClose()
    }, settings.interaction.closeDelayMs)
  }

  const enter = () => {
    if (peek()) { clearTimeout(enterTimer); return }
    if (fileDrop()) return
    if (isPlacementGesturePending()) { clearTimeout(enterTimer); enterTimer = undefined; return }
    clearTimeout(leaveTimer)
    leavePending = false
    const newlyEntered = !pointerInside()
    setPointerInside(true)
    setHovering(true)
    if (!open() && document.querySelector('.pill__compact-controls:hover, .pill__alert-badge:hover')) {clearTimeout(enterTimer);enterTimer=undefined;return}
    if (transientPeek()) promotePeek()
    if (newlyEntered || (!open() && enterTimer===undefined)) scheduleHoverOpen()
  }
  void onIslandHover(value => value ? enter() : leave()).then(fn => disposed ? fn() : unsubscribe = fn).catch(error => reportError('Hover tracking failed',error))
  const targetFrame = (): SpringFrame => {
    // A shelf owns the whole horizontal monitor edge; a sidebar owns the whole
    // vertical edge. The window is resized natively to these same viewport bounds.
    if (fileDrop()) return sideEdge()
      ? { width: Math.min(420, settings.expanded.w), height: 110, radius: 28 }
      : { width: Math.min(366, settings.expanded.w), height: 92, radius: 24 }
    if (!open() || closing()) return barDock()
      ? { width: viewport().width, height: settings.collapsed.h, radius: 17 }
      : settings.placement.mode === 'sidebar'
        ? { width: 72, height: viewport().height, radius: 0 }
        : sideNotch()
          ? { width: 56, height: 144, radius: 28 }
        : { width: settings.collapsed.w, height: settings.collapsed.h, radius: 17 }
    if (transferPeek()) {
      return { width: Math.min(440, settings.expanded.w), height: 148, radius: 24 }
    }
    if (compactPeek()) {
      return devicePeek()
        ? { width: Math.min(340, settings.expanded.w), height: 84, radius: 20 }
        : { width: Math.min(420, settings.expanded.w), height: 112, radius: 22 }
    }
    // Left and right anchors expand into a narrow, edge-attached sidebar. Keep
    // the host window transparent and let the spring clip to this visible width.
    if (barDock()) return { width: viewport().width, height: settings.expanded.h, radius: 26 }
    if (settings.placement.mode === 'sidebar') return { width: Math.min(settings.expanded.w, 420), height: viewport().height, radius: 26 }
    return { width: sideDock() ? Math.min(settings.expanded.w, 420) : settings.expanded.w, height: settings.expanded.h, radius: 26 }
  }

  const publishShape = (frame: SpringFrame) => {
    const node = islandElement
    if (!node) return
    node.style.setProperty('--island-spring-width', `${frame.width.toFixed(2)}px`)
    node.style.setProperty('--island-spring-height', `${frame.height.toFixed(2)}px`)
    node.style.setProperty('--island-spring-radius', `${frame.radius.toFixed(2)}px`)
  }

  const publishMagnet = (offset: { x: number; y: number }) => {
    islandElement?.style.setProperty('--magnet-x', `${offset.x.toFixed(2)}px`)
    islandElement?.style.setProperty('--magnet-y', `${offset.y.toFixed(2)}px`)
  }

  createEffect(() => {
    // Read all target inputs here so a new event or user gesture retargets the
    // existing spring rather than starting a second animation from stale CSS.
    const frame = targetFrame()
    const spring = shapeSpring
    if (spring) spring.retarget(frame)
    if (expanded() || closing() || fileDrop() || fileDropBoundsActive) {
      fileDropBoundsActive = !!fileDrop()
      void cmd.setInteractionBounds(frame.width, frame.height)
        .catch(error => reportError('Could not update interaction area', error))
    }
    if (magneticSpring && (open() || closing() || isPlacementDragging() || isPlacementGesturePending() || fileDrop() || settings.placement.mode !== 'notch' || reduceMotion)) {
      magneticSpring.retarget({ x: 0, y: 0 })
    }
  })

  onMount(() => {
    const updateViewport = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    const viewportObserver = new ResizeObserver(updateViewport)
    viewportObserver.observe(document.documentElement)
    window.addEventListener('resize', updateViewport)
    motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
    reduceMotion = motionPreference.matches
    const collapsed = { width: settings.collapsed.w, height: settings.collapsed.h, radius: 17 }
    shapeSpring = createIslandSpring(collapsed, publishShape, () => reduceMotion)
    shapeSpring.snap(targetFrame())
    magneticSpring = createMagneticSpring(publishMagnet, () => reduceMotion)
    void listen<{ x: number; y: number }>('island://proximity', event => {
      const active = !reduceMotion && settings.placement.mode === 'notch' && !open() && !closing() && !isPlacementDragging() && !isPlacementGesturePending()
      magneticSpring?.retarget(active ? event.payload : { x: 0, y: 0 })
    }).then(fn => disposed ? fn() : unsubscribeProximity = fn).catch(error => reportError('Could not track cursor proximity', error))
    const onMotionChange = (event: MediaQueryListEvent) => {
      reduceMotion = event.matches
      if (reduceMotion) {
        shapeSpring?.snap(targetFrame())
        magneticSpring?.snap()
      } else {
        shapeSpring?.retarget(targetFrame())
        magneticSpring?.retarget({ x: 0, y: 0 })
      }
    }
    motionPreference.addEventListener('change', onMotionChange)
    let unlistenFileDrop: (() => void) | undefined
    if (!browserPreview) {
      void getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload
        const current = fileDrop()
        if (payload.type === 'enter' || payload.type === 'over') {
          beginFileDrag()
          const position = payload.position
          const cssPoint = physicalDragPositionToCss(position, window.devicePixelRatio)
          clearTimeout(enterTimer)
          clearTimeout(leaveTimer)
          setPointerInside(false)
          setHovering(false)
          setFileDrop(updateFileDropPreview(current, {
            type: payload.type,
            paths: payload.type === 'enter' ? payload.paths : undefined,
          }, targetAt(cssPoint.x, cssPoint.y)))
          return
        }
        if (payload.type === 'leave') {
          if (fileDragActive) cancelFileDrag()
          return
        }
        if (payload.type === 'drop') {
          fileDragActive = false
          const revision = ++dropRevision
          const position = payload.position
          const paths = payload.paths ?? current?.paths ?? []
          const cssPoint = physicalDragPositionToCss(position, window.devicePixelRatio)
          const target = fileDropActionAtRelease(targetAt(cssPoint.x, cssPoint.y), paths)
          if (target === 'recycle' && paths.length) {
            setFileDrop({ paths, count: paths.length, target, message: 'Moving to Recycle Bin…' })
            void cmd.recycleDroppedPaths(paths).then((result) => {
              dropFeedback(revision, { paths, count: paths.length, target, message: result.cancelled
                ? 'Cancelled'
                : result.failed
                  ? `${result.recycled} recycled · ${result.failed} failed`
                  : `${result.recycled} moved to Recycle Bin` })
            }).catch((error) => {
              dropFeedback(revision, { paths, count: paths.length, target, message: 'Could not recycle files' }, 2000)
              reportError('Could not move dropped items to the Recycle Bin', error)
            })
          } else if (target === 'beam' && paths.length) {
            setFileDrop({ paths, count: paths.length, target, message: 'Adding to Beam bucket…' })
            void cmd.transferStageDroppedPaths(paths).then(async () => {
              await refreshTransfer()
              dropFeedback(revision, { paths, count: paths.length, target, message: 'Added to Beam bucket' })
            }).catch((error) => {
              dropFeedback(revision, { paths, count: paths.length, target, message: 'Could not add to Beam bucket' }, 2000)
              reportError('Could not add dropped items to the Beam bucket', error)
            })
          } else {
            setFileDrop(null)
          }
        }
      }).then((fn) => {
        if (disposed) fn()
        else unlistenFileDrop = fn
      }).catch((error) => reportError('Could not track file drops', error))
    }
    onCleanup(() => {
      viewportObserver.disconnect()
      window.removeEventListener('resize', updateViewport)
      motionPreference?.removeEventListener('change', onMotionChange)
      unlistenFileDrop?.()
      shapeSpring?.dispose()
      magneticSpring?.dispose()
      unsubscribeProximity?.()
      shapeSpring = undefined
      magneticSpring = undefined
    })
  })

  const hasFileDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
  const isPhoneBucketDrop = (event: DragEvent) =>
    event.target instanceof Element && !!event.target.closest('.phone-bucket__drop')
  const handleFileDragOver = (event: DragEvent) => {
    if (!browserPreview) return
    // The phone-bucket panel owns its own drop zone. Let its handler process
    // those drops so bubbling does not upload the same files twice.
    if (isPhoneBucketDrop(event)) return
    if (!hasFileDrag(event)) return
    beginFileDrag()
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    setFileDrop(updateFileDropPreview(fileDrop(), { type: 'over', count: event.dataTransfer?.files.length }, targetAt(event.clientX, event.clientY)))
  }
  const handleFileDragLeave = (event: DragEvent) => {
    if (!browserPreview || !fileDrop() || !hasFileDrag(event)) return
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget instanceof Node && event.currentTarget.contains(next)) return
    cancelFileDrag()
  }
  const handleFileDrop = (event: DragEvent) => {
    if (!browserPreview) return
    if (isPhoneBucketDrop(event)) return
    if (!hasFileDrag(event)) return
    event.preventDefault()
    if (!event.dataTransfer) return
    fileDragActive = false
    const revision = ++dropRevision
    const target = targetAt(event.clientX, event.clientY)
    if (target !== 'beam') { setFileDrop(null); return }
    setFileDrop({ paths: [], count: event.dataTransfer.files.length || 1, target, message: 'Preview only' })
    void filesFromDrop(event.dataTransfer).then(files => {
      dropFeedback(revision, { paths: [], count: files.length, target, message: 'Beam needs the desktop app' })
    }).catch(error => reportError('Could not prepare the dropped files', error))
  }

  onCleanup(() => {
    disposed = true
    unsubscribe?.()
    clearTimeout(enterTimer)
    clearTimeout(leaveTimer)
    clearTimeout(dropFeedbackTimer)
  })

  return (
    <div
      class="island-stage"
      classList={{ 'island-stage--veiled': veiled() }}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
      onPointerDown={event => {
        if (!(event.target instanceof Element) || fileDrop() || compactPeek()) return
        const target = event.target
        const interactive = target.closest('button,a,input,textarea,select,[role="button"],[role="tab"],[role="slider"],[data-no-drag],[contenteditable],.pill__compact-controls,.pill__alert-badge,.panel__tools')
        const collapsedSurface = !open() ? target.closest<HTMLElement>('.island__bar') : null
        const expandedSurface = open() ? target.closest<HTMLElement>('.panel__head') : null
        const captureTarget = collapsedSurface ?? expandedSurface
        if (!canStartIslandPlacementDrag({
          button: event.button,
          isPrimary: event.isPrimary,
          insideDraggableSurface: !!captureTarget,
          onInteractiveControl: !!interactive,
        })) return
        if (captureTarget && beginIslandPlacementDrag(event, captureTarget)) {
          clearTimeout(enterTimer)
          enterTimer = undefined
        }
      }}
      onPointerMove={moveIslandPlacementDrag}
      onPointerUp={event => {
        void finishIslandPlacementDrag(event)
      }}
      onPointerCancel={event => { void cancelIslandPlacementDrag(event.pointerId) }}
      onLostPointerCapture={event => { void cancelIslandPlacementDrag(event.pointerId) }}
      onPointerEnter={(event) => {
        if (browserPreview && event.pointerType !== 'touch') enter()
      }}
      onPointerLeave={() => { if (browserPreview) leave() }}
      onPointerOver={event => {
        if (open()) return
        if (isPlacementGesturePending()) {clearTimeout(enterTimer);enterTimer=undefined;return}
        if (event.target instanceof Element && event.target.closest('.pill__compact-controls, .pill__alert-badge')) {clearTimeout(enterTimer);enterTimer=undefined;return}
        enter()
      }}
      onFocusIn={() => {
        if (!compactPeek() && transientPeek()) promotePeek()
      }}
      onFocusOut={() => {
        if (!pointerInside()) leave()
      }}
    >
      <div ref={islandElement} class="island" onPointerMove={event => {
        if (!open()) return
        const rect = event.currentTarget.getBoundingClientRect()
        event.currentTarget.style.setProperty('--pointer-x', `${((event.clientX - rect.left) / rect.width - .5) * 30}px`)
        event.currentTarget.style.setProperty('--pointer-y', `${((event.clientY - rect.top) / rect.height - .5) * 20}px`)
      }} classList={{ 'island--open': open(), 'island--hover': hovering(), 'island--peek': compactPeek(), 'island--live-activity': compactPeek(), 'island--device-peek': devicePeek(), 'island--transfer-peek': transferPeek(), 'island--dragging': isPlacementDragging(), 'island--file-drop': !!fileDrop(), 'island--notch-side': sideNotch(), [`island--edge-${settings.placement.edge}`]: true, [`island--mode-${settings.placement.mode}`]: true }}>
        <AmbientBackground/>
        <div class="island__collapsed" inert={open() || !!fileDrop() || compactPeek()} aria-hidden={open() || !!fileDrop() || compactPeek()}>
            <div
              class="island__bar"
              role="group"
              aria-label="Hover Island compact view. Activate to open; media controls are available inside."
              title="Open Hover Island"
              tabIndex={0}
              onClick={event => {
                if (consumePlacementClick()) { event.preventDefault(); event.stopPropagation(); return }
                if (event.target instanceof Element && event.target.closest('button')) return
                promotePeek()
                expandIsland()
              }}
              onKeyDown={event => {
                if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
                event.preventDefault()
                promotePeek()
                expandIsland()
              }}
            >
              <CollapsedPill />
            </div>
        </div>
        <div class="island__expanded" inert={!open() || !!fileDrop() || compactPeek()} aria-hidden={!open() || !!fileDrop() || compactPeek()}>
          <ExpandedPanel />
        </div>
        <Show when={compactPeek() && !fileDrop()}><div class="live-activity"><EventPeek/></div></Show>
        <Show when={fileDrop()}>{drop => <FileDropToast
          count={drop().count}
          target={drop().target}
          message={drop().message}
          edge={settings.placement.edge}
          mode={settings.placement.mode}
        />}</Show>
      </div>
    </div>
  )
}
