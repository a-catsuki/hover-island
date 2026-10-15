import { createMemo, createSignal, For, Show } from 'solid-js'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-solid'
import type { WidgetConfig, WidgetKind } from '../lib/ipc'
import { settings, patchSettings } from '../state/settings'
import { WIDGETS, WIDGET_KINDS } from '../components/widgets/registry'
import { moveWidgetAfter, moveWidgetWithin } from './widgetOrder'
import {
  createPanelLayout,
  defaultPanelForKind,
  removePanelLayout,
  renamePanelLayout,
  widgetPanel,
  MAX_PANEL_COUNT,
  type PanelId,
} from '../lib/panels'
import { widgetPages } from '../lib/widgetPages'
import './WidgetManager.css'

type WidgetSize = NonNullable<WidgetConfig['size']>
const SIZES: { id: WidgetSize; label: string; detail: string }[] = [
  { id: 'compact', label: 'Compact', detail: 'One tile' },
  { id: 'wide', label: 'Wide', detail: 'Two columns' },
  { id: 'full', label: 'Full', detail: 'Tall tile' },
]
const MIN_FULL = new Set<WidgetKind>(['calendar', 'nearby', 'controls'])
const resolvedSize = (widget: WidgetConfig): WidgetSize => widget.size ?? (
  MIN_FULL.has(widget.kind) || ['usage', 'web-alerts', 'clock'].includes(widget.kind)
    ? 'full'
    : widget.kind === 'dock' ? 'wide' : 'compact'
)

export default function WidgetManager() {
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  const [announce, setAnnounce] = createSignal('')
  const [draggingId, setDraggingId] = createSignal<string | null>(null)
  const [dropTarget, setDropTarget] = createSignal<{ panel: PanelId; widgetId: string | null } | null>(null)
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
  const selected = createMemo(() => visibleWidgets().find((widget) => widget.id === selectedId()) ?? null)
  const available = createMemo(() => WIDGET_KINDS.filter((kind) => !visibleWidgets().some((widget) => widget.kind === kind)))

  const choose = (widget: WidgetConfig) => setSelectedId(widget.id)
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
  const clearDrag = () => { setDraggingId(null); setDropTarget(null) }
  const dropWidget = (panel: PanelId, targetId: string | null) => {
    const sourceId = draggingId()
    if (!sourceId) return
    const source = ordered().find((widget) => widget.id === sourceId)
    if (!source) { clearDrag(); return }
    const samePage = widgetPanel(source, settings.panelOrder) === panel
    const pageMembers = pageWidgets(panel).filter((widget) => widget.id !== sourceId)
    const anchor = targetId && targetId !== sourceId ? targetId : pageMembers.at(-1)?.id ?? null
    const moved = ordered().map((widget) => widget.id === sourceId ? { ...widget, panel } : widget)
    const next = moveWidgetAfter(moved, sourceId, anchor)
    commit(next)
    setSelectedId(sourceId)
    const position = next.filter((widget) => widgetPanel(widget, settings.panelOrder) === panel).findIndex((widget) => widget.id === sourceId) + 1
    setAnnounce(`${WIDGETS[source.kind]?.label ?? source.kind} ${samePage ? 'reordered' : `moved to ${settings.panels[panel]}`} at position ${position}`)
    clearDrag()
  }
  const setSize = (widget: WidgetConfig, size: WidgetSize) => {
    if (MIN_FULL.has(widget.kind) && size !== 'full') return
    updateWidget(widget.id, { size })
    setAnnounce(`${WIDGETS[widget.kind]?.label ?? widget.kind} size set to ${size}`)
  }
  const createPage = () => {
    if (settings.panelOrder.length >= MAX_PANEL_COUNT) return
    const layout = createPanelLayout({ panels: settings.panels, panelOrder: settings.panelOrder, widgets: settings.widgets })
    patchSettings(layout)
    const newPanel = layout.panelOrder.at(-1)
    if (newPanel) setAnnounce(`${layout.panels[newPanel]} page added`)
  }
  const deletePage = (panel: PanelId) => {
    const title = settings.panels[panel]
    const next = removePanelLayout({ panels: settings.panels, panelOrder: settings.panelOrder, widgets: settings.widgets }, panel)
    patchSettings(next)
    setSelectedId(null)
    setAnnounce(`${title} page removed; its widgets were moved to another page`)
  }
  const renamePage = (panel: PanelId, title: string) =>
    patchSettings(renamePanelLayout({ panels: settings.panels, panelOrder: settings.panelOrder, widgets: settings.widgets }, panel, title))
  const focusPage = (panel: PanelId) => {
    document.querySelector<HTMLElement>(`.wmp__page[data-panel-id="${CSS.escape(panel)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }

  return (
    <div class="wmp">
      <div class="wmp__pages" role="list" aria-label="Widget pages">
        <span id="wmp-drag-hint" class="wmp__sr-only">Drag this widget onto another tile to place it after that tile, or onto a page shortcut to move it there. Use the Order arrows for keyboard reordering.</span>
        <For each={settings.panelOrder}>{(panel, pageIndex) => {
          const widgets = () => pageWidgets(panel)
          const slots = () => slotsFor(panel)
          return (
            <section class="wmp__page" data-panel-id={panel} role="listitem" aria-label={`${settings.panels[panel]} page preview`}>
              <header class="wmp__page-head">
                <label class="wmp__page-name">
                  <span>Page {pageIndex() + 1}</span>
                  <input aria-label={`Page ${pageIndex() + 1} name`} maxlength={24} value={settings.panels[panel]} onInput={(event) => renamePage(panel, event.currentTarget.value)} />
                </label>
                <button class="wmp__icon-button" type="button" aria-label={`Delete ${settings.panels[panel]} page`} title="Delete page" disabled={settings.panelOrder.length <= 1} onClick={() => deletePage(panel)}><Trash2 size={14} /></button>
              </header>
              <div class="wmp__phone">
                <div class="wmp__notch" aria-hidden="true"><i /><i /><i /></div>
                <div class="wmp__screen-head"><span>{settings.panels[panel]}</span><span>{enabled(panel).length} widgets</span></div>
                <div
                  class="wmp__grid"
                  classList={{ 'wmp__grid--drop-target': dropTarget()?.panel === panel && dropTarget()?.widgetId === null }}
                  role="group"
                  aria-label={`${settings.panels[panel]} widgets`}
                  onDragOver={(event) => { if (draggingId()) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; setDropTarget({ panel, widgetId: null }) } }}
                  onDrop={(event) => { event.preventDefault(); dropWidget(panel, null) }}
                >
                  <Show when={slots().length > 0} fallback={<div class="wmp__empty">Add a widget to this page</div>}>
                    <For each={slots()}>{(slot) => {
                      const widget = slot.widget
                      const def = WIDGETS[widget.kind]
                      return <button
                        type="button"
                        class="wmp__tile"
                        draggable={widget.enabled}
                        data-widget-id={widget.id}
                        classList={{ 'wmp__tile--selected': selectedId() === widget.id, 'wmp__tile--full': slot.rows > 1, 'wmp__tile--wide': slot.columns > 1, 'wmp__tile--off': !widget.enabled, 'wmp__tile--dragging': draggingId() === widget.id, 'wmp__tile--drop-target': dropTarget()?.widgetId === widget.id }}
                        style={{ 'grid-column': `${slot.column} / span ${slot.columns}`, 'grid-row': `${slot.row} / span ${slot.rows}` }}
                        aria-pressed={selectedId() === widget.id}
                        aria-label={`${def?.label ?? widget.kind}, ${resolvedSize(widget)} size, position ${widgets().findIndex((item) => item.id === widget.id) + 1} of ${widgets().length}`}
                        aria-describedby="wmp-drag-hint"
                        onClick={() => choose(widget)}
                        onDragStart={(event) => { if (!widget.enabled) { event.preventDefault(); return }; if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', widget.id) }; setDraggingId(widget.id) }}
                        onDragOver={(event) => { if (draggingId() && draggingId() !== widget.id) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; setDropTarget({ panel, widgetId: widget.id }) } }}
                        onDrop={(event) => { event.preventDefault(); event.stopPropagation(); dropWidget(panel, widget.id) }}
                        onDragEnd={clearDrag}
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

      <div class="wmp__page-jumps" role="group" aria-label="Widget page drop targets">
        <For each={settings.panelOrder}>{(panel) => <button
          type="button"
          class="wmp__page-jump"
          classList={{ 'wmp__page-jump--drop': dropTarget()?.panel === panel && dropTarget()?.widgetId === null }}
          aria-label={`${settings.panels[panel]} page drop target`}
          title={`Show ${settings.panels[panel]} page; drop a widget here to move it`}
          onClick={() => focusPage(panel)}
          onDragOver={(event) => { if (draggingId()) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; setDropTarget({ panel, widgetId: null }) } }}
          onDrop={(event) => { event.preventDefault(); dropWidget(panel, null) }}
        >{settings.panels[panel]}</button>}</For>
      </div>

      <div class="wmp__page-actions"><button type="button" class="wmp__add-page" disabled={settings.panelOrder.length >= MAX_PANEL_COUNT} onClick={createPage}><Plus size={15} /> Add page</button><span>Widgets that need more room stay full size for readability.</span></div>

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
            <div class="wmp__edit-bottom"><label>Page<select aria-label={`Page for ${def()?.label ?? widget().kind}`} value={page()} onChange={(event) => updateWidget(widget().id, { panel: event.currentTarget.value })}><For each={settings.panelOrder}>{(panel) => <option value={panel}>{settings.panels[panel]}</option>}</For></select></label>
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
