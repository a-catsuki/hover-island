import { For, onCleanup, onMount, Show, createSignal } from 'solid-js'
import { ArrowDown, ArrowUp, Check, FileText, Monitor, Power, Radio, RefreshCw, Smartphone, X } from 'lucide-solid'
import type { NearbyPeer, NearbyTransfer } from '../../lib/ipc'
import { nearby, refreshNearby, approveNearby, startNearby, stopNearby, subscribeNearby } from '../../state/nearby'
import BeamBucket from './BeamBucket'
import './NearbyView.css'

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let i = 0
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1 }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

const percent = (t: NearbyTransfer): number => t.total ? Math.max(0, Math.min(100, Math.round(t.bytes / t.total * 100))) : t.status === 'done' ? 100 : 0
const failed = (t: NearbyTransfer) => t.status.startsWith('failed') || t.status === 'rejected' || t.status === 'expired'
const statusText = (t: NearbyTransfer) => t.status.startsWith('failed:') ? 'Failed' : t.status === 'done' ? 'Done' : t.status === 'pending' || t.status === 'waiting' ? 'Waiting' : t.status === 'active' ? `${percent(t)}%` : t.status.charAt(0).toUpperCase() + t.status.slice(1)

/** Positions peers on the outer radar ring, evenly spread, starting at the top. */
function ringPosition(index: number, count: number): { x: number; y: number } {
  const angle = -Math.PI / 2 + (index / Math.max(1, count)) * Math.PI * 2
  return { x: 50 + Math.cos(angle) * 36, y: 50 + Math.sin(angle) * 36 }
}

function PeerAvatar(props: { peer: NearbyPeer; x: number; y: number }) {
  const phone = () => /phone|android|iphone|ipad|pixel|galaxy/i.test(props.peer.name)
  return <div class="nearby__peer" style={`left:${props.x}%;top:${props.y}%`} title={`${props.peer.address}:${props.peer.port}`}>
    <span class="nearby__avatar">{phone() ? <Smartphone size={20}/> : <Monitor size={20}/>}</span>
    <span class="nearby__peer-name">{props.peer.name}</span>
  </div>
}

export default function NearbyView(props: { compact?: boolean }) {
  const [mode, setMode] = createSignal<'bucket' | 'nearby'>('bucket')
  const [notice, setNotice] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  const peers = (): NearbyPeer[] => nearby().peers ?? []
  const transfers = (): NearbyTransfer[] => nearby().transfers ?? []
  const detail = () => notice() ?? nearby().detail ?? null

  async function decideReceive(sessionId: string, approved: boolean): Promise<void> {
    if (busy()) return
    setBusy(true)
    try {
      const error = await approveNearby(sessionId, approved)
      setNotice(error ?? (approved ? 'Transfer accepted.' : 'Transfer declined.'))
    } finally { setBusy(false) }
  }

  onMount(() => {
    if (props.compact) return
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void subscribeNearby().then(fn => { if (disposed) fn(); else unsubscribe = fn })
    onCleanup(() => { disposed = true; unsubscribe?.() })
  })
  // Notices are one-shot; clear them so a stale "declined" never lingers.
  onMount(() => {
    const timer = window.setInterval(() => { if (notice()) setNotice(null) }, 6000)
    onCleanup(() => window.clearInterval(timer))
  })

  if (props.compact) return <div class="nearby nearby--compact"><BeamBucket/></div>

  return (
    <div class="nearby">
      <div class="nearby__head">
        <div class="nearby__head-left">
          <h2>{mode() === 'bucket' ? 'Beam' : 'Nearby'}</h2>
          <span class="nearby__pill" classList={{ 'nearby__pill--on': mode() === 'nearby' && nearby().running }}>
            <span class="nearby__pill-dot" />
            {mode() === 'bucket' ? nearby().deviceName || 'This PC' : nearby().running ? `Visible as ${nearby().deviceName || 'this PC'}` : 'Off'}
          </span>
        </div>
        <Show when={mode() === 'nearby'}>
          <div class="nearby__head-actions">
            <button type="button" class="nearby__icon-btn" onClick={() => void refreshNearby()} aria-label="Refresh" title="Refresh" data-no-drag><RefreshCw size={15} strokeWidth={1.75} aria-hidden="true"/></button>
            <button type="button" class="nearby__btn" classList={{ 'nearby__btn--on': nearby().running }} onClick={() => void (nearby().running ? stopNearby() : startNearby())} data-no-drag>
              <Power size={14} strokeWidth={1.9} aria-hidden="true"/><span>{nearby().running ? 'Stop' : 'Start'}</span>
            </button>
          </div>
        </Show>
      </div>

      <div class="nearby__tabs" role="tablist" aria-label="Transfer method">
        <button type="button" role="tab" aria-selected={mode() === 'bucket'} classList={{ 'is-active': mode() === 'bucket' }} onClick={() => setMode('bucket')} data-no-drag><Smartphone size={14}/> Phone</button>
        <button type="button" role="tab" aria-selected={mode() === 'nearby'} classList={{ 'is-active': mode() === 'nearby' }} onClick={() => setMode('nearby')} data-no-drag><Radio size={14}/> LocalSend</button>
      </div>

      <Show when={mode() === 'bucket'}><BeamBucket/></Show>

      <Show when={mode() === 'nearby'}>
        <Show when={detail()}>{text => <div class="nearby__notice" role="status">{text()}</div>}</Show>
        <div class="nearby__body">
          <section class="nearby__radar-card" aria-label="Devices nearby">
            <div class="nearby__radar" classList={{ 'is-live': nearby().running }} aria-hidden="true"><i/><i/><i/></div>
            <div class="nearby__self"><span class="nearby__avatar nearby__avatar--self"><Monitor size={22}/></span></div>
            <For each={peers()}>{(peer, index) => { const pos = () => ringPosition(index(), peers().length); return <PeerAvatar peer={peer} x={pos().x} y={pos().y}/> }}</For>
            <Show when={!peers().length}>
              <div class="nearby__empty">
                <strong>{nearby().running ? 'Looking for devices' : 'Nearby is off'}</strong>
                <span>{nearby().running ? 'Open LocalSend on another device on this network.' : 'Turn it on to see devices on your network.'}</span>
              </div>
            </Show>
          </section>

          <section class="nearby__activity" aria-label="Transfers">
            <h3>Transfers</h3>
            <Show when={transfers().length > 0} fallback={<div class="nearby__activity-empty">No transfers yet.</div>}>
              <div class="nearby__transfer-list">
                <For each={[...transfers()].reverse()}>{t => (
                  <div class="nearby__transfer">
                    <span class="nearby__ring" classList={{ 'is-done': t.status === 'done', 'is-fail': failed(t) }} style={`--p:${percent(t)}`} role="progressbar" aria-label={`${t.fileName} transfer`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent(t)}>
                      <i>{t.status === 'done' ? <Check size={12} strokeWidth={3}/> : failed(t) ? <X size={12} strokeWidth={3}/> : t.direction === 'receive' ? <ArrowDown size={12} strokeWidth={2.4}/> : <ArrowUp size={12} strokeWidth={2.4}/>}</i>
                    </span>
                    <div class="nearby__transfer-main">
                      <span class="nearby__transfer-name" title={t.fileName}><FileText size={13} aria-hidden="true"/>{t.fileName}</span>
                      <span class="nearby__transfer-meta">{t.peer} · {formatBytes(t.bytes)}<Show when={t.total > 0}> of {formatBytes(t.total)}</Show></span>
                      <Show when={t.status.startsWith('failed:')}><span class="nearby__transfer-error">{t.status.slice(7)}</span></Show>
                      <Show when={t.status === 'pending'}>
                        <span class="nearby__approval" data-no-drag>
                          <button type="button" class="nearby__approval-btn nearby__approval-btn--accept" disabled={busy()} onClick={() => void decideReceive(t.id, true)}>Accept</button>
                          <button type="button" class="nearby__approval-btn" disabled={busy()} onClick={() => void decideReceive(t.id, false)}>Decline</button>
                        </span>
                      </Show>
                    </div>
                    <span class="nearby__transfer-status" classList={{ 'is-done': t.status === 'done', 'is-fail': failed(t) }}>{statusText(t)}</span>
                  </div>
                )}</For>
              </div>
            </Show>
            <p class="nearby__protocol">LocalSend over your local network. Incoming files are saved to Downloads / HoverIsland only after you accept.</p>
          </section>
        </div>
      </Show>
    </div>
  )
}
