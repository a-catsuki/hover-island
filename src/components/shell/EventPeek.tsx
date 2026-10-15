import { createEffect, createSignal, Show } from 'solid-js'
import { ArrowDown, ArrowUp, Check, CircleAlert, ExternalLink, FolderOpen, Moon, Sun, Volume2 } from 'lucide-solid'
import { peek, dismissPeek, acknowledgePendingAlert } from '../../state/peek'
import { cmd } from '../../lib/ipc'
import { showFileBucket } from '../../state/panel'
import { reportError } from '../../state/feedback'
import { expandIsland } from '../../state/ui'
import BrandIcon from '../BrandIcon'
import './EventPeek.css'

export default function EventPeek() {
  const transfer = () => peek()?.category === 'transfer' || peek()?.app === 'Phone bucket'
  const mute = () => peek()?.app === 'Do Not Disturb'
  const ai = () => peek()?.category === 'ai'
  const systemControl = () => peek()?.app === 'Volume' || peek()?.app === 'Brightness'
  const controlLevel = () => {
    const value = Number.parseInt(peek()?.body.match(/\d{1,3}/)?.[0] ?? '', 10)
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
  }
  const controlMuted = () => peek()?.app === 'Volume' && /muted/i.test(peek()?.body ?? '')
  const aiInput = () => ai() && peek()?.aiKind === 'needs-input'
  const aiComplete = () => ai() && peek()?.aiKind !== 'needs-input'
  const running = () => ['sending','receiving','staging'].includes(peek()?.phase ?? '')
  const failed = () => peek()?.phase === 'error' || peek()?.title === 'Transfer failed'
  const complete = () => peek()?.phase === 'complete' || peek()?.phase === 'sent' || peek()?.title === 'File received'
  const sending = () => peek()?.phase === 'sending' || peek()?.phase === 'staging'
  const progress = () => Math.round(Math.max(0,Math.min(1,peek()?.progress ?? 0))*100)
  const statusLabel = () => {
    const item = peek(); if (!item) return ''
    if (failed()) return item.title
    if (item.phase === 'sent') return 'Sent to phone'
    if (complete()) return 'Transfer complete'
    if (item.phase === 'receiving') return 'Receiving…'
    if (item.phase === 'sending') return 'Sending…'
    if (item.phase === 'ready') return 'Ready to download'
    return item.title || 'Transferring…'
  }
  const file = () => {
    const body = peek()?.body ?? ''
    const split = body.indexOf(' · ')
    if (split < 0) return { name: body, size: '' }
    return { name: body.slice(0, split), size: body.slice(split + 3) }
  }
  const actionLabel = () => failed() ? 'Try again from Files' : complete() ? 'Show files' : 'Open Files'
  const dismiss = (id: string) => { acknowledgePendingAlert(id); dismissPeek() }
  const dismissCurrent = () => { const item = peek(); if (item) dismiss(item.id) }
  const act = () => {
    const item=peek();if(!item)return
    acknowledgePendingAlert(item.id)
    if (transfer()) {
      if (item.phase==='complete' || item.title==='File received') void cmd.transferOpenFolder().catch(error=>reportError('Could not open received files',error))
      else { expandIsland(false); showFileBucket() }
    } else if (item.url) void cmd.appsOpenUrl(item.url).catch(error=>reportError('Could not open alert',error))
    dismissPeek()
  }

  /* Activities own the notch surface. Tap/flick or Escape dismisses without
     adding a separate close control to the compact material. */
  const [dragY, setDragY] = createSignal(0)
  const [dragging, setDragging] = createSignal(false)
  const [suppressEnter, setSuppressEnter] = createSignal(false)
  let startX = 0, startY = 0, lastY = 0, lastT = 0, velocity = 0
  let armed = false, moved = false
  let previousPeekId: string | undefined
  createEffect(() => {
    const id = peek()?.id
    if (id === previousPeekId) return
    previousPeekId = id
    armed = false
    moved = false
    velocity = 0
    setDragY(0)
    setDragging(false)
    setSuppressEnter(false)
  })
  const interactive = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest('button, a, input, textarea, select, [data-no-drag]')
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || interactive(event.target)) return
    armed = true; moved = false
    startX = event.clientX; startY = lastY = event.clientY
    lastT = performance.now(); velocity = 0
    ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent) => {
    if (!armed) return
    const dx = event.clientX - startX
    const dy = event.clientY - startY
    if (!moved) {
      if (Math.abs(dy) < 6 || Math.abs(dx) > Math.abs(dy)) return
      moved = true
      setSuppressEnter(true)
      setDragging(true)
    }
    const now = performance.now()
    const dt = Math.max(1, now - lastT)
    velocity = (event.clientY - lastY) / dt
    lastY = event.clientY; lastT = now
    setDragY(dy < 0 ? dy : dy * 0.35)
  }
  const onPointerUp = (event: PointerEvent) => {
    if (!armed) return
    armed = false
    if (moved) {
      moved = false
      const dy = dragY()
      setDragging(false)
      setDragY(0)
      if (dy < -44 || velocity < -0.5) dismissCurrent()
      return
    }
    if (!interactive(event.target)) dismissCurrent()
  }
  const onPointerCancel = () => {
    if (!armed) return
    armed = false; moved = false
    setDragging(false); setDragY(0)
  }

  return <Show when={peek()}>{item=><div class="peek" classList={{'peek--transfer':transfer(),'peek--failed':failed(),'peek--mute':mute(),'peek--ai':ai(),'peek--ai-complete':aiComplete(),'peek--ai-input':aiInput(),'peek--system':systemControl(),'peek--system-muted':controlMuted(),'peek--dragging':dragging()}} role="status" aria-live="polite" tabIndex={0} aria-label={`${item().app}: ${item().title}. Press Escape to dismiss.`}
    style={{'animation':suppressEnter()?'none':'','transform':suppressEnter()?`translateY(${dragging()?dragY():0}px)`:'','transition':suppressEnter()&&!dragging()?'transform 300ms var(--spring)':''}}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissCurrent() } }}>
    <Show when={transfer()} fallback={<Show when={ai()} fallback={<Show when={systemControl()} fallback={<>
      <span class="peek__dot"><Show when={!mute()} fallback={<Moon size={16}/>}><Show when={item().icon} fallback={<BrandIcon name={item().app} size={24}/>}>{src=><img src={src()!} alt="" draggable={false}/>}</Show></Show></span>
      <div class="peek__body"><div class="peek__app">{item().app}<Show when={item().priority==='urgent'}><span class="peek__priority">Urgent</span></Show></div><div class="peek__title">{item().title}</div><Show when={item().body}><div class="peek__text">{item().body}</div></Show>
        <Show when={item().url}><button class="peek__open" onClick={act}>Open alert<ExternalLink size={11}/></button></Show>
      </div>
    </>}>
      <div class="peek-system__icon" aria-hidden="true">{item().app==='Volume'?<Volume2 size={22}/>:<Sun size={22}/>}</div>
      <div class="peek__body peek__body--system">
        <div class="peek__app">{item().app}</div>
        <div class="peek__title">{controlMuted()?'Muted':`${controlLevel()}%`}</div>
        <div class="peek-system__track" aria-hidden="true"><span style={{width:`${controlLevel()}%`}}/></div>
      </div>
    </Show>}>
      <div class="peek-ai-icon" classList={{'peek-ai-icon--input':aiInput()}} aria-hidden="true"><BrandIcon name={item().app} size={28}/><span/></div>
      <div class="peek__body peek__body--ai">
        <div class="peek__app peek__app--ai">{item().app}<span class="peek-ai__badge" classList={{'peek-ai__badge--input':aiInput()}}>{aiInput()?'Needs input':'Task complete'}</span></div>
        <div class="peek__title">{item().title}</div>
        <Show when={item().body}><div class="peek__text">{item().body}</div></Show>
      </div>
    </Show>}>
      <div class="peek-transfer-icon" aria-hidden="true">
        <svg viewBox="0 0 48 48">
          <circle class="peek-transfer-icon__track" cx="24" cy="24" r="21"/>
          <circle class="peek-transfer-icon__progress" cx="24" cy="24" r="21" style={{'stroke-dashoffset':running()?`${132*(1-progress()/100)}`:'0'}}/>
        </svg>
        <span class="peek-transfer-icon__glyph"><Show when={!failed()} fallback={<CircleAlert size={28} strokeWidth={1.8}/>}><Show when={running()} fallback={<Check size={30} strokeWidth={2.2}/>}><Show when={sending()} fallback={<ArrowDown size={30} strokeWidth={2.2}/>}><ArrowUp size={30} strokeWidth={2.2}/></Show></Show></Show></span>
      </div>
      <div class="peek__body peek__body--transfer">
        <div class="peek-transfer__meta">
          <span class="peek__app">Nearby sharing</span>
          <Show when={running() && item().progress!=null}><span class="peek-transfer__pct">{progress()}%</span></Show>
        </div>
        <div class="peek-transfer__status">{statusLabel()}</div>
        <div class="peek-transfer__file">
          <span class="peek-transfer__name" title={file().name}>{file().name}</span>
          <Show when={file().size}><span class="peek-transfer__size">{file().size}</span></Show>
        </div>
        <button class="peek-transfer__action" onClick={act}><FolderOpen size={13}/>{actionLabel()}</button>
      </div>
    </Show>
  </div>}</Show>
}
