import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { BatteryMedium, Bluetooth, Check, ChevronRight, LoaderCircle, RefreshCw, Settings2, Trash2 } from 'lucide-solid'
import { cmd, type BluetoothManagedDevice } from '../../lib/ipc'
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

  return <section class="bluetooth-manage" aria-label="Bluetooth devices">
    <header class="bluetooth-manage__head">
      <span class="bluetooth-manage__title"><Bluetooth size={15}/> Paired devices</span>
      <button class="bluetooth-manage__refresh" aria-label="Refresh Bluetooth devices" title="Refresh" disabled={loading() || !!busyId()} onClick={() => void load()}>
        <Show when={!loading()} fallback={<LoaderCircle size={14} class="bluetooth-manage__spin"/>}><RefreshCw size={14}/></Show>
      </button>
    </header>

    <Show when={error()}><p class="bluetooth-manage__error" role="status">{error()}</p></Show>
    <Show when={!loading() || devices().length > 0} fallback={<p class="bluetooth-manage__empty">Finding paired devices…</p>}>
      <Show when={devices().length > 0} fallback={<p class="bluetooth-manage__empty">No paired Bluetooth devices were found.</p>}>
        <div class="bluetooth-manage__list">
          <For each={devices()}>{device => <article class="bluetooth-manage__device">
            <span class="bluetooth-manage__device-icon"><Bluetooth size={15}/></span>
            <div class="bluetooth-manage__identity">
              <strong title={device.name}>{device.name}</strong>
              <span class="bluetooth-manage__meta">
                <span classList={{ 'is-connected': device.connected === true }}>{device.connected === null ? 'Status unavailable' : device.connected ? 'Connected' : 'Not connected'}</span>
                <Show when={device.batteryPct !== null}><span class="bluetooth-manage__battery"><BatteryMedium size={12}/>{device.batteryPct}%</span></Show>
              </span>
            </div>
            <Show when={device.canConnect || device.canDisconnect} fallback={<span class="bluetooth-manage__fallback" title={device.actionReason || 'Connection is managed by Windows.'}>Windows</span>}>
              <button class="bluetooth-manage__action" disabled={!!busyId()} title={device.actionReason || ''} onClick={() => void setAudioConnection(device)}>
                <Show when={busyId() !== device.id} fallback={<LoaderCircle size={13} class="bluetooth-manage__spin"/>}>
                  {device.connected ? 'Disconnect' : 'Connect'}
                </Show>
              </button>
            </Show>
            <Show when={device.canUnpair}>
              <button class="bluetooth-manage__forget" aria-label={`Forget ${device.name}`} title="Forget device" disabled={!!busyId()} onClick={() => setForgetId(forgetId() === device.id ? '' : device.id)}><Trash2 size={13}/></button>
              <Show when={forgetId() === device.id}>
                <div class="bluetooth-manage__confirm" role="group" aria-label={`Confirm forgetting ${device.name}`}>
                  <span>Remove pairing for <b>{device.name}</b>?</span>
                  <button class="bluetooth-manage__confirm-yes" disabled={!!busyId()} onClick={() => void forgetDevice(device)}>
                    <Show when={busyId() !== device.id} fallback={<LoaderCircle size={12} class="bluetooth-manage__spin"/>}><Check size={12}/> Forget</Show>
                  </button>
                  <button class="bluetooth-manage__confirm-no" disabled={!!busyId()} onClick={() => setForgetId('')}>Cancel</button>
                </div>
              </Show>
            </Show>
          </article>}</For>
        </div>
      </Show>
    </Show>

    <p class="bluetooth-manage__note">Windows manages keyboards and other non-audio connections. Connect controls appear only when the audio driver supports them.</p>
    <button class="bluetooth-manage__settings" onClick={() => void openSettings()}><Settings2 size={14}/><span>Pair or manage in Windows Settings</span><ChevronRight size={14}/></button>
  </section>
}
