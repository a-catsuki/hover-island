import { createEffect, createMemo, createSignal, For, Show, onCleanup, onMount } from 'solid-js'
import { Portal } from 'solid-js/web'
import { Moon, Pin, PinOff, Search, Settings as SettingsIcon, X, GripVertical, Check, LayoutGrid, ArrowUp, ArrowDown, FolderUp, SlidersHorizontal, Ellipsis } from 'lucide-solid'
import { browserPreview, cmd } from '../../lib/ipc'
import { settings, patchSettings, savingSettings, flushSettings } from '../../state/settings'
import { collapseIsland, expanded, open, pinned, setPinned } from '../../state/ui'
import { openSpotlight } from '../../state/spotlight'
import { feedback, dismissFeedback, reportError } from '../../state/feedback'
import { acknowledgePendingAlert, dismissPeek } from '../../state/peek'
import { WIDGETS } from '../widgets/registry'
import { customizePanelLayout, reorderPanel, widgetPanel, type PanelId } from '../../lib/panels'
import { crossedWidgetDragThreshold } from '../../lib/widgetPointerDrag'
import { firstFreeCell, reflowWidgetDrop, widgetCanResize, type GridCell } from '../../lib/widgetPlacement'
import { activePanel, setActivePanel, showFileBucket, showControls, widgetRequest, detailRequest } from '../../state/panel'
import { widgetPages, widgetResolvedSize, type WidgetResolvedSize } from '../../lib/widgetPages'
import FirstRunTour from './FirstRunTour'
import { onboardingOpen } from '../../state/onboarding'

export default function ExpandedPanel() {
  const panel = activePanel, setPanel = setActivePanel
  createEffect(() => { const id=panel(); queueMicrotask(() => document.getElementById('panel-tab-'+id)?.scrollIntoView({block:'nearest',inline:'nearest'})) })
  let grid: HTMLDivElement | undefined
  let tabs: HTMLElement | undefined
  let body: HTMLElement | undefined
  const [columns, setColumns] = createSignal(2)
  onMount(() => {
    const observer = new ResizeObserver(entries => setColumns(entries[0].contentRect.width < 540 ? 1 : 2))
    if (body) observer.observe(body)
    onCleanup(() => observer.disconnect())
  })
  // Platters animate in on mount (see .island--open .widget in shell.css), so a page
  // switch gets the same staggered entrance as opening the island.
  const [arranging, setArranging] = createSignal(false)
  const [previewPanelOrder, setPreviewPanelOrder] = createSignal<string[] | null>(null)
  const [thumb, setThumb] = createSignal<{ x: number; w: number } | null>(null)
  const placeThumb = () => {
    const selected = tabs?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    if (!selected) return setThumb(null)
    setThumb({ x: selected.offsetLeft, w: selected.offsetWidth })
  }
  createEffect(() => { panel(); previewPanelOrder(); settings.panelOrder.length; settings.panels; arranging(); queueMicrotask(placeThumb); requestAnimationFrame(placeThumb) })
  onMount(() => {
    const observer = new ResizeObserver(placeThumb)
    if (tabs) observer.observe(tabs)
    void document.fonts?.ready.then(placeThumb)
    onCleanup(() => observer.disconnect())
  })
  // A failure banner never survives a collapse — it is dismissed with the panel.
  createEffect(() => { if (!open()) dismissFeedback() })
  const [moreOpen, setMoreOpen] = createSignal(false)
  let moreRoot: HTMLDivElement | undefined
  let moreMenu: HTMLDivElement | undefined
  let moreTrigger: HTMLButtonElement | undefined
  const [dragged, setDragged] = createSignal<string | null>(null)
  const [over, setOver] = createSignal<string | null>(null)
  const [dropCell, setDropCell] = createSignal<GridCell | null>(null)
  const [dragPoint, setDragPoint] = createSignal<{ x: number; y: number } | null>(null)
  const [localPage, setLocalPage] = createSignal(0)
  const [draggedPanel, setDraggedPanel] = createSignal<string | null>(null)
  const [panningTabs, setPanningTabs] = createSignal(false)
  const [announcement, setAnnouncement] = createSignal('')
  const navOrder = () => previewPanelOrder() ?? settings.panelOrder
  type DropTarget = { panel: PanelId; cell: GridCell; widgetId?: string }
  let pointerDrag: { pointerId: number; sourceId: string; start: { x: number; y: number }; element: HTMLElement; started: boolean } | undefined
  let tabDrag: { pointerId: number; start: { x: number; y: number }; scrollLeft: number; sourceId: string | null; pressedId: string | null; started: boolean } | undefined
  let suppressTabClickUntil = 0
  let edgeScrollFrame = 0
  let edgePoint: { x: number; y: number } | undefined
  const all = createMemo(() => [...settings.widgets].filter(widget => widget.enabled && widget.kind !== 'airdrop').sort((a,b) => a.order-b.order))
  const panelWidgets = createMemo(() => all().filter(widget => widgetPanel(widget, settings.panelOrder) === panel()))
  const membersOf = (id: PanelId) => [...settings.widgets]
    .filter(widget => widget.enabled && widget.kind !== 'airdrop' && widgetPanel(widget, settings.panelOrder) === id)
    .sort((a, b) => a.order - b.order)
  const responsivePages = createMemo(() => widgetPages(panelWidgets(), columns()))
  createEffect(() => { panel(); columns(); setLocalPage(0) })
  createEffect(() => { if (localPage() >= responsivePages().length) setLocalPage(Math.max(0, responsivePages().length - 1)) })
  const slotsForPanel = createMemo(() => responsivePages()[localPage()] ?? [])
  const slots = slotsForPanel
  const visible = () => slots().map(slot => slot.widget)
  const draggedLabel = () => { const widget = settings.widgets.find(widget => widget.id === dragged()); return widget ? WIDGETS[widget.kind].label : 'Widget' }
  const visualPanelWidgets = () => responsivePages().flatMap(page => [...page].sort((a, b) => a.row - b.row || a.column - b.column).map(slot => slot.widget))
  const dropFootprint = () => {
    const source = settings.widgets.find(widget => widget.id === dragged())
    const target = settings.widgets.find(widget => widget.id === over())
    const rank = ['compact', 'wide', 'full']
    const sourceSize = source ? widgetResolvedSize(source) : 'compact'
    const targetSize = target ? widgetResolvedSize(target) : sourceSize
    const size = source && widgetCanResize(source) && rank.indexOf(targetSize) < rank.indexOf(sourceSize) ? targetSize : sourceSize
    return { columns: size === 'compact' ? 1 : columns(), rows: size === 'full' ? 2 : 1 }
  }
  const revealWidget = (id: string) => queueMicrotask(() => {
    const page = responsivePages().findIndex(slots => slots.some(slot => slot.widget.id === id))
    if (page >= 0) setLocalPage(page)
  })
  let seenWidgetRequest=0, seenDetailRequest=0
  createEffect(() => {
    const order = settings.panelOrder
    if (!order.length) return
    if (!order.includes(panel())) setPanel(order[0])
  })
  createEffect(() => {
    const request = widgetRequest()
    if (!request || request.revision===seenWidgetRequest) return
    const widget = settings.widgets.find(item => item.id === request.id && item.enabled && item.kind !== 'airdrop')
    if (widget) {
      seenWidgetRequest = request.revision
      const targetPanel = widgetPanel(widget, settings.panelOrder)
      if (targetPanel !== panel()) setPanel(targetPanel)
      revealWidget(widget.id)
    }
  })
  createEffect(() => {
    const request = detailRequest()
    if (!request || request.revision === seenDetailRequest) return
    const widget = all().find(item => item.kind === request.kind)
    if (!widget) return
    seenDetailRequest = request.revision
    setPanel(widgetPanel(widget, settings.panelOrder))
    revealWidget(widget.id)
  })
  const commit = (widgets: typeof settings.widgets, targetPanel = panel(), order = [...settings.panelOrder]) => {
    const promoted = customizePanelLayout({ panels: { ...settings.panels }, panelOrder: order, widgets })
    patchSettings(promoted.layout)
    setPanel(promoted.ids.get(targetPanel) ?? targetPanel)
  }
  const move = (id: string, direction: number) => {
    const ids = visualPanelWidgets().map(widget => widget.id)
    const index = ids.indexOf(id)
    const target = ids[index+direction]
    if (!target) return
    const ordered = [...settings.widgets].sort((a,b) => a.order-b.order)
    const from = ordered.findIndex(widget => widget.id === id), to = ordered.findIndex(widget => widget.id === target)
    ;[ordered[from],ordered[to]] = [ordered[to],ordered[from]]
    // The keyboard alternative uses the same adaptive placement as a drop.
    const targetSlot = slots().find(slot => slot.widget.id === target)
    if (targetSlot) settleDrop(id, panel(), target, { row: targetSlot.row, column: targetSlot.column })
    else commit(ordered.map((widget, order) => ({...widget,order,slot:widget.panel===panel()?undefined:widget.slot})))
  }
  const settleDrop = (sourceId: string, targetPanel: PanelId, targetId?: string, cell?: GridCell, requestedSize?: WidgetResolvedSize) => {
    const source = settings.widgets.find(widget => widget.id === sourceId)
    if (!source) return
    const target = settings.widgets.find(widget => widget.id === targetId)
    const sizeOrder = ['compact', 'wide', 'full']
    const targetSize = target && target.id !== sourceId && sizeOrder.indexOf(widgetResolvedSize(target)) < sizeOrder.indexOf(widgetResolvedSize(source))
      ? widgetResolvedSize(target) : undefined
    const destination = cell ?? firstFreeCell(membersOf(targetPanel).filter(widget => widget.id !== sourceId))
    const title = settings.panels[targetPanel] ?? 'panel'
    commit(reflowWidgetDrop([...settings.widgets], sourceId, targetPanel, destination, requestedSize ?? targetSize), targetPanel)
    revealWidget(sourceId)
    setAnnouncement(`${WIDGETS[source.kind].label} moved to ${title}. Widgets fitted automatically.`)
  }
  // HTML5 drag remains a browser-preview compatibility path only. Native
  // desktop builds use pointer capture because Tauri owns OS file dragging.
  const previewDrop = (event: DragEvent, target?: string, targetPanel = panel()) => {
    if (!browserPreview) return
    event.preventDefault()
    event.stopPropagation()
    const id = event.dataTransfer?.getData('text/plain') || dragged()
    if (!arranging() || !id || !settings.widgets.some(widget => widget.id === id)) return
    const location = pointerTargetAt(event.clientX, event.clientY, id)
    settleDrop(id, targetPanel, target, location?.panel === targetPanel ? location.cell : undefined)
    setDragged(null); setOver(null); setDropCell(null)
  }
  const pointerTargetAt = (x: number, y: number, sourceId: string): DropTarget | null => {
    const element = document.elementFromPoint(x, y)
    const widget = element?.closest<HTMLElement>('[data-widget-id]')
    const tab = element?.closest<HTMLElement>('[data-panel-id]')
    if (tab?.dataset.panelId) return { panel: tab.dataset.panelId, cell: firstFreeCell(membersOf(tab.dataset.panelId).filter(item => item.id !== sourceId)) }
    const rect = grid?.getBoundingClientRect()
    if (!rect || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null
    return { panel: panel(), widgetId: widget?.dataset.widgetId,
      cell: { row: Math.min(2, Math.floor((y - rect.top) / (rect.height / 2)) + 1), column: Math.min(columns(), Math.floor((x - rect.left) / (rect.width / columns())) + 1) } }
  }
  const clearPointerDrag = (session = pointerDrag, releaseCapture = true) => {
    if (!session) return
    if (pointerDrag === session) pointerDrag = undefined
    setDragged(null)
    setOver(null)
    setDropCell(null)
    setDragPoint(null)
    stopEdgeScroll()
    if (releaseCapture && session.element.hasPointerCapture(session.pointerId)) {
      try { session.element.releasePointerCapture(session.pointerId) } catch { /* The element may already have unmounted. */ }
    }
  }
  const beginWidgetPointerDrag = (event: PointerEvent, sourceId: string) => {
    if (!arranging() || event.button !== 0 || !event.isPrimary) return
    const target = event.target
    if (target instanceof Element && target.closest('button,a,input,textarea,select,[data-no-drag]')) return
    event.stopPropagation()
    if (pointerDrag) clearPointerDrag(pointerDrag)
    const element = event.currentTarget as HTMLElement
    const session = { pointerId: event.pointerId, sourceId, start: { x: event.clientX, y: event.clientY }, element, started: false }
    try { element.setPointerCapture(event.pointerId) } catch { return }
    pointerDrag = session
  }
  const moveWidgetPointerDrag = (event: PointerEvent) => {
    const session = pointerDrag
    if (!arranging() || !session || session.pointerId !== event.pointerId) return
    if (!session.started) {
      if (!crossedWidgetDragThreshold(session.start, { x: event.clientX, y: event.clientY })) return
      session.started = true
      setDragged(session.sourceId)
    }
    event.preventDefault()
    const target = pointerTargetAt(event.clientX, event.clientY, session.sourceId)
    setOver(target?.widgetId ?? (target?.panel !== panel() ? target?.panel ?? null : null))
    setDropCell(target?.panel === panel() ? target.cell : null)
    setDragPoint({ x: event.clientX, y: event.clientY })
    updateEdgeScroll(event.clientX, event.clientY)
  }
  const finishWidgetPointerDrag = (event: PointerEvent) => {
    const session = pointerDrag
    if (!session || session.pointerId !== event.pointerId) return
    const target = session.started ? pointerTargetAt(event.clientX, event.clientY, session.sourceId) : null
    clearPointerDrag(session)
    if (!target || !arranging() || !settings.widgets.some(widget => widget.id === session.sourceId)) return
    settleDrop(session.sourceId, target.panel, target.widgetId, target.cell)
  }
  const cancelWidgetPointerDrag = (event: PointerEvent) => {
    if (pointerDrag?.pointerId === event.pointerId) clearPointerDrag(pointerDrag)
  }
  createEffect(() => { if (!arranging() && pointerDrag) clearPointerDrag(pointerDrag) })
  const stopEdgeScroll = () => { cancelAnimationFrame(edgeScrollFrame); edgeScrollFrame = 0; edgePoint = undefined }
  const updatePanelReorder = (x: number) => {
    if (!tabDrag?.sourceId || !tabs) return
    const target = [...tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => {
      const rect = button.getBoundingClientRect()
      return x >= rect.left && x <= rect.right
    })
    const targetId = target?.dataset.panelId
    if (!target || !targetId || targetId === tabDrag.sourceId) return
    const rect = target.getBoundingClientRect()
    setPreviewPanelOrder(order => reorderPanel(order ?? [...settings.panelOrder], tabDrag!.sourceId!, targetId, x > rect.left + rect.width / 2))
  }
  const updateEdgeScroll = (x: number, y: number) => {
    edgePoint = { x, y }
    if (edgeScrollFrame || !tabs) return
    const tick = () => {
      edgeScrollFrame = 0
      const rect = tabs?.getBoundingClientRect()
      if (!rect || !edgePoint || (!pointerDrag?.started && !tabDrag?.started)) return
      if (edgePoint.y >= rect.top - 12 && edgePoint.y <= rect.bottom + 12) {
        const edge = Math.min(44, rect.width / 4)
        const speed = edgePoint.x < rect.left + edge ? -Math.min(12, (rect.left + edge - edgePoint.x) / 4)
          : edgePoint.x > rect.right - edge ? Math.min(12, (edgePoint.x - rect.right + edge) / 4) : 0
        if (speed) {
          tabs!.scrollLeft += speed
          if (tabDrag?.sourceId) updatePanelReorder(edgePoint.x)
          else if (pointerDrag) {
            const target = pointerTargetAt(edgePoint.x, edgePoint.y, pointerDrag.sourceId)
            setOver(target?.panel !== panel() ? target?.panel ?? null : null)
          }
        }
      }
      edgeScrollFrame = requestAnimationFrame(tick)
    }
    edgeScrollFrame = requestAnimationFrame(tick)
  }
  const beginTabDrag = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary || !tabs || pointerDrag) return
    event.stopPropagation()
    const tab = (event.target as Element).closest<HTMLElement>('[data-panel-id]')
    tabDrag = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, scrollLeft: tabs.scrollLeft,
      sourceId: arranging() ? tab?.dataset.panelId ?? null : null, pressedId: tab?.dataset.panelId ?? null, started: false }
    try { tabs.setPointerCapture(event.pointerId) } catch { tabDrag = undefined }
  }
  const moveTabDrag = (event: PointerEvent) => {
    const session = tabDrag
    if (!session || event.pointerId !== session.pointerId || !tabs) return
    if (!session.started && !crossedWidgetDragThreshold(session.start, { x: event.clientX, y: event.clientY })) return
    session.started = true
    event.preventDefault()
    if (session.sourceId) {
      setDraggedPanel(session.sourceId)
      updatePanelReorder(event.clientX)
      updateEdgeScroll(event.clientX, event.clientY)
    } else {
      setPanningTabs(true)
      tabs.scrollLeft = session.scrollLeft - (event.clientX - session.start.x)
    }
  }
  const finishTabDrag = (event: PointerEvent, cancelled = false) => {
    const session = tabDrag
    if (!session || event.pointerId !== session.pointerId) return
    const nextOrder = previewPanelOrder()
    tabDrag = undefined
    if (!cancelled && !session.started && session.pressedId) setPanel(session.pressedId)
    if (session.started) suppressTabClickUntil = performance.now() + 250
    if (!cancelled && session.started && session.sourceId && nextOrder) {
      const title = settings.panels[session.sourceId]
      commit([...settings.widgets], panel(), nextOrder)
      setAnnouncement(`${title} panel moved. ${nextOrder.indexOf(session.sourceId) + 1} of ${nextOrder.length}.`)
    }
    setPreviewPanelOrder(null); setDraggedPanel(null); setPanningTabs(false); stopEdgeScroll()
    if (tabs?.hasPointerCapture(event.pointerId)) tabs.releasePointerCapture(event.pointerId)
  }
  const onTabsKeyDown = (event: KeyboardEvent) => {
    const order = [...settings.panelOrder], index = order.indexOf(panel())
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (event.altKey && event.shiftKey && direction) {
      const target = order[index + direction]
      if (!target) return
      event.preventDefault(); event.stopPropagation()
      commit([...settings.widgets], panel(), reorderPanel(order, panel(), target, direction > 0))
      setAnnouncement(`${settings.panels[panel()]} panel moved.`)
      queueMicrotask(() => document.getElementById('panel-tab-' + panel())?.focus())
      return
    }
    const next = direction ? (index + direction + order.length) % order.length : event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 : -1
    if (next < 0) return
    event.preventDefault(); setPanel(order[next]); document.getElementById('panel-tab-' + order[next])?.focus()
  }
  const cancelCapturedDrags = () => {
    if (pointerDrag) clearPointerDrag(pointerDrag)
    if (tabDrag) finishTabDrag(new PointerEvent('pointercancel', { pointerId: tabDrag.pointerId }), true)
  }
  createEffect(() => { if (!open()) { cancelCapturedDrags(); closeMore() } })
  onMount(() => {
    window.addEventListener('blur', cancelCapturedDrags)
    onCleanup(() => window.removeEventListener('blur', cancelCapturedDrags))
  })
  onCleanup(() => { if (pointerDrag) clearPointerDrag(pointerDrag); stopEdgeScroll() })
  const toggleDnd = () => {
    const enabled = !settings.dnd
    if (enabled) {
      dismissPeek()
      acknowledgePendingAlert()
    }
    patchSettings({dnd:enabled})
  }
  const openSettings = () => void cmd.openSettingsWindow().catch(error => reportError('Could not open settings',error))
  const closeMore = (restoreFocus = false) => {
    setMoreOpen(false)
    if (restoreFocus) moreTrigger?.focus()
  }
  const runMoreAction = (action: () => void) => {
    closeMore(true)
    action()
  }
  onMount(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (moreOpen() && !moreRoot?.contains(event.target as Node)) closeMore()
    }
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (!moreOpen() || event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeMore(true)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onDocumentKeyDown)
    onCleanup(() => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onDocumentKeyDown)
    })
  })
  const onMoreKeyDown = (event: KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...(moreMenu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemcheckbox"]') ?? [])]
    if (!items.length) return
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (index + 1) % items.length
      : (index <= 0 ? items.length - 1 : index - 1)
    event.preventDefault()
    items[next].focus()
  }
  return <div class="island__panel">
    <button type="button" class="panel__grabber" aria-label="Collapse island" title="Collapse (Esc)" onClick={() => { void flushSettings().catch(() => {}); collapseIsland() }}/>
    <FirstRunTour/>
    <header class="panel__head" inert={onboardingOpen()}>
      <div class="panel-navigation" data-no-drag>
        <nav ref={tabs} class="panel-tabs" classList={{ 'panel-tabs--panning': panningTabs(), 'panel-tabs--reordering': !!draggedPanel() }} role="tablist" aria-label="Panels" title={arranging() ? 'Drag a panel to reorder. Alt + Shift + arrow keys also reorder.' : 'Drag to browse panels. Use Arrange widgets to reorder.'}
          onPointerDown={beginTabDrag} onPointerMove={moveTabDrag} onPointerUp={event => finishTabDrag(event)} onPointerCancel={event => finishTabDrag(event, true)} onLostPointerCapture={event => finishTabDrag(event, true)}
          onKeyDown={onTabsKeyDown}
          onWheel={event => { if (tabs && tabs.scrollWidth > tabs.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX) && !event.ctrlKey) { event.preventDefault(); tabs.scrollLeft += event.deltaY } }}>
          <span class="panel-tabs__thumb" classList={{ 'panel-tabs__thumb--ready': !!thumb() }} aria-hidden="true" style={{ left: `${thumb()?.x ?? 0}px`, width: `${thumb()?.w ?? 0}px` }}/>
          <For each={navOrder()}>{id => <button type="button" role="tab" id={'panel-tab-' + id} data-panel-id={id} aria-controls="island-content" tabIndex={panel() === id ? 0 : -1} aria-selected={panel() === id} aria-label={settings.panels[id] + ' panel'} classList={{ selected: panel() === id, 'panel-tabs__drop': over() === id, 'panel-tabs__dragging': draggedPanel() === id }} onClick={event => { if (performance.now() < suppressTabClickUntil) { event.preventDefault(); event.stopPropagation(); return }; setPanel(id) }} onDragStart={event => event.preventDefault()} onDragOver={event => { if (browserPreview && arranging()) { event.preventDefault(); setOver(id); updateEdgeScroll(event.clientX, event.clientY) } }} onDragLeave={() => { if (browserPreview) setOver(null) }} onDrop={event => previewDrop(event, undefined, id)}>
            <Show when={arranging()}><GripVertical class="panel-tabs__grip" size={11}/></Show><span class="panel-tabs__label">{settings.panels[id]}</span><Show when={arranging()}><small>{all().filter(widget => widgetPanel(widget, settings.panelOrder) === id).length}</small></Show>
          </button>}</For>
        </nav>
      </div>

      <div class="panel__tools">
        <button class="beam-button" type="button" aria-label="Open file beam" title="Beam files to your phone" onClick={showFileBucket}><FolderUp size={16}/><span>Beam</span></button>
        <button class="icon-button panel__quick-controls" type="button" aria-label="Open quick controls" title="Quick controls" onClick={showControls}><SlidersHorizontal size={16}/></button>
        <button class="search-button" onClick={openSpotlight} title={`Search anything (${settings.spotlightHotkey})`} aria-label={`Search ${settings.spotlightHotkey}`}><Search size={16}/><span>Search</span><kbd>{settings.spotlightHotkey}</kbd></button>
        <button class="icon-button" aria-label="Open settings" title="Settings" onClick={openSettings}><SettingsIcon size={16}/></button>
        <div class="panel-more" ref={moreRoot}>
          <button ref={moreTrigger} type="button" class="icon-button panel-more__trigger" aria-label="More actions" title="More actions" aria-haspopup="menu" aria-expanded={moreOpen()} aria-controls="panel-more-menu" onClick={() => {
            const opening = !moreOpen()
            setMoreOpen(opening)
            if (opening) queueMicrotask(() => moreMenu?.querySelector<HTMLButtonElement>('[role="menuitem"], [role="menuitemcheckbox"]')?.focus())
          }}><Ellipsis size={17}/></button>
          <Show when={moreOpen()}>
            <div ref={moreMenu} id="panel-more-menu" class="panel-more__menu" role="menu" aria-label="More island actions" onKeyDown={onMoreKeyDown}>
              <button type="button" role="menuitem" class="files-shortcut" onClick={() => runMoreAction(showFileBucket)}><FolderUp size={15}/><span>File bucket</span></button>
              <button type="button" role="menuitemcheckbox" aria-checked={settings.dnd} onClick={() => runMoreAction(toggleDnd)}><Moon size={15} fill={settings.dnd?'currentColor':'none'}/><span>Do Not Disturb</span><small>{settings.dnd ? 'On' : 'Off'}</small></button>
              <button type="button" role="menuitemcheckbox" aria-checked={pinned()} onClick={() => runMoreAction(() => setPinned(!pinned()))}>{pinned() ? <PinOff size={15}/> : <Pin size={15}/>}<span>{pinned() ? 'Unpin island' : 'Keep island open'}</span><small>{pinned() ? 'On' : 'Off'}</small></button>
              <button type="button" role="menuitemcheckbox" aria-checked={arranging()} onClick={() => runMoreAction(() => setArranging(!arranging()))}>{arranging() ? <Check size={15}/> : <LayoutGrid size={15}/>}<span>{arranging() ? 'Finish arranging' : 'Arrange widgets'}</span><small>{arranging() ? 'On' : 'Off'}</small></button>
            </div>
          </Show>
        </div>
      </div>
    </header>
    <Show when={feedback()}><div class="feedback" role="alert"><span>{feedback()}</span><button class="icon-button" aria-label="Dismiss error" onClick={dismissFeedback}><X size={14}/></button></div></Show>
    <main ref={body} class="panel__body" id="island-content" role="tabpanel" aria-labelledby={'panel-tab-'+panel()} classList={{'panel__body--tutorial':onboardingOpen()}}>
      <Show when={arranging()}><p class="arrange-hint"><GripVertical size={13}/><span>Drop into a cell or onto a panel. Widgets fit around your drop. Drag panel tabs to reorder.</span></p></Show>
      <div ref={grid} class={'widget-grid widget-grid--' + panel()} style={{'--grid-columns':columns()}} classList={{ 'widget-grid--arranging': arranging(), 'widget-grid--dropping': !!dragged() }} inert={onboardingOpen()}
        onDragOver={event => { if (browserPreview && arranging() && dragged()) { event.preventDefault(); const target = pointerTargetAt(event.clientX, event.clientY, dragged()!); setDropCell(target?.cell ?? null) } }} onDrop={event => previewDrop(event)}>
        <For each={visible()}>{widget => {
          const slot = () => slots().find(item => item.widget.id === widget.id) ?? {column:1,row:1,columns:1,rows:1}
          const panelIndex = () => visualPanelWidgets().findIndex(item => item.id === widget.id)
          const def = WIDGETS[widget.kind]
          return <section style={{'grid-column':`${slot().column} / span ${slot().columns}`,'grid-row':`${slot().row} / span ${slot().rows}`}} class={'widget widget--' + widget.kind} classList={{ 'widget--dragging': dragged() === widget.id, 'widget--drop': over() === widget.id, 'widget--full':slot().rows===2 }} data-widget-kind={widget.kind} data-widget-id={widget.id} data-widget-size={widgetResolvedSize(widget)} aria-label={def.label + ' widget'} draggable={false} onDragStart={event => event.preventDefault()} onPointerDown={event => beginWidgetPointerDrag(event, widget.id)} onPointerMove={moveWidgetPointerDrag} onPointerUp={finishWidgetPointerDrag} onPointerCancel={cancelWidgetPointerDrag} onLostPointerCapture={cancelWidgetPointerDrag}>
            <Show when={arranging()}><div class="widget-arranger"><GripVertical size={14}/><span title={def.label}>{def.label}</span><select aria-label={def.label + ' widget size'} value={widgetResolvedSize(widget)} disabled={!widgetCanResize(widget)} onChange={event => settleDrop(widget.id, panel(), undefined, { row: slot().row, column: slot().column }, event.currentTarget.value as WidgetResolvedSize)}><option value="compact">Small</option><option value="wide">Wide</option><option value="full">Full</option></select><button class="icon-button" aria-label={'Move ' + def.label + ' earlier in panel'} disabled={panelIndex()===0} onClick={() => move(widget.id,-1)}><ArrowUp size={12}/></button><button class="icon-button" aria-label={'Move ' + def.label + ' later in panel'} disabled={panelIndex()===panelWidgets().length-1} onClick={() => move(widget.id,1)}><ArrowDown size={12}/></button></div></Show>
            <div class="widget-content" inert={arranging()}><Show when={expanded() || widget.kind === 'notes'}>{def.render({ ...widget, size: widgetResolvedSize(widget) })}</Show></div>
          </section>
        }}</For>
        <Show when={dragged() ? dropCell() : null}>{cell => <div class="widget-drop-cell" aria-hidden="true" style={{ 'grid-column': `${dropFootprint().columns > 1 ? 1 : cell().column} / span ${dropFootprint().columns}`, 'grid-row': `${dropFootprint().rows > 1 ? 1 : cell().row} / span ${dropFootprint().rows}` }}><span>Drop here · auto fit</span></div>}</Show>
        <Show when={!visible().length}><div class="panel-empty"><LayoutGrid size={24}/><strong>A space for your essentials.</strong><p>Add widgets or move them here from another panel.</p><button class="button" onClick={openSettings}>Choose widgets</button></div></Show>
      </div>
      <Show when={responsivePages().length > 1}><nav class="responsive-pager" aria-label="More widgets in this panel" data-no-drag><button type="button" class="icon-button" aria-label="Previous widgets" disabled={localPage() === 0} onClick={() => setLocalPage(page => page - 1)}><ArrowUp size={13} style={{transform:'rotate(-90deg)'}}/></button><span>{localPage() + 1} / {responsivePages().length}</span><button type="button" class="icon-button" aria-label="Next widgets" disabled={localPage() >= responsivePages().length - 1} onClick={() => setLocalPage(page => page + 1)}><ArrowDown size={13} style={{transform:'rotate(-90deg)'}}/></button></nav></Show>
    </main>
      <Show when={dragged() ? dragPoint() : null}>{point => <Portal><div class="widget-drag-label" aria-hidden="true" style={{ left: `${point().x + 14}px`, top: `${point().y + 14}px` }}><GripVertical size={13}/>{draggedLabel()}</div></Portal>}</Show>
      <span class="panel-announcement" role="status" aria-live="polite">{announcement()}</span>
      <footer class="panel__foot" classList={{'panel__foot--quiet':!savingSettings()&&!settings.dnd&&!arranging()&&!pinned()}}><span>{savingSettings() ? 'Saving…' : settings.dnd ? 'Do Not Disturb' : arranging() ? 'Arrange widgets' : pinned() ? 'Pinned open' : ''}</span></footer>
  </div>
}
