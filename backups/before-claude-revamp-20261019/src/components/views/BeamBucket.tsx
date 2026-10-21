import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { ArrowLeft, ArrowRight, Check, Copy, File, FolderOpen, Info, LoaderCircle, Plus, Power, Smartphone, Upload, X } from 'lucide-solid'
import { cmd, type PhonePairingStatus } from '../../lib/ipc'
import { filesFromDrop, filesFromPicker } from '../../lib/droppedFiles'
import { refreshTransfer, startTransfer, stopTransfer, transfer, transferUpload, uploads } from '../../state/transfer'
import { open } from '../../state/ui'
import './BeamBucket.css'

const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`

export default function BeamBucket() {
  const [pairing, setPairing] = createSignal<PhonePairingStatus>({ devices: [], pending: [] })
  const [busy, setBusy] = createSignal(false)
  const [notice, setNotice] = createSignal('')
  const [details, setDetails] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)
  const [page, setPage] = createSignal(0)
  const [capacity, setCapacity] = createSignal(4)
  const [now, setNow] = createSignal(Date.now())
  let list: HTMLDivElement | undefined
  let listObserver: ResizeObserver | undefined
  let disposed = false
  let refreshing = false
  const pages = () => Math.max(1, Math.ceil(transfer().files.length / capacity()))
  const visibleFiles = createMemo(() => transfer().files.slice(page() * capacity(), (page() + 1) * capacity()))
  const online = () => pairing().devices.filter(device => device.online)
  const pending = () => pairing().pending[0]
  const total = () => transfer().files.reduce((sum, file) => sum + file.size, 0)
  const activeUpload = () => uploads().find(item => !item.error)
  const remaining = () => Math.max(0, Math.ceil(((transfer().expiresAt ?? 0) - now()) / 60000))
  createEffect(() => { if (page() >= pages()) setPage(pages() - 1) })
  createEffect(() => { if (!notice()) return; const timer = setTimeout(() => setNotice(''), 6000); onCleanup(() => clearTimeout(timer)) })

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
    setBusy(true); setNotice('')
    try { await fn(); await refresh() }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  async function add(files: File[]) {
    for (const file of files) {
      try { await transferUpload(file) }
      catch (error) { setNotice(`${file.name}: ${String(error)}`) }
    }
    await refresh()
  }
  const choose = (folder = false) => <label class="beam__add" title={folder ? 'Add a folder as a ZIP' : 'Add files'}>
    {folder ? <FolderOpen size={15}/> : <Plus size={16}/>}<span>{folder ? 'Folder' : 'Add files'}</span>
    <input aria-label={folder ? 'Choose folder' : 'Choose files'} type="file" multiple ref={element => { if (folder) element.setAttribute('webkitdirectory', '') }} onChange={event => {
      const files = event.currentTarget.files
      if (files) void (folder ? filesFromPicker(files) : Promise.resolve(Array.from(files))).then(add).catch(error => setNotice(String(error)))
      event.currentTarget.value = ''
    }}/>
  </label>
  onMount(() => {
    void refresh()
    const observer = new ResizeObserver(() => { if (list) setCapacity(Math.max(1, Math.floor(list.clientHeight / 48))) })
    listObserver = observer
    if (list) observer.observe(list)
    const timer = window.setInterval(() => { setNow(Date.now()); if (open()) void refresh() }, 2500)
    onCleanup(() => { disposed = true; clearInterval(timer); observer.disconnect() })
  })

  return <section class="beam" classList={{ 'beam--dragging': dragging() }} aria-label="Phone file bucket" data-no-drag
    onDragOver={event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); setDragging(true) } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false) }}
    onDrop={event => { if (!event.dataTransfer?.types.includes('Files')) return; event.preventDefault(); event.stopPropagation(); setDragging(false); void filesFromDrop(event.dataTransfer).then(add).catch(error => setNotice(String(error))) }}>
    <header class="beam__header">
      <div><h2>Beam</h2><span>{transfer().active ? `${transfer().files.length} ${transfer().files.length === 1 ? 'file' : 'files'} · ${bytes(total())}` : 'A little closer, wirelessly.'}</span></div>
      <div class="beam__tools">
        <Show when={transfer().files.length > 0}><button aria-label="Open saved files" title="Open saved files" onClick={() => void action(() => cmd.transferOpenFolder())}><FolderOpen size={17}/></button></Show>
        <button aria-label={details() ? 'Back to files' : 'Connection details'} aria-pressed={details()} onClick={() => setDetails(!details())}>{details() ? <ArrowLeft size={17}/> : <Info size={17}/>}</button>
        <button disabled={busy()} aria-label={transfer().active ? 'Stop session' : 'Start session'} title={transfer().active ? 'Stop session' : 'Start session'} onClick={() => void action(async () => { const error = transfer().active ? await stopTransfer() : await startTransfer(); if (error) throw new Error(error) })}><Power size={17}/></button>
      </div>
    </header>
    <Show when={notice() || transfer().error}><div class="beam__notice" role="status">{notice() || transfer().error}</div></Show>
    <Show when={pending()}>{request => <div class="beam__pair" role="status"><Smartphone size={18}/><div><strong>{request().name}</strong><span>Match code <b>{request().code}</b></span></div><button disabled={busy()} onClick={() => void action(() => cmd.transferPairingDecide(request().id, true))}>Allow</button><button aria-label="Decline pairing" disabled={busy()} onClick={() => void action(() => cmd.transferPairingDecide(request().id, false))}><X size={15}/></button></div>}</Show>
    <Show when={!details()} fallback={<div class="beam__details">
      <h3>Your connection</h3><p>Scan on the same Wi-Fi, then approve the matching code here. Remembered phones can return using their saved page while Beam is running.</p>
      <For each={pairing().devices}>{device => <div class="beam__device"><Smartphone size={18}/><strong>{device.name}</strong><span>{device.online ? 'Connected' : 'Remembered'}</span><button disabled={busy()} onClick={() => void action(() => cmd.transferPairingRemove(device.id))} aria-label={`Forget ${device.name}`}>Forget</button></div>}</For>
      <Show when={!pairing().devices.length}><p>No remembered phones yet.</p></Show>
      <p>Session closes in {remaining()} min. Local transfers use HTTP and require device approval. Up to {bytes(transfer().maxFileBytes)} per file; folders become ZIP files.</p>
      <Show when={transfer().phoneUrl}><code>{transfer().phoneUrl}</code></Show>
    </div>}>
      <div class="beam__body">
        <aside class="beam__connect">
          <Show when={transfer().active && transfer().qrDataUrl} fallback={<div class="beam__pair-art" aria-hidden="true"><Upload size={34}/></div>}>
            <img class="beam__qr" src={transfer().qrDataUrl!} alt="Scan to connect your phone to Beam"/>
          </Show>
          <strong>{online().length ? online()[0].name : transfer().active ? 'Scan to connect' : 'Ready when you are'}</strong>
          <span>{online().length ? 'Open Beam on your phone to save files.' : transfer().active ? 'Same Wi-Fi. One quick scan.' : 'Add files to open a private session.'}</span>
          <Show when={transfer().active}><button class="beam__copy" onClick={() => void action(async () => { await navigator.clipboard.writeText(transfer().phoneUrl!); setNotice('Link copied') })}><Copy size={13}/> Copy link</button><small>{remaining()} min remaining</small></Show>
        </aside>
        <div class="beam__bucket">
          <div class="beam__bucket-head"><strong>{activeUpload() ? 'Adding to Beam…' : transfer().files.length ? 'Ready to share' : 'Your files go here'}</strong><div>{choose()}{choose(true)}</div></div>
          <div class="beam__list" ref={node => { listObserver?.disconnect(); list = node; listObserver?.observe(node) }}>
            <Show when={transfer().files.length} fallback={<div class="beam__empty"><span class="beam__empty-icon"><Upload size={29}/></span><strong>{dragging() ? 'Release to add' : 'Drop files or folders'}</strong><span>Send either way. No cables.</span></div>}>
              <For each={visibleFiles()}>{file => <div class="beam__file"><span class="beam__file-icon"><File size={18}/></span><strong title={file.name}>{file.name}</strong><small>{bytes(file.size)}</small><Check size={14} aria-label="Saved on this PC"/></div>}</For>
            </Show>
          </div>
          <footer class="beam__footer">
            <Show when={activeUpload()} fallback={<span>{transfer().files.length ? 'Available on connected phones' : 'Files stay on this PC'}</span>}>{item => <div class="beam__progress"><LoaderCircle size={13}/><span>{item().name}</span><progress max={Math.max(1, item().total)} value={item().loaded}/></div>}</Show>
            <Show when={pages() > 1}><nav aria-label="Bucket file pages"><button aria-label="Previous files" disabled={page() === 0} onClick={() => setPage(page() - 1)}><ArrowLeft size={14}/></button><span>{page() + 1}/{pages()}</span><button aria-label="Next files" disabled={page() + 1 >= pages()} onClick={() => setPage(page() + 1)}><ArrowRight size={14}/></button></nav></Show>
          </footer>
        </div>
      </div>
    </Show>
  </section>
}
