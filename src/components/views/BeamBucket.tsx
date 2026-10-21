import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch, type JSX } from 'solid-js'
import { ArrowDown, ArrowLeft, ArrowUp, Check, CircleAlert, Copy, File, FileArchive, FileText, Film, FolderOpen, Image, Info, Laptop, Monitor, Music, Plus, Power, Radio, Smartphone, Tablet, Upload, X } from 'lucide-solid'
import { cmd, type NearbyPeer, type NearbyTransfer, type PairedPhone, type PhonePairingStatus } from '../../lib/ipc'
import { filesFromDrop, filesFromPicker } from '../../lib/droppedFiles'
import { createSpeedTracker, formatBytes, formatRemaining, formatSpeed, percentOf } from '../../lib/transferSpeed'
import { nearby, sendNearby, approveNearby, startNearby, stopNearby, subscribeNearby } from '../../state/nearby'
import { dismissFailedUploads, refreshTransfer, startTransfer, stopTransfer, transfer, transferUpload, uploads, type TransferUploadProgress } from '../../state/transfer'
import { open } from '../../state/ui'
import './BeamBucket.css'

type Tone = 'info' | 'error'
type BeamState = 'idle' | 'scanning' | 'connected' | 'sending' | 'received' | 'error'
type DeviceKind = 'phone' | 'tablet' | 'laptop' | 'desktop'

interface Bubble {
  id: string
  name: string
  kind: DeviceKind
  /** A phone that is connected to this session (it pulls files from Beam). */
  connected: boolean
  /** A Nearby (LocalSend) device that can be sent files. */
  peer?: NearbyPeer
}

const MAX_BUBBLES = 6
/** Angles in degrees (0 = right, -90 = top) so a few devices never sit on top of each other or the caption. */
const SPREAD: Record<number, number[]> = {
  1: [-50],
  2: [-140, -40],
  3: [-150, -90, -30],
  4: [-135, -45, 45, 135],
  5: [-90, -18, 54, 126, 198],
  6: [-90, -30, 30, 90, 150, 210],
}

const failedStatus = (t: NearbyTransfer) => t.status.startsWith('failed') || t.status === 'rejected' || t.status === 'expired'
const liveStatus = (t: NearbyTransfer) => t.status === 'active' || t.status === 'waiting' || t.status === 'pending'
const failReason = (t: NearbyTransfer) => t.status.startsWith('failed:') ? t.status.slice(7).trim() : ''

function deviceKind(name: string): DeviceKind {
  if (/ipad|tablet|tab\b/i.test(name)) return 'tablet'
  if (/phone|android|pixel|galaxy|oneplus|xiaomi|redmi|huawei/i.test(name)) return 'phone'
  if (/mac|book|laptop|notebook|thinkpad|surface/i.test(name)) return 'laptop'
  return 'desktop'
}

function DeviceIcon(props: { kind: DeviceKind; size?: number }) {
  const size = () => props.size ?? 20
  return <Switch fallback={<Monitor size={size()} strokeWidth={1.75}/>}>
    <Match when={props.kind === 'phone'}><Smartphone size={size()} strokeWidth={1.75}/></Match>
    <Match when={props.kind === 'tablet'}><Tablet size={size()} strokeWidth={1.75}/></Match>
    <Match when={props.kind === 'laptop'}><Laptop size={size()} strokeWidth={1.75}/></Match>
  </Switch>
}

function FileGlyph(props: { name: string }) {
  const ext = () => props.name.slice(props.name.lastIndexOf('.') + 1).toLowerCase()
  const size = 17
  const kind = () => /^(png|jpe?g|webp|gif|heic|heif|avif|bmp|svg)$/.test(ext()) ? 'image'
    : /^(mp4|mov|m4v|webm|mkv|avi)$/.test(ext()) ? 'video'
    : /^(mp3|wav|flac|m4a|aac|ogg|opus)$/.test(ext()) ? 'audio'
    : /^(zip|rar|7z|tar|gz)$/.test(ext()) ? 'archive'
    : /^(pdf|docx?|txt|md|rtf|xlsx?|csv|pptx?)$/.test(ext()) ? 'doc' : 'file'
  return <span class="beam__file-icon" data-kind={kind()} aria-hidden="true">
    {kind() === 'image' ? <Image size={size}/> : kind() === 'video' ? <Film size={size}/> : kind() === 'audio' ? <Music size={size}/>
      : kind() === 'archive' ? <FileArchive size={size}/> : kind() === 'doc' ? <FileText size={size}/> : <File size={size}/>}
  </span>
}

/** Progress ring: a thin conic stroke that reads as a percentage, with room for a glyph or number inside. */
function Ring(props: { value: number; label: string; tone?: 'blue' | 'green' | 'red' | 'idle'; size?: 'sm' | 'lg'; children?: JSX.Element }) {
  const value = () => Math.max(0, Math.min(100, props.value))
  return <span class="beam__ring" classList={{ 'beam__ring--lg': props.size === 'lg' }} data-tone={props.tone ?? 'blue'} role="progressbar" aria-label={props.label}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value())} style={`--p:${value()}`}>
    <span class="beam__ring-body">{props.children}</span>
  </span>
}

export default function BeamBucket() {
  const [pairing, setPairing] = createSignal<PhonePairingStatus>({ devices: [], pending: [] })
  const [busy, setBusy] = createSignal(false)
  const [notice, setNotice] = createSignal<{ text: string; tone: Tone } | null>(null)
  const [details, setDetails] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  const [speeds, setSpeeds] = createSignal<Record<string, number>>({})
  const [received, setReceived] = createSignal<{ name: string; peer: string } | null>(null)
  let fileInput: HTMLInputElement | undefined
  let folderInput: HTMLInputElement | undefined
  let disposed = false
  let refreshing = false

  /* ------------------------------------------------------------------ data */

  const files = () => transfer().files
  const phones = (): PairedPhone[] => pairing().devices.filter(device => device.online)
  const peers = (): NearbyPeer[] => nearby().peers ?? []
  const nearbyTransfers = (): NearbyTransfer[] => nearby().transfers ?? []
  const pendingPair = () => pairing().pending[0]
  const uploading = () => uploads().filter(item => !item.error)
  const failedUploads = () => uploads().filter(item => item.error)
  const total = () => files().reduce((sum, file) => sum + file.size, 0)
  const remaining = () => Math.max(0, Math.ceil(((transfer().expiresAt ?? 0) - now()) / 60000))

  const inProgress = createMemo(() => nearbyTransfers().filter(item => liveStatus(item)))
  const recent = createMemo(() => nearbyTransfers().filter(item => !liveStatus(item)).reverse().slice(0, 5))
  const activeNearby = createMemo(() => nearbyTransfers().filter(item => item.status === 'active' || item.status === 'waiting'))
  const sending = () => uploading().length > 0 || activeNearby().length > 0
  const hasWork = () => files().length > 0 || uploads().length > 0 || nearbyTransfers().length > 0

  /** One number for the hub ring: everything moving right now, by bytes. */
  const overall = createMemo(() => {
    const moving = uploading()
    if (moving.length) return percentOf(moving.reduce((sum, item) => sum + item.loaded, 0), moving.reduce((sum, item) => sum + item.total, 0))
    const live = nearbyTransfers().filter(item => item.status === 'active')
    return live.length ? percentOf(live.reduce((sum, item) => sum + item.bytes, 0), live.reduce((sum, item) => sum + item.total, 0)) : 0
  })
  const overallSpeed = () => {
    const map = speeds()
    return uploading().reduce((sum, item) => sum + (map[item.id] ?? 0), 0) + nearbyTransfers().filter(item => item.status === 'active').reduce((sum, item) => sum + (map[`n:${item.id}`] ?? 0), 0)
  }
  const movingCount = () => uploading().length + activeNearby().length

  // Status polls hand back fresh objects every time; keep one Bubble per device so they do not re-pop on every refresh.
  const bubbleCache = new Map<string, Bubble>()
  const bubbles = createMemo<Bubble[]>(() => {
    const next: Bubble[] = [
      ...phones().map(device => ({ id: `phone:${device.id}`, name: device.name, kind: 'phone' as const, connected: true })),
      ...peers().map(peer => ({ id: `peer:${peer.id}`, name: peer.name, kind: deviceKind(peer.name), connected: false, peer })),
    ].map(item => { const kept = bubbleCache.get(item.id); if (kept) return Object.assign(kept, item); bubbleCache.set(item.id, item); return item })
    for (const id of [...bubbleCache.keys()]) if (!next.some(item => item.id === id)) bubbleCache.delete(id)
    return next
  })
  const shown = () => bubbles().slice(0, MAX_BUBBLES)
  const hidden = () => Math.max(0, bubbles().length - MAX_BUBBLES)

  const nearbyProblem = () => {
    const text = nearby().detail
    return !nearby().running && text && text !== 'Nearby is stopped.' ? text : null
  }
  const banner = createMemo<{ text: string; tone: Tone; retry?: 'session' | 'nearby' } | null>(() => {
    const flash = notice()
    if (flash) return flash
    if (transfer().error) return { text: transfer().error!, tone: 'error', retry: 'session' }
    const problem = nearbyProblem()
    return problem ? { text: problem, tone: 'error', retry: 'nearby' } : null
  })

  const state = (): BeamState => {
    if (sending()) return 'sending'
    if (received()) return 'received'
    if (banner()?.tone === 'error') return 'error'
    if (bubbles().length) return 'connected'
    if (transfer().active || nearby().running) return 'scanning'
    return 'idle'
  }
  const showQr = () => !sending() && transfer().active && !!transfer().qrDataUrl && phones().length === 0
  const lively = () => state() === 'scanning' || state() === 'sending' || state() === 'connected' || (showQr() && state() !== 'error')

  const caption = createMemo<{ title: string; hint: string }>(() => {
    const fileCount = files().length
    switch (state()) {
      case 'sending': {
        const count = movingCount()
        const speed = formatSpeed(overallSpeed())
        return { title: `Sending ${count} ${count === 1 ? 'file' : 'files'}`, hint: [`${overall()}%`, speed].filter(Boolean).join(' · ') }
      }
      case 'received': return { title: 'Received', hint: `${received()!.name} from ${received()!.peer}. Saved to Downloads.` }
      case 'error': return { title: 'Beam hit a snag', hint: 'Fix the message above, then try again.' }
      case 'connected': {
        const phone = phones()[0]
        const nearbyCount = peers().length
        if (phone && !nearbyCount) return { title: phone.name, hint: 'Connected. Files you add show up on this phone.' }
        return { title: nearbyCount === 1 ? '1 device nearby' : `${bubbles().length} devices nearby`, hint: fileCount ? `Tap a device to send ${fileCount === 1 ? 'your file' : `your ${fileCount} files`}.` : 'Add files, then tap a device to send them.' }
      }
      case 'scanning':
        if (transfer().active && showQr()) return { title: 'Scan to connect', hint: nearby().running ? 'Or wait for a nearby device to appear.' : 'Open your phone camera on the same Wi-Fi.' }
        return { title: 'Looking for devices', hint: 'Open LocalSend on another device on this network.' }
      default: return { title: 'Ready to beam', hint: 'Drop files anywhere here, or choose them to start.' }
    }
  })

  const subtitle = () => {
    if (sending()) return `Sending ${movingCount()} ${movingCount() === 1 ? 'file' : 'files'}`
    if (files().length) return `${files().length} ${files().length === 1 ? 'file' : 'files'} · ${formatBytes(total())} ready to share`
    if (transfer().active) return 'Session is on. Scan the code with your phone.'
    return 'Send files to your phone or a nearby device.'
  }

  /* ------------------------------------------------------------- behaviour */

  const flash = (text: string, tone: Tone = 'info') => setNotice({ text, tone })
  createEffect(() => {
    const current = notice()
    if (!current) return
    const timer = setTimeout(() => setNotice(null), current.tone === 'error' ? 9000 : 5000)
    onCleanup(() => clearTimeout(timer))
  })
  createEffect(() => {
    if (!received()) return
    const timer = setTimeout(() => setReceived(null), 8000)
    onCleanup(() => clearTimeout(timer))
  })
  // Failed uploads stay visible long enough to read, then clear themselves.
  createEffect(() => {
    if (!failedUploads().length) return
    const timer = setTimeout(dismissFailedUploads, 10000)
    onCleanup(() => clearTimeout(timer))
  })

  // Speeds come from how fast the byte counts grow, so they need no extra data from the backend.
  const tracker = createSpeedTracker()
  createEffect(() => {
    const at = Date.now()
    const next: Record<string, number> = {}
    for (const item of uploading()) next[item.id] = tracker.sample(item.id, item.loaded, at)
    for (const item of nearbyTransfers()) if (item.status === 'active') next[`n:${item.id}`] = tracker.sample(`n:${item.id}`, item.bytes, at)
    tracker.keep(Object.keys(next))
    setSpeeds(next)
  })

  // A transfer that finishes while Beam is open earns a short "Received" moment; ones that were already done do not.
  const seenStatus = new Map<string, string>()
  let firstSnapshot = true
  createEffect(() => {
    const list = nearbyTransfers()
    for (const item of list) {
      const before = seenStatus.get(item.id)
      if (!firstSnapshot && item.direction === 'receive' && item.status === 'done' && before !== 'done') setReceived({ name: item.fileName, peer: item.peer })
      seenStatus.set(item.id, item.status)
    }
    firstSnapshot = false
  })

  async function refresh() {
    if (refreshing || disposed) return
    refreshing = true
    try {
      await refreshTransfer()
      const status = await cmd.transferPairingStatus()
      if (!disposed) setPairing(status)
    } catch { /* Retain last known devices during shutdown. */ }
    finally { refreshing = false }
  }
  async function action(fn: () => Promise<unknown>) {
    if (busy()) return
    setBusy(true); setNotice(null)
    try { await fn(); await refresh() }
    catch (error) { flash(error instanceof Error ? error.message : String(error), 'error') }
    finally { setBusy(false) }
  }
  async function add(picked: File[]) {
    for (const file of picked) {
      try { await transferUpload(file) }
      catch (error) { flash(`${file.name}: ${error instanceof Error ? error.message : String(error)}`, 'error') }
    }
    await refresh()
  }
  async function toggleSession() {
    await action(async () => { const error = transfer().active ? await stopTransfer() : await startTransfer(); if (error) throw new Error(error) })
  }
  async function toggleNearby() {
    await action(async () => { if (nearby().running) await stopNearby(); else await startNearby() })
  }
  async function sendTo(peer: NearbyPeer) {
    if (!files().length) { flash('Add files first, then tap a device to send them.'); return }
    await action(async () => {
      const paths = await cmd.transferBucketPaths()
      const error = await sendNearby(peer.id, paths)
      if (error) throw new Error(error)
      flash(`Sending to ${peer.name}. They will be asked to accept.`)
    })
  }
  async function decide(item: NearbyTransfer, approved: boolean) {
    await action(async () => {
      const error = await approveNearby(item.id, approved)
      if (error) throw new Error(error)
    })
  }
  const pick = (folder: boolean, input: HTMLInputElement) => {
    const chosen = input.files
    if (chosen) void (folder ? filesFromPicker(chosen) : Promise.resolve(Array.from(chosen))).then(add).catch(error => flash(String(error), 'error'))
    input.value = ''
  }

  onMount(() => {
    void refresh()
    let unsubscribe: (() => void) | undefined
    void subscribeNearby().then(fn => { if (disposed) fn(); else unsubscribe = fn })
    const timer = window.setInterval(() => { setNow(Date.now()); if (open()) void refresh() }, 2500)
    onCleanup(() => { disposed = true; clearInterval(timer); unsubscribe?.() })
  })

  /* ----------------------------------------------------------------- views */

  const speedOf = (key: string) => formatSpeed(speeds()[key])
  const etaOf = (key: string, left: number) => { const speed = speeds()[key]; return speed && speed >= 1024 ? formatRemaining(left / speed) : '' }

  const UploadRow = (props: { item: TransferUploadProgress }) => {
    const percent = () => percentOf(props.item.loaded, props.item.total)
    return <li class="beam__row" classList={{ 'is-error': !!props.item.error }}>
      <Ring value={props.item.error ? 100 : percent()} tone={props.item.error ? 'red' : 'blue'} label={`${props.item.error ? 'Failed' : 'Adding'} ${props.item.name}`}>
        {props.item.error ? <X size={14} strokeWidth={2.4}/> : <ArrowUp size={14} strokeWidth={2.2}/>}
      </Ring>
      <div class="beam__row-text">
        <strong title={props.item.name}>{props.item.name}</strong>
        <Show when={props.item.error} fallback={<small>{[`${formatBytes(props.item.loaded)} of ${formatBytes(props.item.total)}`, speedOf(props.item.id), etaOf(props.item.id, props.item.total - props.item.loaded)].filter(Boolean).join(' · ')}</small>}>
          <small class="beam__row-error">{props.item.error}</small>
        </Show>
      </div>
      <Show when={props.item.error} fallback={<span class="beam__row-status">{percent()}%</span>}>
        <button class="beam__mini" onClick={dismissFailedUploads}>Dismiss</button>
      </Show>
    </li>
  }

  const NearbyRow = (props: { item: NearbyTransfer }) => {
    const item = () => props.item
    const percent = () => item().total ? percentOf(item().bytes, item().total) : item().status === 'done' ? 100 : 0
    const bad = () => failedStatus(item())
    const key = () => `n:${item().id}`
    const arrow = () => item().direction === 'receive' ? <ArrowDown size={14} strokeWidth={2.2}/> : <ArrowUp size={14} strokeWidth={2.2}/>
    const meta = () => {
      const t = item()
      if (t.status === 'pending') return `${t.peer} wants to send this to you`
      if (t.status === 'waiting') return `Waiting for ${t.peer} to accept`
      if (t.status === 'active') return [t.peer, `${formatBytes(t.bytes)}${t.total ? ` of ${formatBytes(t.total)}` : ''}`, speedOf(key()), etaOf(key(), t.total - t.bytes)].filter(Boolean).join(' · ')
      if (t.status === 'rejected') return `${t.peer} declined`
      if (t.status === 'expired') return `${t.peer} did not respond`
      if (bad()) return [t.peer, failReason(t) || 'The transfer stopped. Try again.'].join(' · ')
      return [t.peer, formatBytes(t.total || t.bytes)].join(' · ')
    }
    return <li class="beam__row" classList={{ 'is-error': bad(), 'is-done': item().status === 'done' }}>
      <Ring value={bad() || item().status === 'done' ? 100 : percent()} tone={bad() ? 'red' : item().status === 'done' ? 'green' : liveStatus(item()) && item().status !== 'active' ? 'idle' : 'blue'} label={`${item().fileName} transfer`}>
        {item().status === 'done' ? <Check size={14} strokeWidth={2.6}/> : bad() ? <X size={14} strokeWidth={2.4}/> : arrow()}
      </Ring>
      <div class="beam__row-text">
        <strong title={item().fileName}>{item().fileName}</strong>
        <small classList={{ 'beam__row-error': bad() }}>{meta()}</small>
        <Show when={item().status === 'pending'}>
          <span class="beam__approval">
            <button class="beam__mini beam__mini--primary" disabled={busy()} onClick={() => void decide(item(), true)}>Accept</button>
            <button class="beam__mini" disabled={busy()} onClick={() => void decide(item(), false)}>Decline</button>
          </span>
        </Show>
      </div>
      <span class="beam__row-status" classList={{ 'is-done': item().status === 'done', 'is-error': bad() }}>
        {item().status === 'active' ? `${percent()}%`
          : item().status === 'done' ? (item().direction === 'receive' ? 'Received' : 'Sent')
          : item().status === 'rejected' ? 'Declined' : item().status === 'expired' ? 'Expired' : bad() ? 'Failed' : ''}
      </span>
    </li>
  }

  const Bubbles = () => <For each={shown()}>{(bubble, index) => {
    const angle = () => (SPREAD[shown().length] ?? SPREAD[MAX_BUBBLES])[index()] * Math.PI / 180
    const busyWith = () => bubble.peer ? nearbyTransfers().find(item => item.peer === bubble.peer!.name && (item.status === 'active' || item.status === 'waiting')) : undefined
    const inner = () => <>
      <span class="beam__bubble-avatar" data-kind={bubble.kind} data-connected={bubble.connected}>
        <Show when={busyWith()}>{transferItem => <Ring size="lg" value={percentOf(transferItem().bytes, transferItem().total)} label={`Sending to ${bubble.name}`}/>}</Show>
        <DeviceIcon kind={bubble.kind}/>
        <Show when={bubble.connected}><span class="beam__bubble-check" aria-hidden="true"><Check size={10} strokeWidth={3.2}/></span></Show>
      </span>
      <span class="beam__bubble-name">{bubble.name}</span>
    </>
    const style = () => `--dx:${Math.cos(angle()).toFixed(3)};--dy:${Math.sin(angle()).toFixed(3)};--i:${index()}`
    return <Show when={bubble.peer} fallback={<div class="beam__bubble" style={style()} title={`${bubble.name} is connected. Files in Beam appear on this phone.`}>{inner()}</div>}>
      {peer => <button class="beam__bubble" style={style()} disabled={busy()} aria-label={`Send files to ${bubble.name}`} title={files().length ? `Send ${files().length} ${files().length === 1 ? 'file' : 'files'} to ${bubble.name}` : 'Add files first'}
        onClick={() => void sendTo(peer())}>{inner()}</button>}
    </Show>
  }}</For>

  const Stage = () => <section class="beam__card beam__stage" aria-label="Devices">
    <button class="beam__chip" classList={{ 'is-on': nearby().running }} aria-pressed={nearby().running} disabled={busy()} title={nearby().running ? `Visible to nearby devices as ${nearby().deviceName || 'this PC'}. Tap to stop.` : 'Find nearby devices with LocalSend'} onClick={() => void toggleNearby()}>
      <Radio size={13} strokeWidth={2}/><span>{nearby().running ? 'Nearby on' : 'Find nearby'}</span>
    </button>
    <div class="beam__zone">
      <div class="beam__radar" classList={{ 'is-live': lively() }}>
        <i aria-hidden="true"/><i aria-hidden="true"/><i aria-hidden="true"/><b aria-hidden="true"/><b aria-hidden="true"/>
        <div class="beam__hub">
          <Switch>
            <Match when={sending()}>
              <Ring size="lg" value={overall()} label="Overall progress"><span class="beam__hub-percent">{overall()}</span></Ring>
            </Match>
            <Match when={showQr()}>
              <div class="beam__qr-card"><img class="beam__qr" src={transfer().qrDataUrl!} alt="Scan to connect your phone to Beam"/></div>
            </Match>
            <Match when={state() === 'received'}><button class="beam__disc beam__disc--ok" tabIndex={-1} onClick={() => setReceived(null)}><Check size={30} strokeWidth={2.4}/></button></Match>
            <Match when={true}>
              <button class="beam__disc" tabIndex={-1} onClick={() => fileInput?.click()} title="Choose files"><Upload size={28} strokeWidth={1.75}/></button>
            </Match>
          </Switch>
        </div>
        <Bubbles/>
        <Show when={hidden() > 0}><span class="beam__more">+{hidden()}</span></Show>
      </div>
    </div>
    <div class="beam__caption" aria-live="polite">
      <strong>{caption().title}</strong>
      <span>{caption().hint}</span>
      <Show when={transfer().active && !sending()}>
        <div class="beam__caption-actions">
          <button class="beam__pill beam__pill--blue" onClick={() => void action(async () => { await navigator.clipboard.writeText(transfer().phoneUrl!); flash('Link copied') })}><Copy size={13}/> Copy link</button>
          <small>{remaining()} min left</small>
        </div>
      </Show>
    </div>
  </section>

  const Transfers = () => <section class="beam__card beam__list-card" aria-label="Files and transfers">
    <div class="beam__list">
      <Show when={inProgress().length || uploads().length}>
        <h3>In progress</h3>
        <ul>
          <For each={inProgress()}>{item => <NearbyRow item={item}/>}</For>
          <For each={uploads()}>{item => <UploadRow item={item}/>}</For>
        </ul>
      </Show>
      <Show when={files().length}>
        <h3>Ready to share</h3>
        <ul>
          <For each={files()}>{file => <li class="beam__row beam__row--file"><FileGlyph name={file.name}/><div class="beam__row-text"><strong title={file.name}>{file.name}</strong><small>{formatBytes(file.size)}</small></div><Check class="beam__saved" size={15} aria-label="Saved on this PC"/></li>}</For>
        </ul>
      </Show>
      <Show when={recent().length}>
        <h3>Recent</h3>
        <ul><For each={recent()}>{item => <NearbyRow item={item}/>}</For></ul>
      </Show>
    </div>
    <footer class="beam__foot">{transfer().active ? `Session closes in ${remaining()} min. Files stay on this PC.` : 'Files stay on this PC.'}</footer>
  </section>

  const Details = () => <div class="beam__details">
    <section class="beam__card beam__connect">
      <h3>Connect a phone</h3>
      <Show when={transfer().active && transfer().qrDataUrl} fallback={<>
        <p>Start a session to get a code. Your phone scans it on the same Wi-Fi, then you approve it here.</p>
        <button class="beam__pill beam__pill--blue" disabled={busy()} onClick={() => void toggleSession()}><Power size={13}/> Start session</button>
      </>}>
        <div class="beam__connect-qr"><div class="beam__qr-card"><img class="beam__qr" src={transfer().qrDataUrl!} alt="Scan to connect your phone to Beam"/></div></div>
        <Show when={transfer().phoneUrl}><code>{transfer().phoneUrl}</code></Show>
        <button class="beam__pill beam__pill--blue" onClick={() => void action(async () => { await navigator.clipboard.writeText(transfer().phoneUrl!); flash('Link copied') })}><Copy size={13}/> Copy link</button>
      </Show>
    </section>
    <section class="beam__card beam__facts">
      <h3>Phones</h3>
      <ul>
        <For each={pairing().devices}>{device => <li class="beam__row"><span class="beam__bubble-avatar beam__bubble-avatar--sm" data-kind="phone"><Smartphone size={16}/></span><div class="beam__row-text"><strong>{device.name}</strong><small classList={{ 'is-online': device.online }}>{device.online ? 'Connected' : 'Remembered'}</small></div><button class="beam__mini" disabled={busy()} aria-label={`Forget ${device.name}`} onClick={() => void action(() => cmd.transferPairingRemove(device.id))}>Forget</button></li>}</For>
      </ul>
      <Show when={!pairing().devices.length}><p class="beam__quiet">No remembered phones yet.</p></Show>
      <h3>Good to know</h3>
      <p>Transfers stay on your network and need your approval here. Files can be up to {formatBytes(transfer().maxFileBytes)}. Folders become ZIP files.</p>
      <Show when={transfer().active}><p>This session closes in {remaining()} min.</p></Show>
    </section>
  </div>

  return <section class="beam phone-bucket phone-bucket__drop" classList={{ 'beam--dragging': dragging() }} data-state={state()} aria-label="Phone file bucket" data-no-drag
    onDragOver={event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); setDragging(true) } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false) }}
    onDrop={event => { if (!event.dataTransfer?.types.includes('Files')) return; event.preventDefault(); event.stopPropagation(); setDragging(false); void filesFromDrop(event.dataTransfer).then(add).catch(error => flash(String(error), 'error')) }}>
    <input class="beam__input" type="file" multiple tabIndex={-1} aria-label="Choose files" ref={element => { fileInput = element }} onChange={event => pick(false, event.currentTarget)}/>
    <input class="beam__input" type="file" multiple tabIndex={-1} aria-label="Choose folder" ref={element => { folderInput = element; element.setAttribute('webkitdirectory', '') }} onChange={event => pick(true, event.currentTarget)}/>

    <header class="beam__header">
      <div class="beam__titles"><h2>Beam</h2><span>{subtitle()}</span></div>
      <div class="beam__tools">
        <button class="beam__pill" title="Add files" onClick={() => fileInput?.click()}><Plus size={15}/><span class="beam__label">Add files</span></button>
        <button class="beam__pill" title="Add a folder as a ZIP" onClick={() => folderInput?.click()}><FolderOpen size={14}/><span class="beam__label">Folder</span></button>
        <span class="beam__sep" aria-hidden="true"/>
        <Show when={files().length > 0}><button class="beam__round" aria-label="Open saved files" title="Open saved files" onClick={() => void action(() => cmd.transferOpenFolder())}><FolderOpen size={16}/></button></Show>
        <button class="beam__round" aria-label={details() ? 'Back to files' : 'Connection details'} title={details() ? 'Back to files' : 'Connection details'} aria-pressed={details()} onClick={() => setDetails(!details())}>{details() ? <ArrowLeft size={16}/> : <Info size={16}/>}</button>
        <button class="beam__round" classList={{ 'is-on': transfer().active }} disabled={busy()} aria-label={transfer().active ? 'Stop session' : 'Start session'} title={transfer().active ? 'Stop session' : 'Start session'} onClick={() => void toggleSession()}><Power size={16}/></button>
      </div>
    </header>

    <Show when={pendingPair()}>{request => <div class="beam__banner beam__banner--pair" role="status">
      <span class="beam__bubble-avatar beam__bubble-avatar--sm" data-kind="phone"><Smartphone size={16}/></span>
      <div class="beam__banner-text"><strong>{request().name} wants to connect</strong><span>Check that the code matches: <b>{request().code}</b></span></div>
      <button class="beam__pill beam__pill--solid" disabled={busy()} onClick={() => void action(() => cmd.transferPairingDecide(request().id, true))}>Allow</button>
      <button class="beam__round beam__round--sm" aria-label="Decline pairing" disabled={busy()} onClick={() => void action(() => cmd.transferPairingDecide(request().id, false))}><X size={14}/></button>
    </div>}</Show>
    <Show when={banner()}>{item => <div class="beam__banner" classList={{ 'beam__banner--error': item().tone === 'error' }} role={item().tone === 'error' ? 'alert' : 'status'}>
      <Show when={item().tone === 'error'} fallback={<Check size={16}/>}><CircleAlert size={16}/></Show>
      <div class="beam__banner-text"><span>{item().text}</span></div>
      <Show when={item().tone === 'error' && item().retry}>{retry => <button class="beam__pill" disabled={busy()} onClick={() => void (retry() === 'nearby' ? toggleNearby() : action(async () => { const error = await startTransfer(); if (error) throw new Error(error) }))}>Try again</button>}</Show>
      <button class="beam__round beam__round--sm" aria-label="Dismiss message" onClick={() => setNotice(null)}><X size={14}/></button>
    </div>}</Show>

    <Show when={!details()} fallback={<Details/>}>
      <div class="beam__body" data-layout={hasWork() ? 'split' : 'solo'}>
        <Stage/>
        <Show when={hasWork()}><Transfers/></Show>
      </div>
    </Show>

    <Show when={dragging()}><div class="beam__drop" aria-hidden="true"><span class="beam__drop-icon"><Upload size={28} strokeWidth={1.75}/></span><strong>Drop to beam</strong><span>Files go to your phone and nearby devices.</span></div></Show>
  </section>
}
