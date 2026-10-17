import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-solid'
import type { WidgetConfig, WidgetKind } from '../lib/ipc'
import { settings, patchSettings } from '../state/settings'
import { WIDGETS, WIDGET_KINDS } from '../components/widgets/registry'
import { moveWidgetBefore, moveWidgetWithin } from './widgetOrder'
import {
  createPanelLayout,
  defaultPanelForKind,
  removePanelLayout,
  renamePanelLayout,
  widgetPanel,
  MAX_PANEL_COUNT,
  type PanelId,
} from '../lib/panels'
import { widgetPages, widgetResolvedSize } from '../lib/widgetPages'
import { clearWidgetSlot, firstFreeCell, placeWidgetAtCell, swapWidgetCells } from '../lib/widgetPlacement'
import './WidgetManager.css'

type WidgetSize = NonNullable<WidgetConfig['size']>
const SIZES: { id: WidgetSize; label: string; detail: string }[] = [
  { id: 'compact', label: 'Compact', detail: 'One tile' },
  { id: 'wide', label: 'Wide', detail: 'Two columns' },
  { id: 'full', label: 'Full', detail: 'Tall tile' },
]
const MIN_FULL = new Set<WidgetKind>(['calendar', 'nearby', 'controls'])
const SPAN: Record<WidgetSize, [number, number]> = { compact: [1, 1], wide: [2, 1], full: [2, 2] }
const resolvedSize = widgetResolvedSize

export default function WidgetManager() {
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  const [selectedPanel, setSelectedPanel] = createSignal<PanelId>(settings.panelOrder[0] ?? 'today')
  const [announce, setAnnounce] = createSignal('')
  const [draggingId, setDraggingId] = createSignal<string | null>(null)
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
  const enabled = (panel: PanelId) => pageWidgets(panel).filter((widget) => widget.enabled)
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
    const widget: WidgetConfig = {
      id: crypto.randomUUID(), kind, enabled: true, order: visibleWidgets().length,
      panel: defaultPanelForKind(kind, settings.panelOrder),
      size: MIN_FULL.has(kind) || ['usage', 'web-alerts', 'clock'].includes(kind) ? 'full' : kind === 'dock' ? 'wide' : 'compact',
      ...(kind === 'media' ? { showLyrics: false } : {}),
    }
    commit([...visibleWidgets(), widget])
    setSelectedId(widget.id)
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
      next = placeWidgetAtCell(ordered(), sourceId, panel, cell)
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
      : `${label} moved to ${settings.panels[panel]}`)
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
      setAnnounce(`Release to move into ${settings.panels[panel]}, row ${cell.row}, column ${cell.column}.`)
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
    if (MIN_FULL.has(widget.kind) && size !== 'full') return
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
  const renamePage = (panel: PanelId, title: string) =>
    patchSettings(renamePanelLayout({ panels: settings.panels, panelOrder: settings.panelOrder, widgets: settings.widgets }, panel, title))
  const focusPage = (panel: PanelId) => setSelectedPanel(panel)

  return (
    <div class="wmp">
      <div class="wmp__page-jumps" role="tablist" aria-label="Widget pages">
        <For each={settings.panelOrder}>{(panel, pageIndex) => <button type="button" role="tab" data-drop-page={panel} aria-selected={selectedPanel() === panel} class="wmp__page-jump" classList={{ 'wmp__page-jump--active': selectedPanel() === panel, 'wmp__page-jump--drop': dropTarget()?.panel === panel }} onClick={() => focusPage(panel)}>{pageIndex() + 1}. {settings.panels[panel]}</button>}</For>
        <button type="button" class="wmp__add-page" disabled={settings.panelOrder.length >= MAX_PANEL_COUNT} onClick={createPage}><Plus size={15} /> Add page</button>
      </div>
      <div class="wmp__pages" role="list" aria-label="Selected widget page">
        <span id="wmp-drag-hint" class="wmp__sr-only">Drag this widget onto an empty cell to pin it there, onto another tile to drop on it, or onto a page shortcut to move it to that page. Use the Order arrows for keyboard reordering.</span>
        <For each={settings.panelOrder.filter(panel => panel === selectedPanel())}>{(panel, pageIndex) => {
          const widgets = () => pageWidgets(panel)
          const slots = () => slotsFor(panel)
          return (
            <section class="wmp__page" data-panel-id={panel} role="listitem" aria-label={`${settings.panels[panel]} page preview`}>
              <header class="wmp__page-head">
                <label class="wmp__page-name">
                  <span>Page {settings.panelOrder.indexOf(panel) + 1}</span>
                  <input aria-label={`Page ${settings.panelOrder.indexOf(panel) + 1} name`} maxlength={24} value={settings.panels[panel]} onInput={(event) => renamePage(panel, event.currentTarget.value)} />
                </label>
                <button class="wmp__icon-button" type="button" aria-label={`Delete ${settings.panels[panel]} page`} title="Delete page" disabled={settings.panelOrder.length <= 1} onClick={() => deletePage(panel)}><Trash2 size={14} /></button>
              </header>
              <div class="wmp__phone">
                <div class="wmp__notch" aria-hidden="true"><i /><i /><i /></div>
                <div class="wmp__screen-head"><span>{settings.panels[panel]}</span><span>{enabled(panel).length} widgets</span></div>
                <div
                  class="wmp__grid"
                  classList={{ 'wmp__grid--drop-target': dropTarget()?.panel === panel }}
                  role="group"
                  aria-label={`${settings.panels[panel]} widgets`}
                >
                  <For each={freeCellsFor(panel, draggingId())}>{([row, column]) => <button type="button"
                    class="wmp__empty-cell" data-drop-panel={panel} data-drop-row={row} data-drop-column={column}
                    classList={{ 'wmp__empty-cell--active': dropTarget()?.panel === panel && dropTarget()?.row === row && dropTarget()?.column === column }}
                    aria-label={`Place selected widget in row ${row}, column ${column}`} disabled={!selectedId()}
                    onClick={() => { const id = selectedId(); if (id) placeWidget(id, panel, { row, column }) }}
                    style={{ 'grid-column': `${column}`, 'grid-row': `${row}` }}>
                    <span>{slots().length ? 'Drop here' : 'Add a widget here'}</span>
                  </button>}</For>
                  <Show when={slots().length > 0} fallback={<div class="wmp__empty">Add a widget to this page</div>}>
                    <For each={slots()}>{(slot) => {
                      const widget = slot.widget
                      const def = WIDGETS[widget.kind]
                      return <button
                        type="button"
                        class="wmp__tile"
                        data-widget-id={widget.id}
                        classList={{ 'wmp__tile--selected': selectedId() === widget.id, 'wmp__tile--full': slot.rows > 1, 'wmp__tile--wide': slot.columns > 1, 'wmp__tile--off': !widget.enabled, 'wmp__tile--dragging': draggingId() === widget.id, 'wmp__tile--drop-target': dropTarget()?.widgetId === widget.id }}
                        style={{ 'grid-column': `${slot.column} / span ${slot.columns}`, 'grid-row': `${slot.row} / span ${slot.rows}` }}
                        aria-pressed={selectedId() === widget.id}
                        aria-label={`${def?.label ?? widget.kind}, ${resolvedSize(widget)} size, position ${widgets().findIndex((item) => item.id === widget.id) + 1} of ${widgets().length}`}
                        aria-describedby="wmp-drag-hint"
                        onClick={() => { if (suppressClickId === widget.id) { suppressClickId = null; return }; choose(widget) }}
                        onPointerDown={(event) => { if (!widget.enabled || event.button !== 0) return; pointerDrag = { pointerId: event.pointerId, pointerType: event.pointerType, widgetId: widget.id, x: event.clientX, y: event.clientY, started: false } }}
                        onKeyDown={(event) => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); move(widget, event.key === 'ArrowUp' ? -1 : 1) } }}
                      >
                        <span class="wmp__tile-icon">{def?.icon()}</span>
                        <strong>{def?.label ?? widget.kind}</strong>
                        <small>{resolvedSize(widget)}</small>
                      </button>
                    }}</For>
                  </Show>
                </div>
                <Show when={widgets().some((widget) => !widget.enabled)}>
                  <div class="wmp__hidden"><span>Hidden</span><For each={widgets().filter((widget) => !widget.enabled)}>{(widget) => <button type="button" onClick={() => choose(widget)}>{WIDGETS[widget.kind]?.label ?? widget.kind}</button>}</For></div>
                </Show>
              </div>
            </section>
          )
        }}</For>
      </div>

      <Show when={selected()} fallback={<p class="wmp__hint">Choose a tile to edit it. Reorder it with the arrows below.</p>}>
        {(widget) => {
          const def = () => WIDGETS[widget().kind]
          const page = () => widgetPanel(widget(), settings.panelOrder)
          const local = () => pageWidgets(page())
          const index = () => local().findIndex((item) => item.id === widget().id)
          return <section class="wmp__inspector" aria-label={`${def()?.label ?? widget().kind} settings`}>
            <header class="wmp__inspect-head"><span class="wmp__inspect-icon">{def()?.icon()}</span><div><strong>{def()?.label ?? widget().kind}</strong><small>{settings.panels[page()]}</small></div><button type="button" class="set-switch" classList={{ 'set-switch--on': widget().enabled }} role="switch" aria-checked={widget().enabled} aria-label={`${widget().enabled ? 'Hide' : 'Show'} ${def()?.label ?? widget().kind}`} onClick={() => toggle(widget())}><span /></button></header>
            <div class="wmp__edit-row"><span>Size</span><div class="wmp__size-options" role="group" aria-label={`${def()?.label ?? widget().kind} size`}>
              <For each={SIZES}>{(size) => <button type="button" aria-pressed={resolvedSize(widget()) === size.id} disabled={MIN_FULL.has(widget().kind) && size.id !== 'full'} title={MIN_FULL.has(widget().kind) && size.id !== 'full' ? 'This widget needs more room to stay readable.' : size.detail} onClick={() => setSize(widget(), size.id)}><strong>{size.label}</strong><small>{size.detail}</small></button>}</For>
            </div></div>
            <div class="wmp__edit-bottom"><label>Page<select aria-label={`Page for ${def()?.label ?? widget().kind}`} value={page()} onChange={(event) => { const panel = event.currentTarget.value; updateWidget(widget().id, { panel }); setSelectedPanel(panel) }}><For each={settings.panelOrder}>{(panel) => <option value={panel}>{settings.panels[panel]}</option>}</For></select></label>
              <div class="wmp__reorder"><span>Order</span><button type="button" aria-label={`Move ${def()?.label ?? widget().kind} earlier`} disabled={index() <= 0} onClick={() => move(widget(), -1)}><ArrowUp size={14} /></button><button type="button" aria-label={`Move ${def()?.label ?? widget().kind} later`} disabled={index() >= local().length - 1} onClick={() => move(widget(), 1)}><ArrowDown size={14} /></button></div>
              <button type="button" class="wmp__remove" onClick={() => remove(widget())}><Trash2 size={14} /> Remove</button>
            </div>
            <Show when={widget().kind === 'clock'}><div class="wmp__edit-row"><span>Clock face</span><div class="wmp__seg"><For each={[['analog', 'Analog'], ['digital', 'Digital']] as const}>{([id, label]) => <button type="button" aria-pressed={(widget().clockStyle ?? 'analog') === id} onClick={() => updateWidget(widget().id, { clockStyle: id })}>{label}</button>}</For></div></div></Show>
            <Show when={widget().kind === 'media'}><div class="wmp__media-option"><label title={resolvedSize(widget()) === 'compact' ? 'Choose Wide or Full size to enable lyrics.' : undefined}><input type="checkbox" checked={widget().showLyrics ?? false} disabled={resolvedSize(widget()) === 'compact'} onChange={(event) => updateWidget(widget().id, { showLyrics: event.currentTarget.checked })} /> Show lyrics</label><small>{resolvedSize(widget()) === 'compact' ? 'Choose Wide or Full to show lyrics.' : 'Show synchronized lyrics when available.'}</small></div></Show>
          </section>
        }}
      </Show>

      <Show when={available().length > 0}><div class="wmp__add"><span class="wmp__add-label">Add widget</span><div class="wmp__chips"><For each={available()}>{(kind) => <button type="button" class="wmp__chip" onClick={() => add(kind)}><Plus size={13} />{WIDGETS[kind].label}</button>}</For></div></div></Show>
      <div class="wmp__live" aria-live="polite">{announce()}</div>
    </div>
  )
}
