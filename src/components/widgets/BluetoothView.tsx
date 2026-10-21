import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'
import { Battery, BatteryLow, Bluetooth, BluetoothOff, Camera, Check, ChevronRight, Gamepad2, Headphones, Keyboard, LoaderCircle, Laptop, Mic, Monitor, Mouse, RefreshCw, Smartphone, Speaker, Trash2, Watch, HeartPulse } from 'lucide-solid'
import type { JSX } from 'solid-js'
import { cmd, type BluetoothControl, type BluetoothManagedDevice, type BluetoothSourceReport } from '../../lib/ipc'
import { open as islandOpen } from '../../state/ui'
import './widgetKit.css'
import './BluetoothView.css'

/** Shapes the Widgets agent can pick from; `auto` follows the widget's measured size. */
export const BLUETOOTH_ORIENTATIONS = ['auto', 'wide', 'tall', 'compact'] as const
export type BluetoothOrientation = (typeof BLUETOOTH_ORIENTATIONS)[number]

const errorText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Icon by category from Windows (class of device), falling back to the device name. */
function deviceGlyph(device: BluetoothManagedDevice, size: number): JSX.Element {
  const text = `${device.kind} ${device.name}`.toLowerCase()
  const kind = device.kind
  if (kind === 'headphones' || /head|buds|airpod|earbud|earphone/.test(text)) return <Headphones size={size} />
  if (kind === 'speaker' || /speaker|soundbar|boom|flip|charge/.test(text)) return <Speaker size={size} />
  if (kind === 'microphone' || /\bmic\b|microphone/.test(text)) return <Mic size={size} />
  if (kind === 'keyboard' || /keyboard|keys/.test(text)) return <Keyboard size={size} />
  if (kind === 'mouse' || /mouse|trackpad|mx master|pointer/.test(text)) return <Mouse size={size} />
  if (kind === 'gamepad' || /game|controller|gamepad|joy-?con|dualsense|xbox/.test(text)) return <Gamepad2 size={size} />
  if (kind === 'phone' || /phone|iphone|android|galaxy|pixel/.test(text)) return <Smartphone size={size} />
  if (kind === 'watch' || /watch|band|fit/.test(text)) return <Watch size={size} />
  if (kind === 'computer' || /laptop|pc\b|macbook/.test(text)) return <Laptop size={size} />
  if (kind === 'display') return <Monitor size={size} />
  if (kind === 'camera') return <Camera size={size} />
  if (kind === 'health') return <HeartPulse size={size} />
  if (kind === 'audio') return <Speaker size={size} />
  return <Bluetooth size={size} />
}

export default function BluetoothView(props: { shape?: BluetoothOrientation }) {
  const [devices, setDevices] = createSignal<BluetoothManagedDevice[]>([])
  const [radio, setRadio] = createSignal<BluetoothControl | null>(null)
  const [radioBusy, setRadioBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  // Why the list could not be read (every source failed); empty when the list is trustworthy.
  const [readError, setReadError] = createSignal('')
  const [sources, setSources] = createSignal<BluetoothSourceReport[]>([])
  const [loading, setLoading] = createSignal(true)
  const [busyId, setBusyId] = createSignal('')
  const [forgetId, setForgetId] = createSignal('')
  const [measured, setMeasured] = createSignal<'wide' | 'tall' | 'compact'>('tall')
  let root: HTMLElement | undefined
  let disposed = false
  let requestPending = false
  let refreshQueued = false
  const shape = () => (props.shape && props.shape !== 'auto' ? props.shape : measured())

  const radioKnown = () => !!radio()?.supported && typeof radio()?.enabled === 'boolean'
  const radioOn = () => radioKnown() && radio()!.enabled === true
  const radioOff = () => radioKnown() && radio()!.enabled === false

  async function load(quiet = false): Promise<void> {
    if (requestPending) {
      if (!quiet) refreshQueued = true
      return
    }
    requestPending = true
    if (!quiet) setLoading(true)
    try {
      const [state, latest] = await Promise.all([
        cmd.bluetoothRadioGet().catch(() => null),
        cmd.bluetoothDevicesSnapshot().then(snapshot => ({ snapshot }), reason => ({ reason })),
      ])
      if (disposed) return
      if (state && !radioBusy()) setRadio(state)
      if ('snapshot' in latest) {
        const { devices: list, sources: reports, error: failure } = latest.snapshot
        setSources(reports ?? [])
        if (list.length === 0 && failure) {
          // Never show "No paired devices" when we simply could not read them.
          setReadError(failure)
          if (!quiet) setDevices([])
        } else {
          setReadError('')
          setDevices(list)
        }
        setError('')
        if (forgetId() && !list.some(device => device.id === forgetId())) setForgetId('')
      } else if (!quiet || devices().length === 0) {
        setReadError(errorText(latest.reason))
      }
    } finally {
      requestPending = false
      if (!disposed) setLoading(false)
      if (!disposed && refreshQueued) {
        refreshQueued = false
        void load(true)
      }
    }
  }

  onMount(() => {
    void load()
    if (root && typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(entries => {
        const box = entries[0]?.contentRect
        if (!box || !box.width || !box.height) return
        setMeasured(box.height < 150 ? 'compact' : box.width >= box.height * 1.25 && box.width >= 380 ? 'wide' : 'tall')
      })
      observer.observe(root)
      onCleanup(() => observer.disconnect())
    }
    // Cheap poll, and only while the island is open and visible. Opening the island refreshes at once.
    const timer = setInterval(() => {
      if (islandOpen() && document.visibilityState !== 'hidden' && !busyId() && !radioBusy()) void load(true)
    }, 6000)
    onCleanup(() => { disposed = true; clearInterval(timer) })
  })

  createEffect(on(islandOpen, open => { if (open && !loading()) void load(true) }, { defer: true }))

  async function toggleRadio(): Promise<void> {
    const current = radio()
    if (radioBusy() || !current?.supported || typeof current.enabled !== 'boolean') return
    const next = !current.enabled
    setRadio({ ...current, enabled: next })
    setRadioBusy(true)
    setError('')
    try {
      await cmd.setBluetoothRadio(next)
      let confirmed = false
      for (let attempt = 0; attempt < 6 && !confirmed; attempt++) {
        const latest = await cmd.bluetoothRadioGet()
        if (latest.enabled === next) { setRadio(latest); confirmed = true } else await sleep(350)
      }
      if (!confirmed) throw new Error('Windows did not confirm the change. Try again.')
      await load(true)
    } catch (reason) {
      setRadio(current)
      setError(errorText(reason))
    } finally {
      setRadioBusy(false)
    }
  }

  async function setAudioConnection(device: BluetoothManagedDevice): Promise<void> {
    if (busyId()) return
    setBusyId(device.id)
    setError('')
    try {
      if (device.connected) await cmd.bluetoothDisconnect(device.id)
      else await cmd.bluetoothConnect(device.id)
      await load(true)
    } catch (reason) {
      setError(errorText(reason))
      await load(true)
    } finally {
      setBusyId('')
    }
  }

  async function forgetDevice(device: BluetoothManagedDevice): Promise<void> {
    if (busyId() || !device.canUnpair) return
    setBusyId(device.id)
    setError('')
    try {
      await cmd.bluetoothUnpair(device.id)
      setForgetId('')
      await load(true)
    } catch (reason) {
      setError(errorText(reason))
      await load(true)
    } finally {
      setBusyId('')
    }
  }

  async function openSettings(): Promise<void> {
    try {
      await cmd.bluetoothOpenSettings()
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  const batteryColor = (pct: number) => pct <= 20 ? '#FF453A' : pct <= 40 ? '#FF9F0A' : '#30D158'
  const connectedCount = createMemo(() => devices().filter(device => device.connected === true).length)
  const subtitle = () => radioOff() ? 'Off' : connectedCount() ? `${connectedCount()} connected` : availableList().length ? `${availableList().length} in range` : devices().length ? `${devices().length} paired` : ''
  const statusText = (device: BluetoothManagedDevice) => device.connected === null ? 'Status unavailable' : device.connected ? 'Connected' : device.available ? 'In range' : 'Not connected'

  // Quick swap first: what is connected, then what is in range, then everything else Windows remembers.
  const connectedList = createMemo(() => devices().filter(device => device.connected === true))
  const availableList = createMemo(() => devices().filter(device => device.connected !== true && device.available === true))
  const otherList = createMemo(() => devices().filter(device => device.connected !== true && device.available !== true))

  const Row = (device: BluetoothManagedDevice) => <article class="bluetooth-manage__device" classList={{ 'is-connected': device.connected === true }} title={shape() === 'compact' ? `${device.name} · ${statusText(device)}${device.batteryPct !== null ? ` · ${device.batteryPct}%` : ''}` : undefined}>
              <span class="bluetooth-manage__device-icon">{deviceGlyph(device, shape() === 'compact' ? 18 : 16)}</span>
              <div class="bluetooth-manage__identity">
                <strong title={device.name}>{device.name}</strong>
                <span class="bluetooth-manage__meta">
                  <span classList={{ 'is-connected': device.connected === true }}>{statusText(device)}</span>
                  <Show when={device.batteryPct !== null}><span class="bluetooth-manage__battery" style={{ color: batteryColor(device.batteryPct!) }}>{device.batteryPct! <= 20 ? <BatteryLow size={13}/> : <Battery size={13}/>}{device.batteryPct}%</span></Show>
                </span>
              </div>
              <Show when={device.canConnect || device.canDisconnect}>
                <button class="wk-pill bluetooth-manage__action" classList={{ 'wk-pill--blue': !device.connected }} disabled={!!busyId() || radioOff()} title={device.actionReason || ''} onClick={() => void setAudioConnection(device)}>
                  <Show when={busyId() !== device.id} fallback={<LoaderCircle size={13} class="bluetooth-manage__spin"/>}>
                    {device.connected ? 'Disconnect' : 'Connect'}
                  </Show>
                </button>
              </Show>
              <Show when={device.canUnpair}>
                <button class="wk-icon-btn bluetooth-manage__forget" aria-label={`Forget ${device.name}`} title="Forget device" disabled={!!busyId()} onClick={() => setForgetId(forgetId() === device.id ? '' : device.id)}><Trash2 size={13}/></button>
                <Show when={forgetId() === device.id}>
                  <div class="bluetooth-manage__confirm" role="group" aria-label={`Confirm forgetting ${device.name}`}>
                    <span>Remove pairing for <b>{device.name}</b>?</span>
                    <button class="wk-pill bluetooth-manage__confirm-yes" disabled={!!busyId()} onClick={() => void forgetDevice(device)}>
                      <Show when={busyId() !== device.id} fallback={<LoaderCircle size={12} class="bluetooth-manage__spin"/>}><Check size={12}/> Forget</Show>
                    </button>
                    <button class="wk-pill bluetooth-manage__confirm-no" disabled={!!busyId()} onClick={() => setForgetId('')}>Cancel</button>
                  </div>
                </Show>
              </Show>
            </article>

  return <section class="wk bluetooth-manage" ref={element => (root = element)} data-shape={shape()} aria-label="Bluetooth devices">
    <header class="wk-head">
      <span class="wk-title"><span class="wk-glyph" style={{ background: radioOff() ? 'rgba(255,255,255,.18)' : '#0A84FF' }}>{radioOff() ? <BluetoothOff size={13} strokeWidth={2.2} /> : <Bluetooth size={13} strokeWidth={2.2} />}</span><span>Bluetooth</span><Show when={subtitle()}><small class="bluetooth-manage__count">{subtitle()}</small></Show></span>
      <span class="wk-tools">
        <button class="wk-icon-btn" aria-label="Refresh Bluetooth devices" title="Refresh" disabled={loading() || !!busyId() || radioBusy()} onClick={() => void load()}>
          <Show when={!loading()} fallback={<LoaderCircle size={14} class="bluetooth-manage__spin"/>}><RefreshCw size={14}/></Show>
        </button>
        <button type="button" role="switch" class="bluetooth-manage__switch" classList={{ 'is-on': radioOn(), 'is-busy': radioBusy() }} aria-checked={radioOn()} aria-label="Bluetooth"
          disabled={!radioKnown() || radioBusy()} title={radioKnown() ? (radioOn() ? 'Turn Bluetooth off' : 'Turn Bluetooth on') : (radio()?.error || 'Bluetooth is not available on this PC')}
          onClick={() => void toggleRadio()}><i/></button>
      </span>
    </header>

    <Show when={error()}><p class="wk-error" role="status">{error()}</p></Show>
    <Show when={!loading() || devices().length > 0} fallback={<div class="wk-empty"><p>Finding paired devices</p></div>}>
      <Show when={!radioOff() || devices().length > 0} fallback={<div class="wk-empty"><strong>Bluetooth is off</strong><button class="wk-pill wk-pill--blue" disabled={radioBusy()} onClick={() => void toggleRadio()}>Turn on</button></div>}>
        <Show when={devices().length > 0} fallback={<Show when={readError()} fallback={<div class="wk-empty"><strong>No paired devices</strong><p>Pair one in Windows settings.</p></div>}>
          <div class="wk-empty bluetooth-manage__failed" role="alert">
            <strong>Couldn't read devices</strong>
            <p class="bluetooth-manage__reason">{readError()}</p>
            <button class="wk-pill wk-pill--blue" disabled={loading()} onClick={() => void load()}>Retry</button>
            <Show when={sources().length > 0}>
              <details class="bluetooth-manage__details"><summary>Details</summary>
                <ul><For each={sources()}>{source => <li classList={{ 'is-failed': !source.ok }}>{source.source}: {source.ok ? `${source.count} found` : source.error}</li>}</For></ul>
              </details>
            </Show>
          </div>
        </Show>}>
          <div class="bluetooth-manage__list" classList={{ 'is-off': radioOff() }}>
            <Show when={connectedList().length}><p class="bluetooth-manage__group">Connected</p><For each={connectedList()}>{device => Row(device)}</For></Show>
            <Show when={availableList().length}><p class="bluetooth-manage__group">Available</p><For each={availableList()}>{device => Row(device)}</For></Show>
            <Show when={!connectedList().length && !availableList().length}><p class="bluetooth-manage__group bluetooth-manage__group--quiet">Nothing connected or in range</p></Show>
            <Show when={otherList().length}>
              <details class="bluetooth-manage__others" open={!connectedList().length && !availableList().length}>
                <summary>Other paired devices ({otherList().length})</summary>
                <For each={otherList()}>{device => Row(device)}</For>
              </details>
            </Show>
          </div>
        </Show>
      </Show>
    </Show>

    <button class="bluetooth-manage__settings" onClick={() => void openSettings()}><span>Open Bluetooth settings</span><ChevronRight size={14}/></button>
  </section>
}
