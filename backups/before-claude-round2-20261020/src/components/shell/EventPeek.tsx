import { createEffect, createSignal, Show } from 'solid-js'
import { ArrowDown, ArrowUp, Check, CircleAlert, Copy, ExternalLink, FolderOpen, KeyRound, Moon, Sun, Volume2, VolumeX } from 'lucide-solid'
import { peek, dismissPeek, acknowledgePendingAlert } from '../../state/peek'
import { cmd } from '../../lib/ipc'
import { showFileBucket } from '../../state/panel'
import { reportError } from '../../state/feedback'
import { expandIsland } from '../../state/ui'
import BrandIcon from '../BrandIcon'
import NotificationAppIcon from './NotificationAppIcon'
import { openNotificationSource } from '../../state/notifications'
import { relativeTime } from '../../lib/connectionSources'
import './EventPeek.css'

export default function EventPeek() {
  const transfer = () => peek()?.category === 'transfer' || peek()?.app === 'Phone bucket'
  const mute = () => peek()?.app === 'Do Not Disturb'
  const ai = () => peek()?.category === 'ai'
  const auth = () => peek()?.category === 'auth'
  const systemControl = () => peek()?.app === 'Volume' || peek()?.app === 'Brightness'
  const controlLevel = () => {
    const value = Number.parseInt(peek()?.body.match(/\d{1,3}/)?.[0] ?? '', 10)
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
  }
  const controlMuted = () => peek()?.app === 'Volume' && /muted/i.test(peek()?.body ?? '')
  const device = () => ['Bluetooth', 'Battery', 'Do Not Disturb'].includes(peek()?.app ?? '')
  const nativeAlert = () => !!peek()?.id.startsWith('notification:')
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
  const copyCode = async () => {
    const item = peek()
    if (!item?.code) return
    try { await navigator.clipboard.writeText(item.code); dismiss(item.id) }
    catch (error) { reportError('Could not copy verification code', error) }
  }
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
    if (!interactive(event.target)) {
      const item = peek()
      if (item && nativeAlert()) void openNotificationSource(item.app)
      dismissCurrent()
    }
  }
  const onPointerCancel = () => {
    if (!armed) return
    armed = false; moved = false
    setDragging(false); setDragY(0)
  }

  return <Show when={peek()}>{item=><div class="peek" classList={{'peek--transfer':transfer(),'peek--failed':failed(),'peek--mute':mute(),'peek--ai':ai(),'peek--ai-complete':aiComplete(),'peek--ai-input':aiInput(),'peek--system':systemControl(),'peek--auth':auth(),'peek--system-muted':controlMuted(),'peek--dragging':dragging()}} role="status" aria-live="polite" tabIndex={0} aria-label={`${item().app}: ${auth() ? 'verification code ' : ''}${item().code ?? item().title}. Press Escape to dismiss.`}
    style={{'animation':suppressEnter()?'none':'','transform':suppressEnter()?`translateY(${dragging()?dragY():0}px)`:'','transition':suppressEnter()&&!dragging()?'transform 300ms var(--spring)':''}}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissCurrent() } }}>
    <Show when={auth()}><div class="peek__auth">
      <span class="peek__auth-icon"><KeyRound size={19}/></span>
      <div class="peek__auth-copy"><div class="peek__auth-label">{item().account ? `Code for ${item().account}` : 'Email verification code'}</div><strong class="peek__auth-code">{item().code}</strong><div class="peek__auth-meta">{item().sender || item().subject || 'New sign-in message'}</div></div>
      <button class="peek__auth-button" type="button" aria-label="Copy verification code" title="Copy code" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); void copyCode() }}><Copy size={15}/><span>Copy</span></button>
    </div></Show>
    <Show when={transfer()} fallback={<Show when={ai()} fallback={<Show when={systemControl()} fallback={<div class="peek-note" classList={{'peek-note--device':device()}}>
      <Show when={!mute()} fallback={<span class="peek-note__glyph"><Moon size={18}/></span>}><NotificationAppIcon app={item().app} icon={item().icon} size={device()?34:40}/></Show>
      <div class="peek__body peek-note__body">
        <div class="peek-note__meta"><span class="peek-note__app">{item().app}</span><Show when={!device()}><span class="peek-note__time">{relativeTime(item().timestamp, Date.now())}</span></Show><Show when={item().priority==='urgent'}><span class="peek__priority">Urgent</span></Show></div>
        <div class="peek-note__title peek__title">{item().title}</div>
        <Show when={item().body}><div class="peek-note__text">{item().body}</div></Show>
        <Show when={item().url}><button class="peek__open" onClick={act}>Open alert<ExternalLink size={11}/></button></Show>
      </div>
    </div>}>
      <div class="peek-hud" role="img" aria-label={`${item().app} ${controlMuted()?'muted':`${controlLevel()} percent`}`}>
        <span class="peek-hud__icon" aria-hidden="true">{item().app==='Volume'?<Show when={!controlMuted()} fallback={<VolumeX size={20}/>}><Volume2 size={20}/></Show>:<Sun size={20}/>}</span>
        <span class="peek-hud__track" aria-hidden="true"><span style={{width:`${controlMuted()?0:controlLevel()}%`}}/></span>
        <span class="peek-hud__value">{controlMuted()?'Muted':`${controlLevel()}%`}</span>
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
