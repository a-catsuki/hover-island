import { createEffect, createMemo, createSignal, For, Show, onCleanup, onMount } from 'solid-js'
import { Bell, ChevronUp, Moon, Pin, PinOff, Search, Settings as SettingsIcon, X, GripVertical, Check, LayoutGrid, ArrowUp, ArrowDown, FolderUp, SlidersHorizontal, Ellipsis } from 'lucide-solid'
import { browserPreview, cmd } from '../../lib/ipc'
import { settings, patchSettings, savingSettings, flushSettings } from '../../state/settings'
import { collapseIsland, open, pinned, setPinned } from '../../state/ui'
import { openSpotlight } from '../../state/spotlight'
import { feedback, dismissFeedback, reportError } from '../../state/feedback'
import { acknowledgePendingAlert, dismissPeek } from '../../state/peek'
import { WIDGETS } from '../widgets/registry'
import { widgetPanel, moveToPanel, type PanelId } from '../../lib/panels'
import { moveWidgetBefore, moveWidget } from '../../settings/widgetOrder'
import { crossedWidgetDragThreshold, widgetPointerDropTarget, widgetPointerReleaseTarget, type WidgetPointerDropTarget } from '../../lib/widgetPointerDrag'
import { activePanel, setActivePanel, showFileBucket, showControls, widgetRequest, detailRequest } from '../../state/panel'
import { widgetPages } from '../../lib/widgetPages'
import FirstRunTour from './FirstRunTour'
import { onboardingOpen } from '../../state/onboarding'

export default function ExpandedPanel() {
  const panel = activePanel, setPanel = setActivePanel
  createEffect(() => { const id=panel(); queueMicrotask(() => document.getElementById('panel-tab-'+id)?.scrollIntoView({block:'nearest',inline:'nearest'})) })
  let grid: HTMLDivElement | undefined
  let body: HTMLElement | undefined
  const [columns, setColumns] = createSignal(2)
  let panelMotion: Animation | undefined
  onMount(() => {
    const observer = new ResizeObserver(entries => setColumns(entries[0].contentRect.width < 540 ? 1 : 2))
    if (body) observer.observe(body)
    onCleanup(() => observer.disconnect())
  })
  let previousPanel = panel()
  createEffect(() => {
    const next = panel()
    if (next === previousPanel || !grid) return
    previousPanel = next
    const currentOpacity = panelMotion ? getComputedStyle(grid).opacity : '0.45'
    const currentTransform = panelMotion ? getComputedStyle(grid).transform : 'translateY(5px)'
    panelMotion?.cancel()
    panelMotion = grid.animate([
      { opacity: currentOpacity, transform: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : currentTransform },
      { opacity: 1, transform: 'none' },
    ], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' })
    panelMotion.onfinish = () => { panelMotion = undefined }
  })
  onCleanup(() => panelMotion?.cancel())
  // A failure banner never survives a collapse — it is dismissed with the panel.
  createEffect(() => { if (!open()) dismissFeedback() })
  const [arranging, setArranging] = createSignal(false)
  const [moreOpen, setMoreOpen] = createSignal(false)
  let moreRoot: HTMLDivElement | undefined
  let moreMenu: HTMLDivElement | undefined
  let moreTrigger: HTMLButtonElement | undefined
  const [dragged, setDragged] = createSignal<string | null>(null)
  const [over, setOver] = createSignal<string | null>(null)
  let pointerDrag: { pointerId: number; sourceId: string; start: { x: number; y: number }; element: HTMLElement; started: boolean } | undefined
  const all = createMemo(() => [...settings.widgets].filter(widget => widget.enabled && widget.kind !== 'airdrop').sort((a,b) => a.order-b.order))
  const panelWidgets = createMemo(() => all().filter(widget => widgetPanel(widget, settings.panelOrder) === panel()))
  const slotsForPanel = createMemo(() => widgetPages(panelWidgets(), columns())[0] ?? [])
  const slots = slotsForPanel
  const visible = () => slots().map(slot => slot.widget)
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
    }
  })
  createEffect(() => {
    const request = detailRequest()
    if (!request || request.revision === seenDetailRequest) return
    const widget = all().find(item => item.kind === request.kind)
    if (!widget) return
    seenDetailRequest = request.revision
    setPanel(widgetPanel(widget, settings.panelOrder))
  })
  const commit = (widgets: typeof settings.widgets) => patchSettings({ widgets })
  const move = (id: string, direction: number) => {
    const ids = panelWidgets().map(widget => widget.id)
    const index = ids.indexOf(id)
    const target = ids[index+direction]
    if (!target) return
    const ordered = [...settings.widgets].sort((a,b) => a.order-b.order)
    const from = ordered.findIndex(widget => widget.id === id), to = ordered.findIndex(widget => widget.id === target)
    ;[ordered[from],ordered[to]] = [ordered[to],ordered[from]]
    commit(ordered.map((widget, order) => ({...widget,order})))
  }
  // HTML5 drag remains a browser-preview compatibility path only. Native
  // desktop builds use pointer capture because Tauri owns OS file dragging.
  const previewDrop = (event: DragEvent, target?: string, targetPanel = panel()) => {
    if (!browserPreview) return
    event.preventDefault()
    const id = event.dataTransfer?.getData('text/plain') || dragged()
    if (!arranging() || !id || !settings.widgets.some(widget => widget.id === id)) return
    const reassigned = moveToPanel(settings.widgets, id, targetPanel)
    commit(target ? moveWidgetBefore(reassigned, id, target) : reassigned)
    setDragged(null); setOver(null); setPanel(targetPanel)
  }
  const pointerTargetAt = (x: number, y: number, sourceId: string): WidgetPointerDropTarget => {
    const element = document.elementFromPoint(x, y)
    const widget = element?.closest<HTMLElement>('[data-widget-id]')
    const tab = element?.closest<HTMLElement>('[data-panel-id]')
    return widgetPointerDropTarget(widget?.dataset.widgetId ?? null, tab?.dataset.panelId ?? null, sourceId)
  }
  const clearPointerDrag = (session = pointerDrag, releaseCapture = true) => {
    if (!session) return
    if (pointerDrag === session) pointerDrag = undefined
    setDragged(null)
    setOver(null)
    if (releaseCapture && session.element.hasPointerCapture(session.pointerId)) {
      try { session.element.releasePointerCapture(session.pointerId) } catch { /* The element may already have unmounted. */ }
    }
  }
  const beginWidgetPointerDrag = (event: PointerEvent, sourceId: string) => {
    if (!arranging() || event.button !== 0 || !event.isPrimary) return
    const target = event.target
    if (target instanceof Element && target.closest('button,a,input,textarea,select,[data-no-drag]')) return
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
    setOver(target?.id ?? null)
  }
  const finishWidgetPointerDrag = (event: PointerEvent) => {
    const session = pointerDrag
    if (!session || session.pointerId !== event.pointerId) return
    const target = widgetPointerReleaseTarget(session.started, pointerTargetAt(event.clientX, event.clientY, session.sourceId))
    clearPointerDrag(session)
    if (!target || !arranging() || !settings.widgets.some(widget => widget.id === session.sourceId)) return
    const targetWidget = target.kind === 'widget' ? settings.widgets.find(widget => widget.id === target.id) : undefined
    if (target.kind === 'widget' && !targetWidget) return
    const targetPanel = target.kind === 'panel' ? target.id as PanelId : widgetPanel(targetWidget!, settings.panelOrder)
    const reassigned = moveToPanel(settings.widgets, session.sourceId, targetPanel)
    commit(target.kind === 'widget' ? moveWidgetBefore(reassigned, session.sourceId, target.id) : reassigned)
    setPanel(targetPanel)
  }
  const cancelWidgetPointerDrag = (event: PointerEvent) => {
    if (pointerDrag?.pointerId === event.pointerId) clearPointerDrag(pointerDrag)
  }
  createEffect(() => { if (!arranging() && pointerDrag) clearPointerDrag(pointerDrag) })
  onCleanup(() => { if (pointerDrag) clearPointerDrag(pointerDrag) })
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
    <header class="panel__head">
      <div class="panel-navigation"><button type="button" class="panel-navigation__step" aria-label="Previous panel" onClick={() => {const order=settings.panelOrder;setPanel(order[(order.indexOf(panel())-1+order.length)%order.length])}}><ArrowUp size={12} style={{transform:'rotate(-90deg)'}}/></button><nav class="panel-tabs" role="tablist" aria-label="Panels" style={{ flex: '1 1 0', 'min-width': '0', 'overflow-x': 'auto', 'scrollbar-width': 'none' }} onKeyDown={event => { const order=settings.panelOrder; const index=order.indexOf(panel()); const next=event.key==='ArrowRight' ? (index+1)%order.length : event.key==='ArrowLeft' ? (index+order.length-1)%order.length : event.key==='Home' ? 0 : event.key==='End' ? order.length-1 : -1; if(next<0)return;event.preventDefault();setPanel(order[next]);(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next])?.focus() }}><For each={settings.panelOrder}>{id => <button role="tab" id={'panel-tab-'+id} data-panel-id={id} aria-controls="island-content" tabIndex={panel()===id ? 0 : -1} aria-selected={panel() === id} aria-label={settings.panels[id] + ' panel'} classList={{ selected: panel() === id, 'panel-tabs__drop': over() === id }} onClick={() => setPanel(id)} onDragOver={event => { if (browserPreview && arranging()) { event.preventDefault(); setOver(id) } }} onDragLeave={() => { if(browserPreview)setOver(null) }} onDrop={event => previewDrop(event, undefined, id)}><span class="panel-tabs__label">{settings.panels[id]}</span><Show when={arranging()}><small>{all().filter(widget => widgetPanel(widget, settings.panelOrder) === id).length}</small></Show></button>}</For></nav><button type="button" class="panel-navigation__step" aria-label="Next panel" onClick={() => {const order=settings.panelOrder;setPanel(order[(order.indexOf(panel())+1)%order.length])}}><ArrowDown size={12} style={{transform:'rotate(-90deg)'}}/></button></div>

      <div class="panel__tools">
        <button class="beam-button" type="button" aria-label="Open file beam" title="Beam files to your phone" onClick={showFileBucket}><FolderUp size={15}/><span>Beam</span></button>
        <button class="icon-button panel__quick-controls" type="button" aria-label="Open quick controls" title="Quick controls" onClick={showControls}><SlidersHorizontal size={16}/></button>
        <button class="search-button" onClick={openSpotlight} title="Search anything (Ctrl+Space)" aria-label="Search Ctrl Space"><Search size={15}/><span>Search</span><kbd>Ctrl Space</kbd></button>
        <button class="icon-button" aria-label="Open settings" title="Settings" onClick={openSettings}><SettingsIcon size={16}/></button>
        <button class="icon-button" aria-label="Collapse island" title="Collapse (Esc)" onClick={() => { void flushSettings().catch(() => {}); collapseIsland() }}><ChevronUp size={16}/></button>
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
      <FirstRunTour/>
      <Show when={arranging()}><p class="arrange-hint"><GripVertical size={13}/>Drag a widget to reorder, or drop it on a panel above.</p></Show>
      <div ref={grid} class={'widget-grid widget-grid--' + panel()} style={{'--grid-columns':columns()}} classList={{ 'widget-grid--arranging': arranging() }} inert={onboardingOpen()}>
        <For each={visible()}>{widget => {
          const slot = () => slots().find(item => item.widget.id === widget.id) ?? {column:1,row:1,columns:1,rows:1}
          const panelIndex = () => panelWidgets().findIndex(item => item.id === widget.id)
          const def = WIDGETS[widget.kind]
          return <section style={{'grid-column':`${slot().column} / span ${slot().columns}`,'grid-row':`${slot().row} / span ${slot().rows}`}} class={'widget widget--' + widget.kind} classList={{ 'widget--dragging': dragged() === widget.id, 'widget--drop': over() === widget.id, 'widget--full':slot().rows===2 }} data-widget-kind={widget.kind} data-widget-id={widget.id} aria-label={def.label + ' widget'} draggable={browserPreview && arranging()} onDragStart={event => { if (!browserPreview || !arranging()) { event.preventDefault(); return }; setDragged(widget.id); event.dataTransfer?.setData('text/plain',widget.id); if(event.dataTransfer) event.dataTransfer.effectAllowed='move' }} onDragOver={event => { if (browserPreview && arranging()) { event.preventDefault(); setOver(widget.id) } }} onDragLeave={() => { if(browserPreview)setOver(null) }} onDrop={event => previewDrop(event,widget.id)} onDragEnd={() => { if(browserPreview){setDragged(null);setOver(null)} }} onPointerDown={event => beginWidgetPointerDrag(event, widget.id)} onPointerMove={moveWidgetPointerDrag} onPointerUp={finishWidgetPointerDrag} onPointerCancel={cancelWidgetPointerDrag} onLostPointerCapture={cancelWidgetPointerDrag}>
            <Show when={arranging()}><div class="widget-arranger"><GripVertical size={14}/><span>{def.label}</span><button class="icon-button" aria-label={'Move ' + def.label + ' earlier in panel'} disabled={panelIndex()===0} onClick={() => move(widget.id,-1)}><ArrowUp size={12}/></button><button class="icon-button" aria-label={'Move ' + def.label + ' later in panel'} disabled={panelIndex()===panelWidgets().length-1} onClick={() => move(widget.id,1)}><ArrowDown size={12}/></button></div></Show>
            <div class="widget-content" inert={arranging()}>{def.render(widget)}</div>
          </section>
        }}</For>
        <Show when={!visible().length}><div class="panel-empty"><LayoutGrid size={24}/><strong>A space for your essentials.</strong><p>Add widgets or move them here from another panel.</p><button class="button" onClick={openSettings}>Choose widgets</button></div></Show>
      </div>
    </main>
      <footer class="panel__foot" classList={{'panel__foot--quiet':!savingSettings()&&!settings.dnd&&!arranging()&&!pinned()}}><span>{savingSettings() ? 'Saving…' : settings.dnd ? 'Do Not Disturb' : arranging() ? 'Arrange widgets' : pinned() ? 'Pinned open' : ''}</span></footer>
  </div>
}
