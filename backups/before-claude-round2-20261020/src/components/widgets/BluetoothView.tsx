import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Bluetooth, Check, ChevronRight, Gamepad2, Headphones, Keyboard, LoaderCircle, Mouse, RefreshCw, Smartphone, Speaker, Trash2, Watch } from 'lucide-solid'
import { cmd, type BluetoothManagedDevice } from '../../lib/ipc'
import './widgetKit.css'
import './BluetoothView.css'

export default function BluetoothView() {
  const [devices, setDevices] = createSignal<BluetoothManagedDevice[]>([])
  const [error, setError] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [busyId, setBusyId] = createSignal('')
  const [forgetId, setForgetId] = createSignal('')
  let disposed = false
  let requestPending = false
  let refreshQueued = false

  async function load(quiet = false): Promise<void> {
    if (requestPending) {
      if (!quiet) refreshQueued = true
      return
    }
    requestPending = true
    if (!quiet) setLoading(true)
    try {
      const latest = await cmd.bluetoothDevicesList()
      if (disposed) return
      setDevices(latest)
      setError('')
      if (forgetId() && !latest.some(device => device.id === forgetId())) setForgetId('')
    } catch (reason) {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      requestPending = false
      if (!disposed && !quiet) setLoading(false)
      if (!disposed && refreshQueued) {
        refreshQueued = false
        void load(true)
      }
    }
  }

  onMount(() => {
    void load()
    const timer = setInterval(() => void load(true), 8000)
    onCleanup(() => { disposed = true; clearInterval(timer) })
  })

  async function setAudioConnection(device: BluetoothManagedDevice): Promise<void> {
    if (busyId()) return
    setBusyId(device.id)
    setError('')
    try {
      if (device.connected) await cmd.bluetoothDisconnect(device.id)
      else await cmd.bluetoothConnect(device.id)
      await load(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
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
      setError(reason instanceof Error ? reason.message : String(reason))
      await load(true)
    } finally {
      setBusyId('')
    }
  }

  async function openSettings(): Promise<void> {
    try {
      await cmd.bluetoothOpenSettings()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const glyph = (device: BluetoothManagedDevice) => {
    const kind = `${device.kind} ${device.name}`.toLowerCase()
    if (/head|buds|airpod|earbud|audio/.test(kind)) return <Headphones size={16} />
    if (/speaker|soundbar/.test(kind)) return <Speaker size={16} />
    if (/keyboard/.test(kind)) return <Keyboard size={16} />
    if (/mouse|trackpad|pointer/.test(kind)) return <Mouse size={16} />
    if (/phone|iphone|android/.test(kind)) return <Smartphone size={16} />
    if (/watch|band/.test(kind)) return <Watch size={16} />
    if (/game|controller|pad/.test(kind)) return <Gamepad2 size={16} />
    return <Bluetooth size={16} />
  }
  const batteryColor = (pct: number) => pct <= 20 ? '#FF453A' : pct <= 40 ? '#FF9F0A' : '#30D158'

  return <section class="wk bluetooth-manage" aria-label="Bluetooth devices">
    <header class="wk-head">
      <span class="wk-title"><span class="wk-glyph" style={{ background: '#0A84FF' }}><Bluetooth size={13} strokeWidth={2.2} /></span><span>Paired devices</span></span>
      <button class="wk-icon-btn" aria-label="Refresh Bluetooth devices" title="Refresh" disabled={loading() || !!busyId()} onClick={() => void load()}>
        <Show when={!loading()} fallback={<LoaderCircle size={14} class="bluetooth-manage__spin"/>}><RefreshCw size={14}/></Show>
      </button>
    </header>

    <Show when={error()}><p class="wk-error" role="status">{error()}</p></Show>
    <Show when={!loading() || devices().length > 0} fallback={<div class="wk-empty"><p>Finding paired devices</p></div>}>
      <Show when={devices().length > 0} fallback={<div class="wk-empty"><strong>No devices</strong><p>Pair one in Windows Settings.</p></div>}>
        <div class="bluetooth-manage__list">
          <For each={devices()}>{device => <article class="bluetooth-manage__device" classList={{ 'is-connected': device.connected === true }}>
            <span class="bluetooth-manage__device-icon">{glyph(device)}</span>
            <div class="bluetooth-manage__identity">
              <strong title={device.name}>{device.name}</strong>
              <span class="bluetooth-manage__meta">
                <span classList={{ 'is-connected': device.connected === true }}>{device.connected === null ? 'Status unavailable' : device.connected ? 'Connected' : 'Not connected'}</span>
                <Show when={device.batteryPct !== null}><span class="bluetooth-manage__battery"><i style={{ '--pct': `${device.batteryPct}%`, '--c': batteryColor(device.batteryPct!) }} />{device.batteryPct}%</span></Show>
              </span>
            </div>
            <Show when={device.canConnect || device.canDisconnect} fallback={<span class="bluetooth-manage__fallback" title={device.actionReason || 'Connection is managed by Windows.'}>Windows</span>}>
              <button class="wk-pill bluetooth-manage__action" classList={{ 'wk-pill--blue': !device.connected }} disabled={!!busyId()} title={device.actionReason || ''} onClick={() => void setAudioConnection(device)}>
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
          </article>}</For>
        </div>
      </Show>
    </Show>

    <button class="bluetooth-manage__settings" onClick={() => void openSettings()}><span>Open Bluetooth settings</span><ChevronRight size={14}/></button>
  </section>
}
