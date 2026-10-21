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
  beginSurfaceInteraction,
  endSurfaceInteraction,
  noteSurfaceInteraction,
} from '../../state/ui'
import { spotlightOpen } from '../../state/spotlight'
import { onboardingOpen, tourActive } from '../../state/onboarding'
import { flushSettings, settings } from '../../state/settings'
import { nearby } from '../../state/nearby'
import { peek, transientPeek, promotePeek, dismissPeek } from '../../state/peek'
import { maximizedForeground } from '../../state/window'
import { browserPreview, cmd, listen, onIslandHover, onIslandReveal } from '../../lib/ipc'
import { reportError } from '../../state/feedback'
import { createIslandSpring, createMagneticSpring, type SpringFrame } from '../../state/motion'
import { refreshTransfer, uploads } from '../../state/transfer'
import { filesFromDrop } from '../../lib/droppedFiles'
import { canExpandOnHover, fileDropActionAtRelease, fileDropDestinationAt, physicalDragPositionToCss, pointNearAnchoredSurface, updateFileDropPreview, type FileDropPreviewState } from '../../lib/fileDropTargets'
import { shouldExpandAfterSustainedHover } from '../../state/hover'
import { appearanceKey } from '../../lib/appearance'
import { applyTemplate } from '../../lib/themes'
import { applyAccent } from '../../state/ui'
import { earNotchPath, edgeInsetClip, magneticNotchPath } from '../../lib/magneticShape'
import './IslandPlacement.css'

const NOTCH_EAR = 10
const NOTCH_RADIUS = 9
const SIDE_CAPSULE_W = 40
const SIDE_CAPSULE_H = 128

export default function Island() {
  let enterTimer: ReturnType<typeof setTimeout> | undefined
  let leaveTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let unsubscribe: (() => void) | undefined
  let revealUnlisten: (() => void) | undefined
  let islandElement: HTMLDivElement | undefined
  let collapsedElement: HTMLDivElement | undefined
  const viewSize = { width: window.innerWidth, height: window.innerHeight }
  let shapeSpring: ReturnType<typeof createIslandSpring> | undefined
  let magneticSpring: ReturnType<typeof createMagneticSpring> | undefined
  let magneticOffset = { x: 0, y: 0 }
  let shapeFrame: SpringFrame | undefined
  let reduceMotion = false
  let motionPreference: MediaQueryList | undefined
  let leavePending = false
  let unsubscribeProximity: (() => void) | undefined
  let fileDropBoundsActive = false
  let fileDragActive = false
  let suppressHoverUntil = 0
  let dragOwnsInteraction = false
  const [proximity, setProximity] = createSignal(0)
  const fileHoverBlocked = () => fileDragActive || !!fileDrop() || performance.now() < suppressHoverUntil
  let dropRevision = 0
  let dropFeedbackTimer: ReturnType<typeof setTimeout> | undefined
  const [pointerInside, setPointerInside] = createSignal(false)
  const [viewport, setViewport] = createSignal({ width: window.innerWidth, height: window.innerHeight })
  const [fileDrop, setFileDrop] = createSignal<(FileDropPreviewState & { message?: string; phase?: 'pending' | 'complete' | 'error' | 'cancelled' }) | null>(null)
  const beginFileDrag = () => {
    if (!fileDragActive) { dropRevision++; clearTimeout(dropFeedbackTimer) }
    fileDragActive = true
    suppressHoverUntil = performance.now() + 700
    clearTimeout(enterTimer)
    clearTimeout(leaveTimer)
    leavePending = false
    setPointerInside(false)
    setHovering(false)
    setProximity(0)
    if (!dragOwnsInteraction) { dragOwnsInteraction = true; beginSurfaceInteraction() }
  }
  const finishFileInteraction = () => {
    suppressHoverUntil = performance.now() + 700
    if (dragOwnsInteraction) { dragOwnsInteraction = false; endSurfaceInteraction() }
  }
  const cancelFileDrag = () => {
    fileDragActive = false
    finishFileInteraction()
    dropRevision++
    clearTimeout(dropFeedbackTimer)
    setFileDrop(null)
  }
  const dropFeedback = (revision: number, state: FileDropPreviewState & { message?: string; phase?: 'pending' | 'complete' | 'error' | 'cancelled' }, delay = 1700) => {
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
  const authPeek = () => compactPeek() && peek()?.category === 'auth'
  const toastPeek = () => compactPeek() && peek()?.category === 'feedback'
  const targetAt = (x: number, y: number): FileDropTarget => {
    const rect = (destination: 'recycle' | 'beam') => {
      const bounds = document.querySelector<HTMLElement>(`[data-drop-target="${destination}"]`)?.getBoundingClientRect()
      return bounds ? { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom } : undefined
    }
    return fileDropDestinationAt({ x, y }, { recycle: rect('recycle'), beam: rect('beam') })
  }
  const dragNearSurface = (x: number, y: number) => {
    const host = islandElement?.getBoundingClientRect()
    if (!host) return false
    const frame = shapeFrame ?? targetFrame()
    return pointNearAnchoredSurface({ x, y }, host, frame.width, frame.height, settings.placement.edge)
  }

  // Hide behind a maximized window until the pointer gets near the notch.
  const [revealNear, setRevealNear] = createSignal(false)
  void onIslandReveal(setRevealNear).then(fn => disposed ? fn() : revealUnlisten = fn).catch(() => {})
  const veiled = () =>
    settings.hideBehindWindows &&
    maximizedForeground() &&
    !revealNear() &&
    !hovering() &&
    !expanded() &&
    !pinned() &&
    !peek() &&
    !fileDrop()

  const canClose = () =>
    !pinned() &&
    !onboardingOpen() &&
    !tourActive() &&
    !fileDrop() &&
    !spotlightOpen() &&
    !peek() &&
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
    if (tourActive()) return
    if (!canExpandOnHover({ enabled: settings.interaction.hoverOpen, alreadyOpen: open(), placementDragging: false, fileDragging: fileHoverBlocked() })) return
    const enteredAt = performance.now()
    const delay = settings.interaction.openDelayMs
    enterTimer = setTimeout(() => {
      enterTimer = undefined
      if (shouldExpandAfterSustainedHover(enteredAt, performance.now(), delay, pointerInside() && canExpandOnHover({ enabled: true, alreadyOpen: open(), placementDragging: false, fileDragging: fileHoverBlocked() }) && !document.querySelector('.pill__compact-controls:hover, .pill__alert-badge:hover'))) {
        expandIsland()
      }
    }, delay)
  }

  createEffect(() => {
    canClose()
    if (leavePending) attemptClose()
  })
  // A peek is never left on screen over a collapsed shape: if the island is closed from
  // elsewhere (hotkey, tray, Escape) while one is showing, the peek ends with it.
  createEffect(() => {
    if (peek() && !open() && !fileDrop()) dismissPeek()
  })

  const leave = () => {
    if (!pointerInside()) return
    setPointerInside(false)
    clearTimeout(enterTimer)
    clearTimeout(leaveTimer)
    leaveTimer = setTimeout(() => {
      if (pointerInside()) return
      // A focused slider or field would otherwise keep the island open after the pointer left.
      const focused = document.activeElement
      if (focused instanceof HTMLElement && !spotlightOpen() && focused.matches('input, textarea, select, [role="slider"]')) focused.blur()
      leavePending = true
      setHovering(false)
      attemptClose()
    }, settings.interaction.closeDelayMs)
  }

  const enter = () => {
    if (peek()) { clearTimeout(enterTimer); return }
    if (fileHoverBlocked()) { clearTimeout(enterTimer); return }
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
  // The resting shape for the current dock, with no peek or drop on top.
  const collapsedFrame = (): SpringFrame => barDock()
    ? { width: viewport().width, height: settings.collapsed.h, radius: 17 }
    : settings.placement.mode === 'sidebar'
      ? { width: 72, height: viewport().height, radius: 24 }
      : sideNotch()
        // Native hover tracking assumes this 56 x 144 capsule, so keep it in step with placement.rs.
        ? { width: SIDE_CAPSULE_W + proximity() * 6, height: SIDE_CAPSULE_H, radius: 22 }
        : { width: settings.collapsed.w + (settings.placement.mode === 'notch' && settings.placement.edge === 'top' ? NOTCH_EAR * 2 : 0) + proximity() * 18, height: settings.collapsed.h, radius: settings.placement.mode === 'notch' && settings.placement.edge === 'top' ? NOTCH_RADIUS : Math.round(settings.collapsed.h / 2) }
  // The dashboard itself. Left and right anchors expand into a narrow, edge-attached
  // panel; the transparent host just lets the spring clip reveal it.
  const expandedFrame = (): SpringFrame => {
    if (barDock()) return { width: viewport().width, height: settings.expanded.h, radius: 32 }
    if (settings.placement.mode === 'sidebar') return { width: Math.min(settings.expanded.w, 420), height: viewport().height, radius: 32 }
    return { width: sideDock() ? Math.min(settings.expanded.w, 420) : settings.expanded.w, height: settings.expanded.h, radius: 32 }
  }
  const desiredFrame = (): SpringFrame => {
    // A shelf owns the whole horizontal monitor edge; a sidebar owns the whole
    // vertical edge. The window is resized natively to these same viewport bounds.
    if (fileDrop()) return sideEdge()
      ? { width: Math.min(420, settings.expanded.w), height: 110, radius: 28 }
      : { width: Math.min(366, settings.expanded.w), height: 92, radius: 24 }
    if (!open() || closing()) return collapsedFrame()
    if (transferPeek()) {
      return { width: Math.min(440, settings.expanded.w), height: 148, radius: 24 }
    }
    if (toastPeek()) return { width: Math.min(220, settings.expanded.w), height: 46, radius: 23 }
    if (authPeek()) return { width: Math.min(420, settings.expanded.w), height: 112, radius: 22 }
    if (compactPeek()) {
      return devicePeek()
        ? { width: Math.min(340, settings.expanded.w), height: 84, radius: 20 }
        : { width: Math.min(420, settings.expanded.w), height: peek()?.actions?.length ? 132 : 112, radius: 22 }
    }
    return expandedFrame()
  }

  const clampToViewport = (frame: SpringFrame): SpringFrame => {
    const available = viewport()
    return {
      ...frame,
      width: Math.max(1, Math.min(frame.width, available.width)),
      height: Math.max(1, Math.min(frame.height, available.height)),
    }
  }
  const targetFrame = (): SpringFrame => clampToViewport(desiredFrame())

  // Only the clip-path moves per frame. The dashboard is laid out once at its final
  // size (see --island-open-* in shell.css) and the clip reveals it, so a spring frame
  // never triggers layout of the widgets.
  const publishClip = () => {
    const node = islandElement
    if (!node) return
    const frame = shapeFrame ?? targetFrame()
    const resting = Math.abs(magneticOffset.x) < 0.02 && Math.abs(magneticOffset.y) < 0.02
    const tilted = settings.placement.mode === 'notch' && !fileDrop() && !resting
    // Resting top notch: flared ears, fading out as the island grows taller.
    const ear = settings.placement.mode === 'notch' && settings.placement.edge === 'top' && !fileDrop()
      ? NOTCH_EAR * Math.max(0, Math.min(1, 1 - (frame.height - settings.collapsed.h) / 36))
      : 0
    if (ear > 0.5) {
      node.style.setProperty('--island-clip', earNotchPath(viewSize.width, frame.width, frame.height, ear, Math.min(frame.radius, NOTCH_RADIUS)))
      return
    }
    node.style.setProperty('--island-clip', tilted
      ? magneticNotchPath(viewSize.width, viewSize.height, frame.width, frame.height, settings.placement.edge, magneticOffset.x, magneticOffset.y, frame.radius)
      : edgeInsetClip(viewSize.width, viewSize.height, frame.width, frame.height, settings.placement.edge, frame.radius))
  }

  const publishShape = (frame: SpringFrame) => {
    shapeFrame = frame
    const node = islandElement
    if (!node) return
    node.style.setProperty('--island-spring-width', `${frame.width.toFixed(2)}px`)
    node.style.setProperty('--island-spring-height', `${frame.height.toFixed(2)}px`)
    node.style.setProperty('--island-spring-radius', `${frame.radius.toFixed(2)}px`)
    publishClip()
  }

  const publishMagnet = (offset: { x: number; y: number }) => {
    magneticOffset = offset
    // Only the collapsed pill uses the offset, so scope the variable to it instead of
    // invalidating styles for the whole dashboard on every cursor move.
    collapsedElement?.style.setProperty('--magnet-x', `${offset.x.toFixed(2)}px`)
    collapsedElement?.style.setProperty('--magnet-y', `${offset.y.toFixed(2)}px`)
    publishClip()
  }

  // Layout inputs that change on a retarget, not per frame.
  let publishedLayout = ''
  const publishLayout = (target: SpringFrame) => {
    const node = islandElement
    if (!node) return
    const dash = clampToViewport(expandedFrame())
    const pill = clampToViewport(collapsedFrame())
    const key = [target.width, target.height, dash.width, dash.height, pill.width].map(value => Math.round(value * 2) / 2).join('|')
    if (key === publishedLayout) return
    publishedLayout = key
    node.style.setProperty('--island-target-width', `${target.width.toFixed(1)}px`)
    node.style.setProperty('--island-target-height', `${target.height.toFixed(1)}px`)
    node.style.setProperty('--island-open-width', `${dash.width.toFixed(1)}px`)
    node.style.setProperty('--island-open-height', `${dash.height.toFixed(1)}px`)
    collapsedElement?.style.setProperty('--pill-w', `${pill.width.toFixed(1)}px`)
  }

  createEffect(() => {
    // Read all target inputs here so a new event or user gesture retargets the
    // existing spring rather than starting a second animation from stale CSS.
    const frame = targetFrame()
    if (open() || closing()) setProximity(0)
    publishLayout(frame)
    publishClip()
    const spring = shapeSpring
    if (spring) spring.retarget(frame)
    if (expanded() || closing() || fileDrop() || fileDropBoundsActive) {
      fileDropBoundsActive = !!fileDrop()
      void cmd.setInteractionBounds(frame.width, frame.height)
        .catch(error => reportError('Could not update interaction area', error))
    }
    if (magneticSpring && (open() || closing() || fileDrop() || settings.placement.mode !== 'notch' || reduceMotion)) {
      magneticSpring.retarget({ x: 0, y: 0 })
    }
  })

  // Appearance edits made in the Settings window apply to the open island straight away.
  // The spring runs on animation frames, which a webview pauses while it is occluded or
  // hidden (the Settings window can sit over the notch), so a retarget alone can stay
  // stale until the next open. Snap and republish synchronously in that case, and again
  // when the island becomes visible.
  let appearanceSeen: string | undefined
  const refreshAppearance = (snap: boolean) => {
    applyTemplate(settings.theme)
    applyAccent(settings.accent)
    publishedLayout = ''
    const frame = targetFrame()
    publishLayout(frame)
    if (snap) shapeSpring?.snap(frame)
    else shapeSpring?.retarget(frame)
    publishClip()
  }
  createEffect(() => {
    const key = appearanceKey(settings)
    if (appearanceSeen === undefined) { appearanceSeen = key; return }
    if (key === appearanceSeen) return
    appearanceSeen = key
    refreshAppearance(document.visibilityState !== 'visible' || reduceMotion)
  })
  onMount(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') refreshAppearance(true) }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    onCleanup(() => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible) })
  })

  let previouslyExpanded = expanded()
  createEffect(() => {
    const next = expanded()
    if (previouslyExpanded && !next && !reduceMotion && settings.placement.mode === 'notch') {
      magneticSpring?.impulse(sideEdge() ? { x: 0, y: 4 } : { x: 4, y: 0 })
    }
    previouslyExpanded = next
  })

  onMount(() => {
    let heldPointer: number | undefined
    const isControl = (target: EventTarget | null) => target instanceof Element && !!target.closest('.island input, .island textarea, .island select, .island [role="slider"], .island button, .island [contenteditable="true"]')
    const controlDown = (event: PointerEvent) => {
      if (!isControl(event.target) || heldPointer !== undefined) return
      noteSurfaceInteraction()
      if (!(event.target instanceof Element) || !event.target.closest('input[type="range"], [role="slider"]')) return
      heldPointer = event.pointerId
      try { event.target.setPointerCapture(event.pointerId) } catch { /* A platform control may already own capture. */ }
      beginSurfaceInteraction()
    }
    const controlUp = (event: PointerEvent) => {
      if (heldPointer !== event.pointerId) return
      heldPointer = undefined
      endSurfaceInteraction()
    }
    const controlInput = (event: Event) => { if (isControl(event.target)) noteSurfaceInteraction() }
    const controlMove = (event: PointerEvent) => {
      // Chromium may suppress pointerup if native readback disables a slider.
      // The next pointer sample still reports that its button was released.
      if (event.pointerId === heldPointer && event.buttons === 0) controlUp(event)
    }
    const releaseInteraction = () => {
      if (heldPointer === undefined) return
      heldPointer = undefined
      endSurfaceInteraction()
    }
    document.addEventListener('pointerdown', controlDown, true)
    document.addEventListener('pointerup', controlUp, true)
    document.addEventListener('pointercancel', controlUp, true)
    document.addEventListener('pointermove', controlMove, true)
    document.addEventListener('input', controlInput, true)
    document.addEventListener('keydown', controlInput, true)
    window.addEventListener('blur', releaseInteraction)
    const updateViewport = () => {
      viewSize.width = islandElement?.clientWidth ?? window.innerWidth
      viewSize.height = islandElement?.clientHeight ?? window.innerHeight
      setViewport({ width: viewSize.width, height: viewSize.height })
    }
    const viewportObserver = new ResizeObserver(updateViewport)
    viewportObserver.observe(islandElement ?? document.documentElement)
    updateViewport()
    window.addEventListener('resize', updateViewport)
    motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
    reduceMotion = motionPreference.matches
    const collapsed = { width: settings.collapsed.w, height: settings.collapsed.h, radius: NOTCH_RADIUS }
    shapeSpring = createIslandSpring(collapsed, publishShape, () => reduceMotion, active => islandElement?.classList.toggle('island--moving', active))
    shapeSpring.snap(targetFrame())
    magneticSpring = createMagneticSpring(publishMagnet, () => reduceMotion)
    publishMagnet({ x: 0, y: 0 })
    void listen<{ x: number; y: number; approach?: number }>('island://proximity', event => {
      const active = !reduceMotion && settings.interaction.hoverOpen && settings.placement.mode === 'notch' && !open() && !closing() && !fileHoverBlocked()
      setProximity(active ? Math.max(0, Math.min(1, event.payload.approach ?? Math.hypot(event.payload.x, event.payload.y) / 6)) : 0)
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
          // The transparent native host is much larger than its visible notch.
          // A shell drag entering that empty area must not reveal a chooser.
          if (!current && !dragNearSurface(cssPoint.x, cssPoint.y)) return
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
          finishFileInteraction()
          const revision = ++dropRevision
          const position = payload.position
          const paths = payload.paths ?? current?.paths ?? []
          const cssPoint = physicalDragPositionToCss(position, window.devicePixelRatio)
          const target = fileDropActionAtRelease(targetAt(cssPoint.x, cssPoint.y), paths)
          if (target === 'recycle' && paths.length) {
            setFileDrop({ paths, count: paths.length, target, phase: 'pending', message: 'Moving to Recycle Bin…' })
            void cmd.recycleDroppedPaths(paths).then((result) => {
              dropFeedback(revision, { paths, count: paths.length, target, phase: result.cancelled ? 'cancelled' : result.failed ? 'error' : 'complete', message: result.cancelled
                ? 'Cancelled'
                : result.failed
                  ? `${result.recycled} recycled · ${result.failed} failed`
                  : `${result.recycled} moved to Recycle Bin` })
            }).catch((error) => {
              dropFeedback(revision, { paths, count: paths.length, target, phase: 'error', message: 'Could not recycle files' }, 2000)
              reportError('Could not move dropped items to the Recycle Bin', error)
            })
          } else if (target === 'beam' && paths.length) {
            setFileDrop({ paths, count: paths.length, target, phase: 'pending', message: 'Adding to Beam bucket…' })
            void cmd.transferStageDroppedPaths(paths).then(async () => {
              await refreshTransfer()
              dropFeedback(revision, { paths, count: paths.length, target, phase: 'complete', message: 'Added to Beam bucket' })
            }).catch((error) => {
              dropFeedback(revision, { paths, count: paths.length, target, phase: 'error', message: 'Could not add to Beam bucket' }, 2000)
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
      document.removeEventListener('pointerdown', controlDown, true)
      document.removeEventListener('pointerup', controlUp, true)
      document.removeEventListener('pointercancel', controlUp, true)
      document.removeEventListener('pointermove', controlMove, true)
      document.removeEventListener('input', controlInput, true)
      document.removeEventListener('keydown', controlInput, true)
      window.removeEventListener('blur', releaseInteraction)
      releaseInteraction()
      finishFileInteraction()
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
    if (!fileDrop() && !dragNearSurface(event.clientX, event.clientY)) return
    setFileDrop(updateFileDropPreview(fileDrop(), { type: 'over', count: event.dataTransfer?.files.length }, targetAt(event.clientX, event.clientY)))
  }
  const handleFileDragLeave = (event: DragEvent) => {
    if (!browserPreview || !fileDragActive || !hasFileDrag(event)) return
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
    finishFileInteraction()
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
    revealUnlisten?.()
    clearTimeout(enterTimer)
    clearTimeout(leaveTimer)
    clearTimeout(dropFeedbackTimer)
  })

  // Ambient scenes drift a little with the cursor. The offset is scoped to the ambient
  // layer and coalesced to one write per frame; the default (plain) scene skips it.
  let pointerFrame = 0
  let pointerPoint = { x: 0, y: 0 }
  const trackPointer = (event: PointerEvent) => {
    if (!open() || settings.background === 'plain') return
    pointerPoint = { x: event.clientX, y: event.clientY }
    if (pointerFrame) return
    pointerFrame = requestAnimationFrame(() => {
      pointerFrame = 0
      const node = islandElement
      const ambient = node?.querySelector<HTMLElement>('.ambient')
      if (!node || !ambient) return
      const rect = node.getBoundingClientRect()
      ambient.style.setProperty('--pointer-x', `${((pointerPoint.x - rect.left) / rect.width - .5) * 30}px`)
      ambient.style.setProperty('--pointer-y', `${((pointerPoint.y - rect.top) / rect.height - .5) * 20}px`)
    })
  }
  onCleanup(() => cancelAnimationFrame(pointerFrame))

  return (
    <div
      class="island-stage"
      classList={{ 'island-stage--veiled': veiled() }}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
      onPointerEnter={(event) => {
        if (browserPreview && event.pointerType !== 'touch') enter()
      }}
      onPointerLeave={() => { if (browserPreview) leave() }}
      onPointerOver={event => {
        if (open()) return
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
      <div ref={islandElement} class="island" onPointerMove={trackPointer} classList={{ 'island--open': open(), 'island--hover': hovering(), 'island--peek': compactPeek(), 'island--live-activity': compactPeek(), 'island--device-peek': devicePeek(), 'island--transfer-peek': transferPeek(), 'island--auth-peek':authPeek(), 'island--file-drop': !!fileDrop(), 'island--notch-side': sideNotch(), [`island--edge-${settings.placement.edge}`]: true, [`island--mode-${settings.placement.mode}`]: true }}>
        <AmbientBackground/>
        <div ref={collapsedElement} class="island__collapsed" inert={open() || !!fileDrop() || compactPeek()} aria-hidden={open() || !!fileDrop() || compactPeek()}>
            <div
              class="island__bar"
              role="group"
              aria-label="Hover Island compact view. Activate to open; media controls are available inside."
              title="Open Hover Island"
              tabIndex={0}
              onClick={event => {
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
          phase={drop().phase}
          progress={drop().target==='beam' && drop().phase==='pending' && peek()?.phase==='staging' ? peek()?.progress : null}
          edge={settings.placement.edge}
          mode={settings.placement.mode}
        />}</Show>
      </div>
    </div>
  )
}
