import { createMemo, createSignal, For, Show, type JSX } from 'solid-js'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Plus, Trash2 } from 'lucide-solid'
import type { WidgetConfig, WidgetKind } from '../lib/ipc'
import { settings, patchSettings } from '../state/settings'
import { WIDGETS, WIDGET_KINDS } from '../components/widgets/registry'
import { moveWidgetAfter, moveWidgetBefore, moveWidgetWithin } from './widgetOrder'
import { defaultPanelForKind, widgetPanel, moveToPanel, type PanelId } from '../lib/panels'
import { widgetPages, type WidgetSlot } from '../lib/widgetPages'
import './WidgetManager.css'

type DropSide = 'before' | 'after'

interface DragState {
  id: string
  panel: PanelId
  pointerId: number
  startX: number
  startY: number
  dx: number
  dy: number
  moved: boolean
}

const DRAG_THRESHOLD = 6

export default function WidgetManager() {
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  const [drag, setDrag] = createSignal<DragState | null>(null)
  const [drop, setDrop] = createSignal<{ panel: PanelId; overId: string | null; side: DropSide | null } | null>(null)
  const [announce, setAnnounce] = createSignal('')
  let trayEl: HTMLDivElement | undefined
  let suppressClickUntil = 0

  const reduced = () =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const samePanel = (a: WidgetConfig, b: WidgetConfig) => widgetPanel(a, settings.panelOrder) === widgetPanel(b, settings.panelOrder)
  const labelOf = (widget: WidgetConfig) => WIDGETS[widget.kind]?.label ?? widget.kind

  const allOrdered = () => [...settings.widgets].sort((a, b) => a.order - b.order)
  const ordered = () => allOrdered().filter((widget) => widget.kind !== 'airdrop')
  const panelWidgets = (panel: PanelId) => ordered().filter((widget) => widgetPanel(widget, settings.panelOrder) === panel)
  const enabledPanelWidgets = (panel: PanelId) => panelWidgets(panel).filter((widget) => widget.enabled)
  const gridFor = (panel: PanelId) => widgetPages(enabledPanelWidgets(panel), 2)[0] ?? []

  const commit = (list: WidgetConfig[]) => {
    const passive = settings.widgets.filter((widget) => widget.kind === 'airdrop')
    patchSettings({ widgets: [...list, ...passive].map((widget, order) => ({ ...widget, order })) })
  }

  const toggle = (id: string) =>
    commit(ordered().map((widget) => (widget.id === id ? { ...widget, enabled: !widget.enabled } : widget)))
  const remove = (id: string) => {
    commit(ordered().filter((widget) => widget.id !== id))
    if (selectedId() === id) setSelectedId(null)
  }
  const setClock = (id: string, style: 'analog' | 'digital') =>
    commit(ordered().map((widget) => (widget.id === id ? { ...widget, clockStyle: style } : widget)))
  const moveTo = (id: string, panel: PanelId) => {
    const widget = ordered().find((item) => item.id === id)
    commit(moveWidgetAfter(moveToPanel(ordered(), id, panel), id, null))
    if (widget) setAnnounce(`${labelOf(widget)} moved to ${settings.panels[panel]}`)
    refocus(id)
  }

  const nudge = (id: string, delta: number) => {
    if (!delta) return
    let list = ordered()
    const step = delta > 0 ? 1 : -1
    for (let i = 0; i < Math.abs(delta); i += 1) list = moveWidgetWithin(list, id, step, samePanel)
    commit(list)
    const widget = ordered().find((item) => item.id === id)
    if (widget) setAnnounce(`${labelOf(widget)} moved`)
    refocus(id)
  }

  const add = (kind: WidgetKind) => {
    const widget: WidgetConfig = {
      id: crypto.randomUUID(),
      kind,
      enabled: true,
      order: ordered().length,
      panel: defaultPanelForKind(kind, settings.panelOrder),
    }
    commit([...ordered(), widget])
    setSelectedId(widget.id)
    refocus(widget.id)
  }

  const available = createMemo(() => WIDGET_KINDS.filter((kind) => !ordered().some((widget) => widget.kind === kind)))

  const selected = createMemo(() => {
    const id = selectedId()
    if (!id) return null
    const widget = ordered().find((item) => item.id === id)
    if (!widget) return null
    const panel = widgetPanel(widget, settings.panelOrder)
    const list = panelWidgets(panel)
    return {
      widget,
      panel,
      def: WIDGETS[widget.kind],
      index: list.findIndex((item) => item.id === id),
      count: list.length,
    }
  })

  const refocus = (id: string) => {
    const widget = ordered().find(item => item.id === id)
    if (widget) {
      const panel = widgetPanel(widget, settings.panelOrder)
      if (!settings.panelOrder.includes(panel)) return
    }
    requestAnimationFrame(() => {
      const card=trayEl?.querySelector<HTMLElement>(`[data-widget-id="${CSS.escape(id)}"]`)
      card?.scrollIntoView({block:'nearest',inline:'nearest',behavior:reduced()?'instant':'smooth'})
      card?.focus({preventScroll:true})
    })
  }

  /* ------------------------------------------------------- drag & drop */

  const hitTest = (x: number, y: number, draggedId: string) => {
    if (!trayEl) return
    let panel: PanelId | null = null
    for (const device of trayEl.querySelectorAll<HTMLElement>('[data-drop-panel]')) {
      const rect = device.getBoundingClientRect()
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        panel = device.dataset.dropPanel as PanelId
        break
      }
    }
    if (!panel) {
      setDrop(null)
      return
    }
    for (const card of trayEl.querySelectorAll<HTMLElement>('.wmp__mini[data-widget-id]')) {
      const id = card.dataset.widgetId
      if (!id || id === draggedId) continue
      const rect = card.getBoundingClientRect()
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        const side: DropSide = x < rect.left + rect.width / 2 ? 'before' : 'after'
        setDrop({ panel, overId: id, side })
        return
      }
    }
    setDrop({ panel, overId: null, side: null })
  }

  const autoScroll = (x: number) => {
    if (!trayEl) return
    const rect = trayEl.getBoundingClientRect()
    const edge = 34
    if (x < rect.left + edge) trayEl.scrollLeft -= 12
    else if (x > rect.right - edge) trayEl.scrollLeft += 12
  }

  const applyDrop = (id: string, target: { panel: PanelId; overId: string | null; side: DropSide | null }) => {
    let list = moveToPanel(ordered(), id, target.panel)
    if (target.overId && target.overId !== id) {
      list =
        target.side === 'after'
          ? moveWidgetAfter(list, id, target.overId)
          : moveWidgetBefore(list, id, target.overId)
    } else {
      list = moveWidgetAfter(list, id, null)
    }
    commit(list)
    const widget = ordered().find((item) => item.id === id)
    if (widget) setAnnounce(`${labelOf(widget)} moved to ${settings.panels[target.panel]}`)
  }

  const settle = (from: DOMRect, id: string) => {
    if (reduced()) return
    requestAnimationFrame(() => {
      const el = trayEl?.querySelector<HTMLElement>(`[data-widget-id="${CSS.escape(id)}"]`)
      if (!el) return
      const to = el.getBoundingClientRect()
      const dx = from.left - to.left
      const dy = from.top - to.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
      el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(1.02)`, opacity: 0.92 },
          { transform: 'translate(0,0) scale(1)', opacity: 1 },
        ],
        { duration: 340, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      )
    })
  }

  const onCardPointerDown = (event: PointerEvent, widget: WidgetConfig, panel: PanelId) => {
    if (event.button !== 0) return
    event.preventDefault()
    const el = event.currentTarget as HTMLElement
    try {
      el.setPointerCapture(event.pointerId)
    } catch {
      /* capture is best effort */
    }
    el.focus({ preventScroll: true })
    setSelectedId(widget.id)
    setDrop(null)
    setDrag({
      id: widget.id,
      panel,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      dy: 0,
      moved: false,
    })
  }

  const onCardPointerMove = (event: PointerEvent) => {
    const state = drag()
    if (!state || event.pointerId !== state.pointerId) return
    const dx = event.clientX - state.startX
    const dy = event.clientY - state.startY
    const moved = state.moved || Math.hypot(dx, dy) > DRAG_THRESHOLD
    setDrag({ ...state, dx, dy, moved })
    if (!moved) return
    hitTest(event.clientX, event.clientY, state.id)
    autoScroll(event.clientX)
  }

  const releaseCapture = (event: PointerEvent) => {
    const el = event.currentTarget as HTMLElement
    try {
      if (el.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
  }

  const onCardPointerUp = (event: PointerEvent) => {
    const state = drag()
    if (!state || event.pointerId !== state.pointerId) return
    releaseCapture(event)
    const el = event.currentTarget as HTMLElement
    const target = drop()

    if (!state.moved || !target) {
      // A tap selects (already done on pointer-down); a cancelled drag snaps home.
      setDrag(null)
      if (state.moved) {
        setDrop(null)
        snapBack(el, state)
      }
      return
    }

    const from = el.getBoundingClientRect()
    suppressClickUntil = performance.now() + 350
    setDrag(null)
    setDrop(null)
    applyDrop(state.id, target)
    settle(from, state.id)
  }

  const onCardPointerCancel = (event: PointerEvent) => {
    const state = drag()
    if (!state || event.pointerId !== state.pointerId) return
    releaseCapture(event)
    const el = event.currentTarget as HTMLElement
    setDrag(null)
    setDrop(null)
    snapBack(el, state)
  }

  const snapBack = (el: HTMLElement, state: DragState) => {
    if (reduced() || (state.dx === 0 && state.dy === 0)) return
    el.animate(
      [
        { transform: `translate3d(${state.dx}px, ${state.dy}px, 0)` },
        { transform: 'translate3d(0, 0, 0)' },
      ],
      { duration: 300, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    )
  }

  /* --------------------------------------------------------- keyboard */

  const onCardKeyDown = (event: KeyboardEvent, widget: WidgetConfig) => {
    const key = event.key
    if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'ArrowRight' || key === 'ArrowDown') {
      event.preventDefault()
      const delta = key === 'ArrowUp' || key === 'ArrowDown' ? 2 : 1
      nudge(widget.id, key === 'ArrowLeft' || key === 'ArrowUp' ? -delta : delta)
    } else if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      event.preventDefault()
      setSelectedId(widget.id)
    }
  }

  /* ------------------------------------------------------------- view */

  const MiniCard = (props: { widget: WidgetConfig; panel: PanelId; slot?: WidgetSlot | null }) => {
    const widget = props.widget
    const def = WIDGETS[widget.kind]
    const list = () => panelWidgets(props.panel)
    const index = () => list().findIndex((item) => item.id === widget.id)
    const isDragging = () => drag()?.id === widget.id
    const isDropBefore = () => drop()?.overId === widget.id && drop()?.side === 'before'
    const isDropAfter = () => drop()?.overId === widget.id && drop()?.side === 'after'

    const style = (): JSX.CSSProperties => {
      const next: JSX.CSSProperties = {}
      if (props.slot) {
        next['grid-column'] = `${props.slot.column} / span ${props.slot.columns}`
        next['grid-row'] = `${props.slot.row} / span ${props.slot.rows}`
      }
      const state = drag()
      if (state && state.id === widget.id) {
        next.transform = `translate3d(${state.dx}px, ${state.dy}px, 0)`
      }
      return next
    }

    return (
      <div
        class="wmp__mini"
        classList={{
          'wmp__mini--off': !widget.enabled,
          'wmp__mini--ghost': !props.slot,
          'wmp__mini--selected': selectedId() === widget.id,
          'wmp__mini--dragging': isDragging(),
          'wmp__mini--drop-before': isDropBefore(),
          'wmp__mini--drop-after': isDropAfter(),
        }}
        style={style()}
        role="button"
        tabIndex={0}
        data-widget-id={widget.id}
        aria-pressed={selectedId() === widget.id}
        aria-label={`${def?.label ?? widget.kind}${widget.enabled ? '' : ', disabled'}. Panel ${settings.panels[props.panel]}, position ${index() + 1} of ${list().length}. Use arrow keys to move it, Enter to inspect.`}
        onPointerDown={(event) => onCardPointerDown(event, widget, props.panel)}
        onPointerMove={onCardPointerMove}
        onPointerUp={onCardPointerUp}
        onPointerCancel={onCardPointerCancel}
        onKeyDown={(event) => onCardKeyDown(event, widget)}
        onClick={() => {
          if (performance.now() < suppressClickUntil) return
          setSelectedId(widget.id)
        }}
      >
        <span class="wmp__mini-icon">{def?.icon()}</span>
        <span class="wmp__mini-label">{def?.label ?? widget.kind}</span>
        <Show when={!widget.enabled}>
          <span class="wmp__mini-badge">Off</span>
        </Show>
      </div>
    )
  }

  return (
    <div class="wmp">
      <p class="wmp__lead">
        Each card is one dashboard panel. Drag widgets between panels to arrange them, or select one and use the arrow
        keys.
      </p>

      <div class="wmp__tray" ref={trayEl} role="list" aria-label="Widget panels">
        <For each={settings.panelOrder}>
          {(panel) => {
            const slots = createMemo(() => gridFor(panel))
            const ghosts = () => panelWidgets(panel).filter((widget) => !widget.enabled)
            const enabledCount = () => enabledPanelWidgets(panel).length
            return (
              <section
                class="wmp__device"
                classList={{ 'wmp__device--over': drop()?.panel === panel && !drop()?.overId }}
                data-drop-panel={panel}
                role="listitem"
                aria-label={`${settings.panels[panel]} panel preview`}
              >
                <header class="wmp__head">
                  <strong class="wmp__title">{settings.panels[panel]}</strong>
                  <span class="wmp__count" aria-label={`${enabledCount()} widgets enabled`}>
                    {enabledCount()}
                  </span>
                </header>

                <div class="wmp__grid">
                  <Show when={slots().length} fallback={<div class="wmp__empty">Drop widgets here</div>}>
                    <For each={slots()}>{(slot) => <MiniCard widget={slot.widget} panel={panel} slot={slot} />}</For>
                  </Show>
                </div>

                <Show when={ghosts().length}>
                  <div class="wmp__ghosts">
                    <span class="wmp__ghosts-label">Hidden</span>
                    <For each={ghosts()}>{(widget) => <MiniCard widget={widget} panel={panel} />}</For>
                  </div>
                </Show>
              </section>
            )
          }}
        </For>
      </div>

      <Show when={selected()} fallback={<p class="wmp__hint">Select a widget to toggle it or move it between panels.</p>}>
        {(sel) => {
          const state = () => sel()
          const widget = () => state().widget
          const def = () => state().def
          const otherPanels = () => settings.panelOrder.filter((panel) => panel !== state().panel)
          const atEdge = (delta: number) => {
            const next = state().index + delta
            return next < 0 || next >= state().count
          }
          return (
            <div class="wmp__inspector" role="group" aria-label={`${def()?.label ?? widget().kind} options`}>
              <div class="wmp__inspect-head">
                <span class="wmp__inspect-icon">{def()?.icon()}</span>
                <div class="wmp__inspect-text">
                  <strong>{def()?.label ?? widget().kind}</strong>
                  <small>{def()?.hint ?? ''}</small>
                </div>
                <button
                  type="button"
                  class="set-switch"
                  classList={{ 'set-switch--on': widget().enabled }}
                  role="switch"
                  aria-checked={widget().enabled}
                  aria-label={`${widget().enabled ? 'Disable' : 'Enable'} ${def()?.label ?? widget().kind}`}
                  onClick={() => toggle(widget().id)}
                >
                  <span />
                </button>
              </div>

              <div class="wmp__inspect-grid">
                <div class="wmp__field">
                  <span class="wmp__field-label">Move</span>
                  <div class="wmp__moves">
                    <button
                      type="button"
                      aria-label={`Move ${def()?.label ?? widget().kind} up`}
                      title="Move up"
                      disabled={atEdge(-2)}
                      onClick={() => nudge(widget().id, -2)}
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${def()?.label ?? widget().kind} down`}
                      title="Move down"
                      disabled={atEdge(2)}
                      onClick={() => nudge(widget().id, 2)}
                    >
                      <ArrowDown size={14} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${def()?.label ?? widget().kind} left`}
                      title="Move left"
                      disabled={atEdge(-1)}
                      onClick={() => nudge(widget().id, -1)}
                    >
                      <ArrowLeft size={14} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${def()?.label ?? widget().kind} right`}
                      title="Move right"
                      disabled={atEdge(1)}
                      onClick={() => nudge(widget().id, 1)}
                    >
                      <ArrowRight size={14} />
                    </button>
                  </div>
                </div>

                <div class="wmp__field">
                  <span class="wmp__field-label">Panel</span>
                  <div class="wmp__seg" role="group" aria-label={`Panel for ${def()?.label ?? widget().kind}`}>
                    <button type="button" aria-pressed="true">
                      {settings.panels[state().panel]}
                    </button>
                    <For each={otherPanels()}>
                      {(panel) => (
                        <button type="button" aria-pressed="false" onClick={() => moveTo(widget().id, panel)}>
                          {settings.panels[panel]}
                        </button>
                      )}
                    </For>
                  </div>
                </div>

                <Show when={widget().kind === 'clock'}>
                  <div class="wmp__field">
                    <span class="wmp__field-label">Clock face</span>
                    <div class="wmp__seg" role="group" aria-label="Clock appearance">
                      <For each={[['analog', 'Analog'], ['digital', 'Digital']] as const}>
                        {([value, label]) => (
                          <button
                            type="button"
                            aria-pressed={(widget().clockStyle ?? 'analog') === value}
                            onClick={() => setClock(widget().id, value)}
                          >
                            {label}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
              </div>

              <div class="wmp__inspect-actions">
                <span class="wmp__field-label">
                  {state().count > 0 ? `${state().index + 1} of ${state().count} in ${settings.panels[state().panel]}` : ''}
                </span>
                <button type="button" class="wmp__remove" onClick={() => remove(widget().id)}>
                  <Trash2 size={14} />
                  Remove
                </button>
              </div>
            </div>
          )
        }}
      </Show>

      <Show when={available().length > 0}>
        <div class="wmp__add">
          <span class="wmp__add-label">Add widget</span>
          <div class="wmp__chips">
            <For each={available()}>
              {(kind) => (
                <button type="button" class="wmp__chip" onClick={() => add(kind)}>
                  <Plus size={13} />
                  {WIDGETS[kind].label}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>

      <div class="wmp__live" aria-live="polite">
        {announce()}
      </div>
    </div>
  )
}
