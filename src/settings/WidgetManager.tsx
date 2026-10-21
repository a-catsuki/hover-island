import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { ArrowDown, ArrowUp, Minus, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-solid'
import type { WidgetConfig, WidgetKind } from '../lib/ipc'
import { settings, patchSettings } from '../state/settings'
import { WIDGETS, WIDGET_KINDS } from '../components/widgets/registry'
import { moveWidgetBefore, moveWidgetWithin } from './widgetOrder'
import {
  createPanelLayout,
  defaultPanelForKind,
  removePanelLayout,
  panelDisplayName,
  setPanelName,
  PANEL_NAME_MAX,
  widgetPanel,
  MAX_PANEL_COUNT,
  type PanelId,
} from '../lib/panels'
import { widgetPages, widgetResolvedSize } from '../lib/widgetPages'
import { clearWidgetSlot, firstFreeCell, fitShapeAt, placeWidgetAtCell, swapWidgetCells } from '../lib/widgetPlacement'
import { SHAPE_SPAN, defaultWidgetShape, widgetShapeLocked, widgetShapeOptions } from '../lib/widgetShapes'
import Dropdown from '../components/widgets/Dropdown'
import './WidgetManager.css'

type WidgetSize = NonNullable<WidgetConfig['size']>
const SPAN = SHAPE_SPAN
const SHAPE_LABEL: Record<WidgetSize, string> = { compact: 'Compact', wide: 'Wide', tall: 'Tall', full: 'Large' }

/** A 2x2 mini grid with the cells a shape covers filled in. */
function ShapeGlyph(props: { shape: WidgetSize }) {
  const cell = 9
  const gap = 2
  const span = () => SPAN[props.shape]
  return (
    <svg class="wmp__glyph" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <For each={[[0, 0], [1, 0], [0, 1], [1, 1]]}>{([x, y]) => <rect x={x * (cell + gap)} y={y * (cell + gap)} width={cell} height={cell} rx="2.4" fill="currentColor" opacity="0.22" />}</For>
      <rect x="0" y="0" width={span()[0] * cell + (span()[0] - 1) * gap} height={span()[1] * cell + (span()[1] - 1) * gap} rx="2.8" fill="currentColor" />
    </svg>
  )
}
const resolvedSize = widgetResolvedSize

export default function WidgetManager() {
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  const [selectedPanel, setSelectedPanel] = createSignal<PanelId>(settings.panelOrder[0] ?? 'today')
  const [announce, setAnnounce] = createSignal('')
  const [draggingId, setDraggingId] = createSignal<string | null>(null)
  // An empty cell the user clicked before choosing a widget; the next widget added lands there.
  const [pendingCell, setPendingCell] = createSignal<{ panel: PanelId; row: number; column: number } | null>(null)
  const [dropTarget, setDropTarget] = createSignal<{ panel: PanelId; widgetId?: string; row?: number; column?: number } | null>(null)
  let pointerDrag: { pointerId: number; pointerType: string; widgetId: string; x: number; y: number; started: boolean } | null = null
  let suppressClickId: string | null = null
  const ordered = () => [...settings.widgets].sort((a, b) => a.order - b.order)
  const visibleWidgets = () => ordered().filter((widget) => widget.kind !== 'airdrop')
  const commit = (list: WidgetConfig[]) => {
    const passive = settings.widgets.filter((widget) => widget.kind === 'airdrop')
    const enabledKinds = new Set(list.filter(widget => widget.enabled).map(widget => widget.kind))
    patchSettings({ widgets: [...list, ...passive].map((widget, order) => ({ ...widget, order })), modules: {
      ...settings.modules,
      ...(enabledKinds.has('media') ? { media: true } : {}),
      ...(enabledKinds.has('ai') || enabledKinds.has('usage') ? { usage: true } : {}),
      ...(enabledKinds.has('dock') ? { dock: true } : {}),
      ...(enabledKinds.has('notifications') ? { notifications: true } : {}),
    } })
  }
  const pageWidgets = (panel: PanelId) => visibleWidgets().filter((widget) => widgetPanel(widget, settings.panelOrder) === panel)
  // Widgets saved before shapes existed have no size, and a page made only of those is drawn
  // stretched to full height, which left no free cell to drop anything into. The editor treats
  // them as the compact tiles they are labelled as, and saving a placement pins that size.
  const sized = (widget: WidgetConfig): WidgetConfig => widget.size == null ? { ...widget, size: resolvedSize(widget) } : widget
  const pinSizes = (list: WidgetConfig[], panel: PanelId) => list.map((widget) => widgetPanel(widget, settings.panelOrder) === panel ? sized(widget) : widget)
  const enabled = (panel: PanelId) => pageWidgets(panel).filter((widget) => widget.enabled).map(sized)
  // Pages pack in order, so a widget placed into a free cell of the first page must sit right
  // after that page's tiles; otherwise a larger tile further down claims the page first and
  // the placed one spills onto an extra page.
  const afterFirstPage = (list: WidgetConfig[], panel: PanelId, id: string) => {
    const firstIds = new Set(slotsFor(panel).map((slot) => slot.widget.id).filter((other) => other !== id))
    const moving = list.find((widget) => widget.id === id)
    if (!moving) return list
    const rest = list.filter((widget) => widget.id !== id)
    let at = -1
    rest.forEach((widget, index) => { if (firstIds.has(widget.id)) at = index })
    rest.splice(at + 1, 0, moving)
    return rest
  }
  const slotsFor = (panel: PanelId) => widgetPages(enabled(panel), 2)[0] ?? []
  const freeCellsFor = (panel: PanelId, dragging: string | null) => {
    const occupied = new Set<string>()
    for (const slot of slotsFor(panel)) {
      if (slot.widget.id === dragging) continue
      for (let row = slot.row; row < slot.row + slot.rows; row++) {
        for (let column = slot.column; column < slot.column + slot.columns; column++) occupied.add(`${row}:${column}`)
      }
    }
    return [[1, 1], [1, 2], [2, 1], [2, 2]].filter(([row, column]) => !occupied.has(`${row}:${column}`)) as [number, number][]
  }
  const selected = createMemo(() => visibleWidgets().find((widget) => widget.id === selectedId()) ?? null)
  const available = createMemo(() => WIDGET_KINDS.filter((kind) => !visibleWidgets().some((widget) => widget.kind === kind)))

  const choose = (widget: WidgetConfig) => { setSelectedId(widget.id); setSelectedPanel(widgetPanel(widget, settings.panelOrder)) }
  const updateWidget = (id: string, update: Partial<WidgetConfig>) =>
    commit(ordered().map((widget) => widget.id === id ? { ...widget, ...update } : widget))
  const toggle = (widget: WidgetConfig) => updateWidget(widget.id, { enabled: !widget.enabled })
  const remove = (widget: WidgetConfig) => {
    commit(visibleWidgets().filter((item) => item.id !== widget.id))
    if (selectedId() === widget.id) setSelectedId(null)
    setAnnounce(`${WIDGETS[widget.kind]?.label ?? widget.kind} removed`)
  }
  const add = (kind: WidgetKind) => {
    const label = WIDGETS[kind]?.label ?? kind
    const pending = pendingCell()
    setPendingCell(null)
    // New widgets go on the page you are looking at, in the first space they fit,
    // instead of a fixed home page where they could spill onto an extra page.
    const panel = pending?.panel ?? selectedPanel()
    const members = enabled(panel)
    const preferred = defaultWidgetShape(kind)
    const cells: { row: number; column: number }[] = pending ? [pending] : freeCellsFor(panel, null).map(([row, column]) => ({ row, column }))
    let fit: ReturnType<typeof fitShapeAt> = null
    for (const cell of cells) { fit = fitShapeAt(members, kind, preferred, cell); if (fit) break }
    const widget: WidgetConfig = {
      id: crypto.randomUUID(), kind, enabled: true, order: visibleWidgets().length,
      panel,
      size: fit?.size ?? preferred,
      ...(fit ? { slot: fit.cell } : {}),
      ...(kind === 'media' ? { showLyrics: false } : {}),
    }
    commit(fit ? afterFirstPage([...pinSizes(visibleWidgets(), panel), widget], panel, widget.id) : [...pinSizes(visibleWidgets(), panel), widget])
    setSelectedId(widget.id)
    setSelectedPanel(panel)
    setAnnounce(fit ? `${label} added to ${pageName(panel)}` : `${label} needs more room than ${pageName(panel)} has, so it went on a new page`)
  }
  const move = (widget: WidgetConfig, delta: number) => {
    const panel = widgetPanel(widget, settings.panelOrder)
    const list = moveWidgetWithin(ordered(), widget.id, delta, (a, b) => widgetPanel(a, settings.panelOrder) === widgetPanel(b, settings.panelOrder))
    commit(list)
    const position = pageWidgets(panel).findIndex((item) => item.id === widget.id) + 1
    setAnnounce(`${WIDGETS[widget.kind]?.label ?? widget.kind} moved to position ${position}`)
  }
  const clearDrag = () => { pointerDrag = null; setDraggingId(null); setDropTarget(null) }
  const placeWidget = (sourceId: string, panel: PanelId, cell: { row: number; column: number }, targetId?: string) => {
    const source = ordered().find((widget) => widget.id === sourceId)
    if (!source) return
    const samePage = widgetPanel(source, settings.panelOrder) === panel
    const dropping = targetId && targetId !== sourceId && samePage ? targetId : undefined
    let next: WidgetConfig[]
    if (dropping) {
      const swapped = swapWidgetCells(pageWidgets(panel), sourceId, dropping)
      const swappedById = swapped && new Map(swapped.map((widget) => [widget.id, widget]))
      next = swappedById
        ? ordered().map((widget) => swappedById.get(widget.id) ?? widget).sort((a, b) => a.order - b.order)
        : clearWidgetSlot(moveWidgetBefore(ordered(), sourceId, dropping), sourceId)
    } else {
      // Fit the widget into the space that is actually free there, shrinking it if it supports a
      // smaller shape. Placing a hidden widget on a cell is also an instruction to show it.
      const others = enabled(panel).filter((widget) => widget.id !== sourceId)
      const fit = fitShapeAt(others, source.kind, resolvedSize(source), cell)
      if (!fit) {
        setAnnounce(`${WIDGETS[source.kind]?.label ?? source.kind} needs more room than that. Free up space or use a page with room.`)
        return
      }
      next = placeWidgetAtCell(pinSizes(ordered(), panel).map((widget) => widget.id === sourceId ? { ...widget, size: fit.size } : widget), sourceId, panel, fit.cell)
        .map((widget) => widget.id === sourceId ? { ...widget, enabled: true } : widget)
      next = afterFirstPage(next, panel, sourceId)
    }
    commit(next)
    setSelectedId(sourceId)
    setSelectedPanel(panel)
    const label = WIDGETS[source.kind]?.label ?? source.kind
    const target = dropping ? ordered().find((widget) => widget.id === dropping) : undefined
    setAnnounce(samePage
      ? target
        ? `${label} dropped on ${WIDGETS[target.kind]?.label ?? target.kind}`
        : `${label} placed at row ${cell.row}, column ${cell.column}`
      : `${label} moved to ${pageName(panel)}`)
  }
  const trackMove = (clientX: number, clientY: number) => {
    if (!pointerDrag) return
    if (!pointerDrag.started && Math.hypot(clientX - pointerDrag.x, clientY - pointerDrag.y) < 6) return
    if (!pointerDrag.started) {
      pointerDrag.started = true
      document.querySelector<HTMLElement>('.wmp')?.setPointerCapture(pointerDrag.pointerId)
      setDraggingId(pointerDrag.widgetId)
      setAnnounce('Move over an empty cell to pin the widget there, or onto another tile to drop on it.')
    }
    const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-drop-page], [data-drop-panel][data-drop-row][data-drop-column], [data-widget-id]')
    if (!target) { setAnnounce('Move over a highlighted tile or empty cell to place.'); return }
    if (target.dataset.dropPage) {
      const panel = target.dataset.dropPage
      const members = enabled(panel).filter((widget) => widget.id !== pointerDrag?.widgetId)
      const cell = firstFreeCell(members)
      setDropTarget({ panel, row: cell.row, column: cell.column })
      setAnnounce(`Release to move into ${pageName(panel)}, row ${cell.row}, column ${cell.column}.`)
    } else if (target.dataset.widgetId && target.dataset.widgetId !== pointerDrag.widgetId) {
      const panel = target.closest<HTMLElement>('[data-panel-id]')?.dataset.panelId
      if (panel) { setDropTarget({ panel, widgetId: target.dataset.widgetId }); setAnnounce(`Release to drop on ${WIDGETS[visibleWidgets().find(item => item.id === target.dataset.widgetId)?.kind ?? 'notes']?.label ?? 'widget'}.`) }
    } else if (target.dataset.dropPanel) {
      setDropTarget({ panel: target.dataset.dropPanel, row: Number(target.dataset.dropRow), column: Number(target.dataset.dropColumn) })
      setAnnounce(`Release to place in row ${target.dataset.dropRow}, column ${target.dataset.dropColumn}.`)
    }
  }
  const pointerMove = (event: PointerEvent) => {
    if (pointerDrag?.pointerId === event.pointerId) trackMove(event.clientX, event.clientY)
  }
  const mouseMove = (event: MouseEvent) => {
    if (pointerDrag?.pointerType === 'mouse') trackMove(event.clientX, event.clientY)
  }
  const finishDrag = (pointerId: number) => {
    if (!pointerDrag || pointerId !== pointerDrag.pointerId) return
    const drag = pointerDrag
    const target = dropTarget()
    if (drag.started) {
      suppressClickId = drag.widgetId
      window.setTimeout(() => { if (suppressClickId === drag.widgetId) suppressClickId = null }, 0)
    }
    if (drag.started && target) placeWidget(drag.widgetId, target.panel, { row: target.row ?? 1, column: target.column ?? 1 }, target.widgetId)
    clearDrag()
  }
  const pointerUp = (event: PointerEvent) => finishDrag(event.pointerId)
  const mouseUp = () => { if (pointerDrag?.pointerType === 'mouse') finishDrag(pointerDrag.pointerId) }
  const pointerCancel = (event: PointerEvent) => { if (pointerDrag?.pointerType !== 'mouse' && pointerDrag?.pointerId === event.pointerId) clearDrag() }
  onMount(() => {
    window.addEventListener('pointermove', pointerMove, true)
    window.addEventListener('pointerup', pointerUp, true)
    window.addEventListener('pointercancel', pointerCancel, true)
    window.addEventListener('mousemove', mouseMove, true)
    window.addEventListener('mouseup', mouseUp, true)
    onCleanup(() => {
      window.removeEventListener('pointermove', pointerMove, true)
      window.removeEventListener('pointerup', pointerUp, true)
      window.removeEventListener('pointercancel', pointerCancel, true)
      window.removeEventListener('mousemove', mouseMove, true)
      window.removeEventListener('mouseup', mouseUp, true)
    })
  })
  const setSize = (widget: WidgetConfig, size: WidgetSize) => {
    if (!widgetShapeOptions(widget.kind, resolvedSize(widget)).some(option => option.id === size)) return
    const [spanX, spanY] = SPAN[size]
    const keepsCell = !widget.slot || (widget.slot.row + spanY - 1 <= 2 && widget.slot.column + spanX - 1 <= 2)
    updateWidget(widget.id, keepsCell ? { size } : { size, slot: undefined })
    setAnnounce(`${WIDGETS[widget.kind]?.label ?? widget.kind} size set to ${size}`)
  }
  const createPage = () => {
    if (settings.panelOrder.length >= MAX_PANEL_COUNT) return
    const layout = createPanelLayout({ panels: settings.panels, panelOrder: settings.panelOrder, widgets: settings.widgets })
    patchSettings(layout)
    const newPanel = layout.panelOrder.at(-1)
    if (newPanel) { setSelectedPanel(newPanel); setAnnounce(`${layout.panels[newPanel]} page added`) }
  }
  const deletePage = (panel: PanelId) => {
    const title = settings.panels[panel]
    const next = removePanelLayout({ panels: settings.panels, panelOrder: settings.panelOrder, widgets: settings.widgets }, panel)
    patchSettings(next)
    setSelectedId(null)
    setSelectedPanel(next.panelOrder[0] ?? 'today')
    setAnnounce(`${title} page removed; its widgets were moved to another page`)
  }
  const pageName = (panel: PanelId) => panelDisplayName(panel, settings.panels, settings.panelNames)
  const [renamingPage, setRenamingPage] = createSignal<PanelId | null>(null)
  const savePageName = (panel: PanelId, value: string) => {
    patchSettings({ panelNames: setPanelName(settings.panelNames, settings.panels, panel, value) })
    setRenamingPage(null)
    setAnnounce(`Page renamed to ${panelDisplayName(panel, settings.panels, setPanelName(settings.panelNames, settings.panels, panel, value))}`)
  }
  const resetPageName = (panel: PanelId) => {
    patchSettings({ panelNames: setPanelName(settings.panelNames, settings.panels, panel, '') })
    setRenamingPage(null)
    setAnnounce(`${settings.panels[panel]} name restored`)
  }
  const focusPage = (panel: PanelId) => setSelectedPanel(panel)

  const focusTray = () => document.querySelector<HTMLElement>('.wmp__chips button')?.focus()
  const labelOf = (widget: WidgetConfig) => WIDGETS[widget.kind]?.label ?? widget.kind

  return (
    <div class="wmp">
      <div class="wmp__top">
        <div class="wmp__page-jumps" role="tablist" aria-label="Widget pages">
          <For each={settings.panelOrder}>{(panel, pageIndex) => <button type="button" role="tab" data-drop-page={panel} aria-selected={selectedPanel() === panel} class="wmp__page-jump" classList={{ 'wmp__page-jump--active': selectedPanel() === panel, 'wmp__page-jump--drop': !!draggingId() && dropTarget()?.panel === panel && panel !== selectedPanel() }} onClick={() => focusPage(panel)}><span class="wmp__page-num">{pageIndex() + 1}</span>{pageName(panel)}</button>}</For>
        </div>
        <button type="button" class="wmp__add-page" disabled={settings.panelOrder.length >= MAX_PANEL_COUNT} onClick={createPage}><Plus size={13} strokeWidth={2.2} /> New page</button>
      </div>
      <div class="wmp__pages" role="list" aria-label="Selected widget page">
        <span id="wmp-drag-hint" class="wmp__sr-only">Drag this widget onto an empty cell to pin it there, onto another tile to swap with it, or onto a page tab to move it to that page. Use the Order arrows for keyboard reordering.</span>
        <For each={settings.panelOrder.filter(panel => panel === selectedPanel())}>{(panel) => {
          const widgets = () => pageWidgets(panel)
          const slots = () => slotsFor(panel)
          return (
            <section class="wmp__page" data-panel-id={panel} role="listitem" aria-label={`${pageName(panel)} page preview`}>
              <div class="wmp__phone">
                <div class="wmp__notch" aria-hidden="true"><i /><i /><i /></div>
                <div class="wmp__screen-head">
                  <Show when={renamingPage() === panel} fallback={<span class="wmp__title"><strong title={pageName(panel)}>{pageName(panel)}</strong>
                    <button class="wmp__icon-button" type="button" aria-label={`Rename ${pageName(panel)} page`} title="Rename page" onClick={() => setRenamingPage(panel)}><Pencil size={12} /></button>
                    <Show when={settings.panelNames?.[panel]}><button class="wmp__reset" type="button" title={`Restore "${settings.panels[panel]}"`} onClick={() => resetPageName(panel)}><RotateCcw size={11} /> Reset</button></Show></span>}>
                    <input class="wmp__title-input" aria-label={`Page ${settings.panelOrder.indexOf(panel) + 1} name`} maxlength={PANEL_NAME_MAX} value={pageName(panel)} placeholder={settings.panels[panel]}
                      ref={node => queueMicrotask(() => { node.focus(); node.select() })}
                      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); savePageName(panel, event.currentTarget.value) } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRenamingPage(null) } }}
                      onBlur={(event) => { if (renamingPage() === panel) savePageName(panel, event.currentTarget.value) }} />
                    <button class="wmp__reset" type="button" title={`Restore "${settings.panels[panel]}"`} onMouseDown={(event) => event.preventDefault()} onClick={() => resetPageName(panel)}><RotateCcw size={11} /> Reset</button>
                  </Show>
                  <span>{enabled(panel).length} {enabled(panel).length === 1 ? 'widget' : 'widgets'}</span>
                  <button class="wmp__icon-button" type="button" aria-label={`Delete ${pageName(panel)} page`} title="Delete page" disabled={settings.panelOrder.length <= 1} onClick={() => deletePage(panel)}><Trash2 size={13} /></button>
                </div>
                <div
                  class="wmp__grid"
                  classList={{ 'wmp__grid--drop-target': dropTarget()?.panel === panel, 'wmp__grid--dragging': !!draggingId() }}
                  role="group"
                  aria-label={`${pageName(panel)} widgets`}
                >
                  <For each={freeCellsFor(panel, draggingId())}>{([row, column]) => <button type="button"
                    class="wmp__empty-cell" data-drop-panel={panel} data-drop-row={row} data-drop-column={column}
                    classList={{ 'wmp__empty-cell--active': (dropTarget()?.panel === panel && dropTarget()?.row === row && dropTarget()?.column === column) || (pendingCell()?.panel === panel && pendingCell()?.row === row && pendingCell()?.column === column) }}
                    aria-label={`Place selected widget in row ${row}, column ${column}`}
                    onClick={() => { const id = selectedId(); if (id) placeWidget(id, panel, { row, column }); else { setPendingCell({ panel, row, column }); setAnnounce('Pick a widget below to put it here.'); focusTray() } }}
                    style={{ 'grid-column': `${column}`, 'grid-row': `${row}` }}>
                    <span class="wmp__plus" aria-hidden="true"><Plus size={14} strokeWidth={2.4} /></span>
                    <span class="wmp__empty-text">{draggingId() ? 'Drop here' : selectedId() ? 'Place here' : pendingCell()?.panel === panel && pendingCell()?.row === row && pendingCell()?.column === column ? 'Pick below' : 'Add widget'}</span>
                  </button>}</For>
                  <Show when={slots().length > 0} fallback={<div class="wmp__empty">Add a widget to this page</div>}>
                    <For each={slots()}>{(slot) => {
                      const widget = slot.widget
                      const def = WIDGETS[widget.kind]
                      return <div class="wmp__cell" style={{ 'grid-column': `${slot.column} / span ${slot.columns}`, 'grid-row': `${slot.row} / span ${slot.rows}` }}>
                        <button
                          type="button"
                          class="wmp__tile"
                          data-widget-id={widget.id}
                          classList={{ 'wmp__tile--selected': selectedId() === widget.id, 'wmp__tile--full': slot.rows > 1, 'wmp__tile--tall': slot.rows > 1 && slot.columns === 1, 'wmp__tile--wide': slot.columns > 1, 'wmp__tile--off': !widget.enabled, 'wmp__tile--dragging': draggingId() === widget.id, 'wmp__tile--drop-target': dropTarget()?.widgetId === widget.id }}
                          aria-pressed={selectedId() === widget.id}
                          aria-label={`${def?.label ?? widget.kind}, ${SHAPE_LABEL[resolvedSize(widget)]} shape, position ${widgets().findIndex((item) => item.id === widget.id) + 1} of ${widgets().length}`}
                          aria-describedby="wmp-drag-hint"
                          onClick={() => { if (suppressClickId === widget.id) { suppressClickId = null; return }; choose(widget) }}
                          onPointerDown={(event) => { if (!widget.enabled || event.button !== 0) return; pointerDrag = { pointerId: event.pointerId, pointerType: event.pointerType, widgetId: widget.id, x: event.clientX, y: event.clientY, started: false } }}
                          onKeyDown={(event) => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); move(widget, event.key === 'ArrowUp' ? -1 : 1) } }}
                        >
                          <span class="wmp__tile-icon">{def?.icon()}</span>
                          <strong>{def?.label ?? widget.kind}</strong>
                          <small>{SHAPE_LABEL[resolvedSize(widget)]}</small>
                        </button>
                        <button type="button" class="wmp__badge wmp__badge--minus" aria-label={`Hide ${labelOf(widget)}`} title="Hide widget" onClick={() => { updateWidget(widget.id, { enabled: false }); if (selectedId() === widget.id) setSelectedId(null); setAnnounce(`${labelOf(widget)} hidden`) }}><Minus size={11} strokeWidth={3} /></button>
                      </div>
                    }}</For>
                  </Show>
                </div>
                <Show when={widgets().some((widget) => !widget.enabled)}>
                  <div class="wmp__hidden"><span>Hidden</span><For each={widgets().filter((widget) => !widget.enabled)}>{(widget) => <button type="button" onClick={() => choose(widget)}>{labelOf(widget)}</button>}</For></div>
                </Show>
              </div>
            </section>
          )
        }}</For>
      </div>

      <Show when={selected()} fallback={<p class="wmp__hint">Select a tile to change its size or page. Drag tiles to rearrange them.</p>}>
        {(widget) => {
          const def = () => WIDGETS[widget().kind]
          const page = () => widgetPanel(widget(), settings.panelOrder)
          const local = () => pageWidgets(page())
          const index = () => local().findIndex((item) => item.id === widget().id)
          return <section class="wmp__inspector set-card" aria-label={`${def()?.label ?? widget().kind} settings`}>
            <div class="set-row wmp__inspect-head"><span class="wmp__inspect-icon">{def()?.icon()}</span><span class="set-row__text"><strong>{def()?.label ?? widget().kind}</strong><small>{pageName(page())}</small></span><button type="button" class="set-switch" classList={{ 'set-switch--on': widget().enabled }} role="switch" aria-checked={widget().enabled} aria-label={`${widget().enabled ? 'Hide' : 'Show'} ${def()?.label ?? widget().kind}`} onClick={() => toggle(widget())}><span /></button></div>
            <div class="set-row wmp__shape-row"><span class="set-row__text"><strong>Shape</strong><small>{widgetShapeLocked(widget().kind) ? 'This widget needs the whole page to stay readable.' : 'Pick the layout that suits it best'}</small></span>
              <div class="wmp__shapes" role="radiogroup" aria-label={`${def()?.label ?? widget().kind} shape`}>
                <For each={widgetShapeOptions(widget().kind, resolvedSize(widget()))}>{(option) => <button type="button" role="radio" aria-checked={resolvedSize(widget()) === option.id} classList={{ 'wmp__shape--on': resolvedSize(widget()) === option.id }} disabled={widgetShapeLocked(widget().kind)} title={option.detail} onClick={() => setSize(widget(), option.id)}><ShapeGlyph shape={option.id} /><span>{option.label}</span></button>}</For>
              </div></div>
            <div class="set-row"><span class="set-row__text"><strong>Page</strong></span><Dropdown ariaLabel={`Page for ${def()?.label ?? widget().kind}`} align="end" value={page()} options={settings.panelOrder.map((panel) => ({ value: panel, label: pageName(panel) }))} onChange={(panel) => { updateWidget(widget().id, { panel }); setSelectedPanel(panel) }} /></div>
            <div class="set-row"><span class="set-row__text"><strong>Order</strong><small>Alt with the arrow keys works on a tile too</small></span><div class="wmp__reorder"><button type="button" aria-label={`Move ${def()?.label ?? widget().kind} earlier`} disabled={index() <= 0} onClick={() => move(widget(), -1)}><ArrowUp size={13} /></button><button type="button" aria-label={`Move ${def()?.label ?? widget().kind} later`} disabled={index() >= local().length - 1} onClick={() => move(widget(), 1)}><ArrowDown size={13} /></button></div></div>
            <Show when={widget().kind === 'clock'}><div class="set-row"><span class="set-row__text"><strong>Clock face</strong></span><div class="set-seg" role="radiogroup" aria-label="Clock face" style={{ '--n': 2, '--i': (widget().clockStyle ?? 'analog') === 'analog' ? 0 : 1 }}><span class="set-seg__thumb" aria-hidden="true" /><For each={[['analog', 'Analog'], ['digital', 'Digital']] as const}>{([id, label]) => <button type="button" role="radio" aria-checked={(widget().clockStyle ?? 'analog') === id} classList={{ 'set-seg__item--on': (widget().clockStyle ?? 'analog') === id }} onClick={() => updateWidget(widget().id, { clockStyle: id })}>{label}</button>}</For></div></div></Show>
            <Show when={widget().kind === 'media'}><label class="set-row wmp__media-option" title={resolvedSize(widget()) === 'compact' ? 'Choose Wide or Full size to enable lyrics.' : undefined}><span class="set-row__text"><strong>Show lyrics</strong><small>{resolvedSize(widget()) === 'compact' ? 'Choose Wide or Full to show lyrics.' : 'Synced lyrics when available.'}</small></span><input type="checkbox" checked={widget().showLyrics ?? false} disabled={resolvedSize(widget()) === 'compact'} onChange={(event) => updateWidget(widget().id, { showLyrics: event.currentTarget.checked })} /></label></Show>
            <div class="set-row"><span class="set-row__text"><strong>Remove widget</strong><small>You can add it back below</small></span><button type="button" class="button button--danger wmp__remove" onClick={() => remove(widget())}>Remove</button></div>
          </section>
        }}
      </Show>

      <Show when={available().length > 0}><div class="wmp__add wmp__tray"><span class="wmp__add-label">Add widgets</span><div class="wmp__chips"><For each={available()}>{(kind) => <button type="button" class="wmp__chip" onClick={() => add(kind)}><span class="wmp__chip-plus" aria-hidden="true"><Plus size={10} strokeWidth={3.2} /></span>{WIDGETS[kind].label}</button>}</For></div></div></Show>
      <div class="wmp__live" aria-live="polite">{announce()}</div>
    </div>
  )
}
