import { For, onCleanup, onMount, Show, createMemo, createSignal } from 'solid-js'
import { ArrowDown, ArrowUp, Check, CheckCheck, Clock, Copy, FileArchive, FileText, Film, FolderOpen, Image, LoaderCircle, Monitor, Music, Power, Radio, RefreshCw, Send, Smartphone, Upload, X } from 'lucide-solid'
import { cmd, type NearbyPeer, type NearbyTransfer, type TransferFile } from '../../lib/ipc'
import {
  nearby,
  refreshNearby,
  approveNearby,
  startNearby,
  stopNearby,
  subscribeNearby,
} from '../../state/nearby'
import { refreshTransfer, startTransfer, stopTransfer, transfer, transferUpload, uploads } from '../../state/transfer'
import { filesFromDrop, filesFromPicker } from '../../lib/droppedFiles'
import './NearbyView.css'
import './NearbyPolish.css'

const TRANSFER_TTL_MS = 30 * 60 * 1000

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  const digits = value >= 10 || i === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[i]}`
}

function percent(t: NearbyTransfer): number {
  if (!t.total) return t.status === 'done' ? 100 : 0
  return Math.max(0, Math.min(100, Math.round((t.bytes / t.total) * 100)))
}

type FileKind = 'image' | 'video' | 'audio' | 'archive' | 'document' | 'other'

const KIND_LABELS: Record<FileKind, string> = {
  image: 'Photos',
  video: 'Videos',
  audio: 'Audio',
  archive: 'Archives',
  document: 'Documents',
  other: 'Files',
}
const KIND_ORDER: FileKind[] = ['image', 'video', 'audio', 'archive', 'document', 'other']

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function fileKind(name: string): FileKind {
  const ext = extensionOf(name)
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', 'avif', 'bmp', 'tif', 'tiff', 'svg'].includes(ext)) return 'image'
  if (['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus'].includes(ext)) return 'audio'
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) return 'archive'
  if (['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'odt', 'ods'].includes(ext)) return 'document'
  return 'other'
}

function FileGlyph(props: { kind: FileKind; size?: number }) {
  const size = () => props.size ?? 17
  return (
    <Show when={props.kind === 'image'} fallback={
      <Show when={props.kind === 'video'} fallback={
        <Show when={props.kind === 'audio'} fallback={
          <Show when={props.kind === 'archive'} fallback={<FileText size={size()} />}>
            <FileArchive size={size()} />
          </Show>
        }><Music size={size()} /></Show>
      }><Film size={size()} /></Show>
    }><Image size={size()} /></Show>
  )
}

export default function NearbyView(props: { compact?: boolean }) {
  const [mode, setMode] = createSignal<'bucket' | 'nearby'>('bucket')
  const [selected, setSelected] = createSignal<string | null>(null)
  const [bucketDragging, setBucketDragging] = createSignal(false)
  const [notice, setNotice] = createSignal<string | null>(null)
  const [bucketNotice, setBucketNotice] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())

  const peers = (): NearbyPeer[] => nearby().peers ?? []
  const transfers = (): NearbyTransfer[] => nearby().transfers ?? []

  const selectedPeer = (): NearbyPeer | null => {
    const id = selected()
    if (!id) return null
    return peers().find((p) => p.id === id) ?? null
  }

  async function decideReceive(sessionId: string, approved: boolean): Promise<void> {
    setBusy(true)
    const error = await approveNearby(sessionId, approved)
    setBusy(false)
    setNotice(error ?? (approved ? 'Incoming transfer approved.' : 'Incoming transfer declined.'))
  }

  async function handleBucketFiles(files: FileList | File[]): Promise<void> {
    const entries = Array.from(files)
    if (!entries.length) return
    setBucketNotice(null)
    for (const file of entries) {
      try {
        await transferUpload(file)
      } catch (error) {
        setBucketNotice(error instanceof Error ? `${file.name}: ${error.message}` : String(error))
      }
    }
  }

  function onBucketDragOver(event: DragEvent): void {
    if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
      event.preventDefault()
      setBucketDragging(true)
    }
  }

  function onBucketDragLeave(): void { setBucketDragging(false) }

  function onBucketDrop(event: DragEvent): void {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    setBucketDragging(false)
    void filesFromDrop(event.dataTransfer)
      .then(handleBucketFiles)
      .catch((error) => setBucketNotice(error instanceof Error ? error.message : String(error)))
  }

  function onFolderPicked(files: FileList | null): void {
    if (!files?.length) return
    void filesFromPicker(files)
      .then(handleBucketFiles)
      .catch((error) => setBucketNotice(error instanceof Error ? error.message : String(error)))
  }

  async function copyPhoneLink(): Promise<void> {
    const url = transfer().phoneUrl
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setBucketNotice('Phone link copied. Open it on a device on the same Wi-Fi.')
    } catch {
      setBucketNotice(`Copy this link on your phone: ${url}`)
    }
  }

  onMount(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined

    void subscribeNearby().then((fn) => {
      if (disposed) fn()
      else unsubscribe = fn
    })
    void refreshTransfer()
    const refreshTimer = window.setInterval(() => void refreshTransfer(), 2500)
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1000)

    onCleanup(() => {
      disposed = true
      window.clearInterval(refreshTimer)
      window.clearInterval(clockTimer)
      unsubscribe?.()
    })
  })

  const detail = () => notice() ?? nearby().detail ?? null

  const bucket = () => transfer()
  const bucketUploads = () => uploads()
  const bucketPercent = (loaded: number, total: number) => total > 0 ? Math.min(100, Math.round(loaded / total * 100)) : 0
  const remainingMs = () => Math.max(0, (bucket().expiresAt ?? 0) - now())
  const countdown = () => {
    const total = Math.floor(remainingMs() / 1000)
    const minutes = Math.floor(total / 60)
    return `${minutes}:${String(total % 60).padStart(2, '0')}`
  }
  const countdownFraction = () => Math.max(0, Math.min(1, remainingMs() / TRANSFER_TTL_MS))
  const bucketUploading = () => bucketUploads().some((item) => !item.error)
  const bucketReady = () => bucket().active && bucket().files.length > 0 && !bucketUploading()
  const bucketStateTitle = () => bucketUploading()
    ? 'Beaming to your phone'
    : bucket().files.length ? 'Ready on your phone' : 'Waiting for files'
  const bucketStateHint = () => bucketUploading()
    ? 'Keep this open while files land in the bucket.'
    : bucket().files.length
      ? 'Scan the code, then download or send files back.'
      : 'Drop files here or onto the notch to get started.'

  const groups = createMemo(() => {
    const byKind = new Map<FileKind, TransferFile[]>()
    for (const file of bucket().files) {
      const kind = fileKind(file.name)
      const list = byKind.get(kind) ?? []
      list.push(file)
      byKind.set(kind, list)
    }
    return KIND_ORDER
      .filter((kind) => byKind.has(kind))
      .map((kind) => ({ kind, label: KIND_LABELS[kind], files: byKind.get(kind) ?? [] }))
  })

  const bucketPanel = () => (
    <section class="phone-bucket" aria-label="Phone file bucket">
      <div class="phone-bucket__intro">
        <div>
          <div class="phone-bucket__eyebrow"><Smartphone size={14} strokeWidth={1.8} /> PHONE ↔ PC</div>
          <h2>Nearby</h2>
          <p>Drop files on the notch — they land in the bucket, then scan to beam them to your phone.</p>
        </div>
        <div class="phone-bucket__actions">
        <Show when={bucket().active && bucket().files.length > 0}>
          <button type="button" class="nearby__icon-btn phone-bucket__folder" onClick={() => void cmd.transferOpenFolder().catch((error) => setBucketNotice(String(error)))} title="Open saved files" aria-label="Open saved files" data-no-drag>
            <FolderOpen size={15} />
          </button>
        </Show>
        <button
          type="button"
          class="nearby__btn"
          classList={{ 'nearby__btn--stop': bucket().active }}
          disabled={busy()}
          onClick={async () => {
            setBusy(true)
            setBucketNotice(null)
            try {
              if (bucket().active) await stopTransfer()
              else {
                const error = await startTransfer()
                if (error) setBucketNotice(error)
              }
            } finally { setBusy(false) }
          }}
          data-no-drag
        >
          <Power class="icon icon--sm" strokeWidth={1.75} aria-hidden="true" />
          {busy() ? 'Working…' : bucket().active ? 'Stop session' : 'Start session'}
        </button>
        </div>
      </div>

      <Show when={bucket().error || bucketNotice()}>
        <div class="phone-bucket__notice" classList={{ 'phone-bucket__notice--error': Boolean(bucket().error) }} role="status">{bucket().error ?? bucketNotice()}</div>
      </Show>

      <Show when={bucket().active} fallback={
        <div class="phone-bucket__inactive">
          <div class="nearby-pair-art" aria-hidden="true"><span class="nearby-pair-art__pc"><Monitor size={31}/></span><span class="nearby-pair-art__path">···</span><span class="nearby-pair-art__phone"><Smartphone size={27}/></span></div>
          <div class="phone-bucket__inactive-copy">
            <strong>Your files, within reach.</strong>
            <span>Drop files or folders here or on the notch. Folders arrive as ZIPs (up to 500 files, 95 MB).</span>
            <small>A private link, open for 30 minutes.</small>
          </div>
          <div
            class="phone-bucket__drop phone-bucket__drop--hero"
            classList={{ 'phone-bucket__drop--active': bucketDragging() }}
            onDragOver={onBucketDragOver}
            onDragLeave={onBucketDragLeave}
            onDrop={onBucketDrop}
            data-no-drag
          >
            <Upload size={20} strokeWidth={1.7} />
            <strong>{bucketDragging() ? 'Drop to start beaming' : 'Drop files to start'}</strong>
            <span>The session starts automatically when you drop.</span>
            <label class="phone-bucket__choose">
              <FolderOpen size={14} /> Choose files
              <input type="file" multiple onChange={(event) => {
                const files = event.currentTarget.files
                if (files) void handleBucketFiles(files)
                event.currentTarget.value = ''
              }} />
            </label>
            <label class="phone-bucket__choose">
              <FolderOpen size={14} /> Choose folder
              <input type="file" multiple ref={(element) => element.setAttribute('webkitdirectory', '')} onChange={(event) => {
                onFolderPicked(event.currentTarget.files)
                event.currentTarget.value = ''
              }} />
            </label>
          </div>
        </div>
      }>
        <div class="phone-bucket__grid">
          <div class="phone-bucket__qr-card" classList={{ 'phone-bucket__qr-card--ready': bucketReady() }}>
            <div class="phone-bucket__qr-wrap">
              <Show when={bucket().qrDataUrl} fallback={<div class="phone-bucket__qr-placeholder" />}>
                {(src) => <img class="phone-bucket__qr" src={src()} alt="Scan to open the temporary phone bucket" />}
              </Show>
              <span class="phone-bucket__qr-scan" aria-hidden="true" />
            </div>
            <span class="phone-bucket__qr-caption">Scan with your phone camera</span>
            <button type="button" class="phone-bucket__link" onClick={() => void copyPhoneLink()} data-no-drag>
              <Copy size={13} /> Copy link
            </button>
            <div class="phone-bucket__countdown" title="The phone link closes when the countdown ends">
              <Clock size={12} />
              <span>{countdown()} left</span>
              <div class="phone-bucket__countdown-track">
                <div class="phone-bucket__countdown-fill" classList={{ 'phone-bucket__countdown-fill--low': countdownFraction() <= 0.2 }} style={{ width: `${countdownFraction() * 100}%` }} />
              </div>
            </div>
            <span class="phone-bucket__url" title={bucket().phoneUrl ?? ''}>{bucket().phoneUrl}</span>
          </div>
          <div class="phone-bucket__work">
            <div class="phone-bucket__state" classList={{ 'phone-bucket__state--ready': bucketReady(), 'phone-bucket__state--busy': bucketUploading() }} role="status" aria-live="polite">
              <span class="phone-bucket__state-icon" aria-hidden="true">
                <Show when={bucketUploading()} fallback={
                  <Show when={bucketReady()} fallback={<Upload size={16} />}><CheckCheck size={16} /></Show>
                }><LoaderCircle class="phone-bucket__spin" size={16} /></Show>
              </span>
              <div>
                <strong>{bucketStateTitle()}</strong>
                <span>{bucketStateHint()}</span>
              </div>
            </div>

            <Show when={bucketUploads().length > 0}>
              <div class="phone-bucket__staging" aria-label="Files landing in the bucket">
                <For each={bucketUploads()}>{(item) => (
                  <div class="phone-bucket__stage" classList={{ 'phone-bucket__stage--fail': Boolean(item.error) }}>
                    <span class="phone-bucket__stage-thumb" aria-hidden="true">
                      <Show when={item.previewUrl} fallback={<FileGlyph kind={fileKind(item.name)} />}>
                        <img src={item.previewUrl} alt="" draggable={false} />
                      </Show>
                    </span>
                    <div class="phone-bucket__stage-main">
                      <div class="phone-bucket__stage-top">
                        <strong title={item.name}>{item.name}</strong>
                        <span>{item.error ? 'Failed' : `${bucketPercent(item.loaded, item.total)}%`}</span>
                      </div>
                      <div class="nearby__bar"><div class="nearby__bar-fill" classList={{ 'nearby__bar-fill--fail': Boolean(item.error) }} style={{ width: `${bucketPercent(item.loaded, item.total)}%` }} /></div>
                      <div class="phone-bucket__stage-meta">
                        <span>{formatBytes(item.total)}</span>
                        <Show when={item.error}><span class="phone-bucket__stage-error">{item.error}</span></Show>
                      </div>
                    </div>
                  </div>
                )}</For>
              </div>
            </Show>

            <div
              class="phone-bucket__drop"
              classList={{ 'phone-bucket__drop--active': bucketDragging(), 'phone-bucket__drop--slim': bucketUploads().length > 0 }}
              onDragOver={onBucketDragOver}
              onDragLeave={onBucketDragLeave}
              onDrop={onBucketDrop}
              data-no-drag
            >
              <Upload size={19} strokeWidth={1.7} />
              <strong>{bucketDragging() ? 'Drop to add to bucket' : 'Add more files'}</strong>
              <span>Files you add here can be downloaded from your phone.</span>
              <label class="phone-bucket__choose">
                <FolderOpen size={14} /> Choose files
                <input type="file" multiple onChange={(event) => {
                  const files = event.currentTarget.files
                  if (files) void handleBucketFiles(files)
                  event.currentTarget.value = ''
                }} />
              </label>
              <label class="phone-bucket__choose">
                <FolderOpen size={14} /> Choose folder
                <input type="file" multiple ref={(element) => element.setAttribute('webkitdirectory', '')} onChange={(event) => {
                  onFolderPicked(event.currentTarget.files)
                  event.currentTarget.value = ''
                }} />
              </label>
            </div>

            <div class="phone-bucket__limits">
              Expires in {countdown()} · up to {formatBytes(bucket().maxFileBytes)} per file · {formatBytes(bucket().maxBucketBytes)} total
              <span>Folder drops are zipped with their relative paths (500 files / 95 MB max).</span>
              <span>{bucket().saveFolder}</span>
            </div>
          </div>
        </div>

        <div class="phone-bucket__files-head">
          <span>In the bucket</span>
          <span>{bucket().files.length} {bucket().files.length === 1 ? 'file' : 'files'}</span>
        </div>
        <Show when={bucket().files.length > 0} fallback={
          <div class="phone-bucket__files-empty">
            <span class="phone-bucket__files-empty-glyph" aria-hidden="true"><Upload size={18} /></span>
            <div>
              <strong>Nothing in the bucket yet.</strong>
              <span>Add files from this PC, or scan the code and choose files on your phone.</span>
            </div>
          </div>
        }>
          <div class="phone-bucket__files">
            <For each={groups()}>{(group) => (
              <div class="phone-bucket__group">
                <div class="phone-bucket__group-title">
                  <FileGlyph kind={group.kind} size={12} />
                  <span>{group.label}</span>
                  <span class="phone-bucket__group-count">{group.files.length}</span>
                </div>
                <For each={group.files}>{(file) => (
                  <div class="phone-bucket__file">
                    <span class="phone-bucket__file-icon"><FileGlyph kind={fileKind(file.name)} /></span>
                    <div class="phone-bucket__file-info"><strong title={file.name}>{file.name}</strong><span>{formatBytes(file.size)}</span></div>
                    <span class="phone-bucket__saved"><Check size={13} /> On this PC</span>
                  </div>
                )}</For>
              </div>
            )}</For>
          </div>
        </Show>
        <div class="phone-bucket__security">Local Wi-Fi only · anyone with this link can access the bucket · stop the session when you’re done.</div>
      </Show>
    </section>
  )

  if (props.compact) return <div class="nearby nearby--compact">{bucketPanel()}</div>

  return (
    <div class="nearby">
      <div class="nearby__head">
        <div class="nearby__head-left">
          <span class="nearby__device">{nearby().deviceName || 'This device'}</span>
          <span
            class="nearby__pill"
            classList={{ 'nearby__pill--on': nearby().running }}
          >
            <span class="nearby__pill-dot" />
            {mode() === 'bucket'
              ? bucket().active ? 'Phone bucket · On' : 'Phone bucket · Off'
              : nearby().running ? `LocalSend · ${nearby().port}` : 'LocalSend · Off'}
          </span>
        </div>
        <Show when={mode() === 'nearby'}>
        <div class="nearby__head-actions">
          <button
            type="button"
            class="nearby__icon-btn"
            onClick={() => void refreshNearby()}
            aria-label="Refresh"
            data-no-drag
          >
            <RefreshCw
              class="icon icon--sm"
              strokeWidth={1.75}
              color="currentColor"
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            class="nearby__btn"
            classList={{ 'nearby__btn--stop': nearby().running }}
            onClick={() => void (nearby().running ? stopNearby() : startNearby())}
            data-no-drag
          >
            <Power
              class="icon icon--sm"
              strokeWidth={1.75}
              color="currentColor"
              aria-hidden="true"
            />
            <span>{nearby().running ? 'Stop' : 'Start'}</span>
          </button>
        </div>
        </Show>
      </div>

      <div class="nearby__mode-tabs" role="tablist" aria-label="Transfer method">
        <button type="button" role="tab" aria-selected={mode() === 'bucket'} classList={{ 'nearby__mode-tab--active': mode() === 'bucket' }} onClick={() => setMode('bucket')} data-no-drag>
          <Smartphone size={14} /> Phone bucket
        </button>
        <button type="button" role="tab" aria-selected={mode() === 'nearby'} classList={{ 'nearby__mode-tab--active': mode() === 'nearby' }} onClick={() => setMode('nearby')} data-no-drag>
          <Radio size={14} /> LocalSend
        </button>
      </div>

      <Show when={mode() === 'bucket'}>{bucketPanel()}</Show>

      <Show when={mode() === 'nearby'}>

      <div class="nearby__protocol">
        LocalSend v2.2 over plain HTTP on your local network. Incoming files are saved under Downloads / HoverIsland only after approval.
      </div>

      <Show when={detail()}>
        {(text) => <div class="nearby__notice">{text()}</div>}
      </Show>

      <div class="nearby__body">
        <div class="nearby__col">
          <div class="nearby__col-title">
            <span>Devices</span>
            <span class="nearby__count">{peers().length}</span>
          </div>
          <Show
            when={peers().length > 0}
            fallback={
              <div class="nearby__empty">
                <span class="nearby__empty-glyph">
                  <Radio class="icon" strokeWidth={1.75} color="currentColor" aria-hidden="true" />
                </span>
                <span class="nearby__empty-title">
                  {nearby().running ? 'Searching…' : 'Nearby is off'}
                </span>
                <span class="nearby__empty-hint">
                  {nearby().running
                    ? 'Devices running LocalSend on this network will appear here.'
                    : 'Start Nearby to discover devices on your network.'}
                </span>
              </div>
            }
          >
            <div class="nearby__peers">
              <For each={peers()}>
                {(peer) => (
                  <div
                    class="nearby__peer"
                    classList={{ 'nearby__peer--sel': selected() === peer.id }}
                    onClick={() => setSelected(peer.id)}
                    data-no-drag
                  >
                    <span class="nearby__peer-glyph" aria-hidden="true">
                      <Monitor size={15} strokeWidth={1.7} />
                    </span>
                    <div class="nearby__peer-info">
                      <span class="nearby__peer-name">{peer.name}</span>
                      <span class="nearby__peer-addr">
                        {peer.address}:{peer.port}
                      </span>
                    </div>
                    <button
                      type="button"
                      class="nearby__peer-send"
                      classList={{ 'nearby__peer-send--active': selected() === peer.id }}
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelected(peer.id)
                        setNotice(`Drop files onto the zone to send to ${peer.name}.`)
                      }}
                      data-no-drag
                    >
                      <Show when={selected() === peer.id} fallback={
                        <Send
                          class="icon icon--sm"
                          strokeWidth={1.75}
                          color="currentColor"
                          aria-hidden="true"
                        />
                      }>
                        <Check
                          class="icon icon--sm"
                          strokeWidth={2.2}
                          color="currentColor"
                          aria-hidden="true"
                        />
                      </Show>
                      <span>{selected() === peer.id ? 'Selected' : 'Send'}</span>
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>

        <div class="nearby__col">
          <div
            class="nearby__drop"
            classList={{ 'nearby__drop--ready': !!selectedPeer() }}
            data-no-drag
          >
            <span class="nearby__drop-glyph">
              <Send class="icon" strokeWidth={1.75} color="currentColor" aria-hidden="true" />
            </span>
            <span class="nearby__drop-title">
              {selectedPeer() ? `Send to ${selectedPeer()!.name}` : 'Drop files to send'}
            </span>
            <span class="nearby__drop-hint">
              {selectedPeer()
                ? 'Drop files or folders from Explorer. Up to 64 files per send.'
                : 'Select a device first, or drop when exactly one is nearby.'}
            </span>
          </div>

          <div class="nearby__transfers">
            <div class="nearby__col-title">
              <span>Transfers</span>
              <span class="nearby__count">{transfers().length}</span>
            </div>
            <Show
              when={transfers().length > 0}
              fallback={<div class="nearby__transfers-empty">No transfers yet.</div>}
            >
              <div class="nearby__transfer-list">
                <For each={[...transfers()].reverse()}>
                  {(t) => (
                    <div class="nearby__transfer">
                      <span
                        class="nearby__dir"
                        classList={{ 'nearby__dir--recv': t.direction === 'receive' }}
                      >
                        <Show
                          when={t.direction === 'receive'}
                          fallback={
                            <ArrowUp
                              class="icon icon--sm"
                              strokeWidth={1.75}
                              color="currentColor"
                              aria-hidden="true"
                            />
                          }
                        >
                          <ArrowDown
                            class="icon icon--sm"
                            strokeWidth={1.75}
                            color="currentColor"
                            aria-hidden="true"
                          />
                        </Show>
                      </span>
                      <div class="nearby__transfer-main">
                        <div class="nearby__transfer-row">
                          <span class="nearby__transfer-name" title={t.fileName}>
                            {t.fileName}
                          </span>
                          <span
                            class="nearby__transfer-status"
                            classList={{
                              'nearby__transfer-status--done': t.status === 'done',
                              'nearby__transfer-status--fail': t.status.startsWith('failed') || t.status === 'rejected' || t.status === 'expired',
                              'nearby__transfer-status--pending': t.status === 'pending' || t.status === 'waiting',
                            }}
                          >
                            {t.status.startsWith('failed:') ? 'failed' : t.status}
                          </span>
                        </div>
                        <Show when={t.status.startsWith('failed:')}>
                          <div class="nearby__transfer-error">{t.status.slice(7)}</div>
                        </Show>
                        <Show when={t.status === 'pending'}>
                          <div class="nearby__approval" data-no-drag>
                            <span title={t.fileName}>Review sender and files: {t.fileName}</span>
                            <button type="button" class="nearby__approval-btn nearby__approval-btn--accept" disabled={busy()} onClick={() => void decideReceive(t.id, true)}>
                              <Check class="icon icon--sm" strokeWidth={1.75} color="currentColor" aria-hidden="true" /> Accept
                            </button>
                            <button type="button" class="nearby__approval-btn" disabled={busy()} onClick={() => void decideReceive(t.id, false)}>
                              <X class="icon icon--sm" strokeWidth={1.75} color="currentColor" aria-hidden="true" /> Decline
                            </button>
                          </div>
                        </Show>
                        <div class="nearby__bar">
                          <div
                            class="nearby__bar-fill"
                            classList={{
                              'nearby__bar-fill--done': t.status === 'done',
                              'nearby__bar-fill--fail': t.status.startsWith('failed') || t.status === 'rejected' || t.status === 'expired',
                            }}
                            style={{ width: `${percent(t)}%` }}
                          />
                        </div>
                        <div class="nearby__transfer-meta">
                          {formatBytes(t.bytes)}
                          <Show when={t.total > 0}> / {formatBytes(t.total)}</Show>
                          <span class="nearby__transfer-peer">{t.peer}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>
      </div>
      </Show>
    </div>
  )
}
