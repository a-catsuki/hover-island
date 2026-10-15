import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { ArrowLeft, BatteryMedium, Bluetooth, ChevronRight, Leaf, LoaderCircle, MemoryStick, Moon, RefreshCw, Sun, Volume2, VolumeX } from 'lucide-solid'
import { cmd, onMemoryReclaimProgress, type QuickControlsSnapshot } from '../../lib/ipc'
import { reportError } from '../../state/feedback'
import { ingestActionPeek } from '../../state/peek'
import { createSliderCommitter } from '../../lib/sliderCommitter'
import { settings, patchSettings, flushSettings } from '../../state/settings'
import './QuickSettingsView.css'

type ControlKey = 'volume' | 'brightness' | 'bluetooth' | 'powerMode' | 'nightLight' | 'doNotDisturb'

const [controls, setControls] = createSignal<QuickControlsSnapshot | null>(null)
const [devices, setDevices] = createSignal<string[]>([])
const [deviceError, setDeviceError] = createSignal('')
const [batteryText, setBatteryText] = createSignal('Checking battery…')
const [loading, setLoading] = createSignal(false)
const [busy, setBusy] = createSignal(false)
const [controlError, setControlError] = createSignal('')
const [volumeLevel, setVolumeLevel] = createSignal(0)
const [brightnessLevel, setBrightnessLevel] = createSignal(0)
const [memoryOpen, setMemoryOpen] = createSignal(false)
const [scanning, setScanning] = createSignal(false)
const [reclaiming, setReclaiming] = createSignal(false)
const [memoryError, setMemoryError] = createSignal('')
const [memoryResult, setMemoryResult] = createSignal('')
const [memoryReleased, setMemoryReleased] = createSignal(0)
const [memoryCompleted, setMemoryCompleted] = createSignal(0)
const [memoryTotal, setMemoryTotal] = createSignal(0)

let refreshInFlight: Promise<void> | undefined

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * Coalesces rapid slider input into at most one call per interval, then flushes the
 * final value on release. Keeps 1:1 tracking while avoiding an IPC call per pixel.
 */
const commitVolume = createSliderCommitter(
  value => cmd.setMasterVolume(value),
  error => { setControlError(errorText(error)); reportError('Could not set the system volume', error) },
)
const commitBrightness = createSliderCommitter(
  value => cmd.setBrightness(value),
  error => { setControlError(errorText(error)); reportError('Could not set the display brightness', error) },
)

function patchControl<K extends ControlKey>(key: K, value: QuickControlsSnapshot[K]): void {
  setControls(previous => (previous ? { ...previous, [key]: value } : previous))
}

async function refresh(): Promise<void> {
  if (refreshInFlight) return refreshInFlight
  setLoading(true)
  refreshInFlight = Promise.all([cmd.quickControlsGet(), cmd.devicesGet()])
    .then(([snapshot, deviceSnapshot]) => {
      setControls(snapshot)
      const volume = snapshot.volume
      if (typeof volume?.level === 'number') setVolumeLevel(volume.level)
      const brightness = snapshot.brightness
      if (typeof brightness?.level === 'number') setBrightnessLevel(brightness.level)
      setDevices(deviceSnapshot.bluetooth)
      setDeviceError(deviceSnapshot.error || '')
      setControlError('')
    })
    .catch(error => {
      setControlError(errorText(error))
      reportError('Could not read Windows quick controls', error)
    })
    .finally(() => { setLoading(false); refreshInFlight = undefined })
  return refreshInFlight
}

function confirmAction(title: string, body: string): void {
  const timestamp = Date.now()
  ingestActionPeek({ id: `quick-control:${timestamp}:${Math.random().toString(16).slice(2)}`, app: 'Quick settings', title, body, timestamp })
}

const formatBytes = (bytes: number) => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

async function runToggle(key: ControlKey, next: boolean, apply: () => Promise<unknown>, title: string, body: string, context: string): Promise<void> {
  const snapshot = controls()
  const previous = snapshot?.[key] as { enabled?: boolean | null } | undefined
  if (previous && 'enabled' in previous) patchControl(key, { ...previous, enabled: next } as QuickControlsSnapshot[ControlKey])
  setBusy(true)
  setControlError('')
  try {
    await apply()
    const latest = await cmd.quickControlsGet()
    const verified = latest[key] as { enabled?: boolean | null } | undefined
    if (verified?.enabled !== next) throw new Error('Windows did not confirm the requested setting. Refresh and try again.')
    patchControl(key, latest[key])
    if (key !== 'doNotDisturb') confirmAction(title, body)
  } catch (error) {
    if (previous && 'enabled' in previous) patchControl(key, previous as QuickControlsSnapshot[ControlKey])
    setControlError(errorText(error))
    reportError(context, error)
  } finally {
    setBusy(false)
  }
}

function onVolumeInput(raw: string): void {
  const value = Math.round(Number(raw))
  if (!Number.isFinite(value)) return
  setVolumeLevel(value)
  const volume = controls()?.volume
  // Dragging the volume while muted is an implicit unmute, matching Windows.
  if (volume?.muted) {
    patchControl('volume', { ...volume, muted: false })
  }
  commitVolume.push(value)
}

function onBrightnessInput(raw: string): void {
  const value = Math.round(Number(raw))
  if (!Number.isFinite(value)) return
  setBrightnessLevel(value)
  commitBrightness.push(value)
}

function toggleMute(): void {
  const volume = controls()?.volume
  if (!volume?.supported || volume.muted === null || busy()) return
  const next = !volume.muted
  patchControl('volume', { ...volume, muted: next })
  setBusy(true)
  setControlError('')
  void cmd.setMute(next)
    .then(() => confirmAction(next ? 'Muted' : 'Unmuted', next ? 'System volume is muted.' : 'System volume is back on.'))
    .catch(error => {
      patchControl('volume', volume)
      setControlError(errorText(error))
      reportError('Could not change mute', error)
    })
    .finally(() => setBusy(false))
}

function toggleNightLight(): void {
  const control = controls()?.nightLight
  if (!control?.supported || control.enabled === null || busy()) return
  const next = !control.enabled
  void runToggle('nightLight', next, () => cmd.setNightLight(next), next ? 'Night light on' : 'Night light off', 'Windows display warmth changed (best effort).', 'Could not change Night light')
}

function toggleDnd(): void {
  if (busy()) return
  const control = controls()?.doNotDisturb
  const next = !settings.dnd
  setBusy(true)
  setControlError('')
  void (async () => {
    try {
      patchSettings({ dnd: next })
      await flushSettings()
      if (control?.supported && control.enabled !== null) {
        try { await cmd.setDoNotDisturb(next) }
        catch { setControlError('Notch alerts were updated. Windows Do Not Disturb could not be changed.') }
      }
    } catch (error) {
      setControlError(errorText(error))
      reportError('Could not change Do Not Disturb', error)
    } finally { setBusy(false) }
  })()
}

function toggleBluetooth(): void {
  const bluetooth = controls()?.bluetooth
  if (!bluetooth?.supported || bluetooth.enabled === null || busy()) return
  const next = !bluetooth.enabled
  void runToggle('bluetooth', next, () => cmd.setBluetoothRadio(next), next ? 'Bluetooth turned on' : 'Bluetooth turned off', next ? 'Windows radio state changed.' : 'Connected Bluetooth devices may disconnect.', 'Could not change Bluetooth')
}

function togglePowerEfficiency(): void {
  const power = controls()?.powerMode
  if (!power?.supported || (power.bestEfficiencyActive && !power.canRestorePrevious) || busy()) return
  const enable = !power.bestEfficiencyActive
  void (async () => {
    setBusy(true)
    setControlError('')
    try {
      await cmd.setBestPowerEfficiency(enable)
      confirmAction(enable ? 'Best power efficiency enabled' : 'Previous power mode restored', enable ? 'Windows selected Best power efficiency. Energy Saver is a separate Windows setting.' : 'Windows restored the power modes that were active before this change.')
      void cmd.quickControlsGet()
        .then(snapshot => { if (snapshot.powerMode) patchControl('powerMode', snapshot.powerMode) })
        .catch(() => {})
    } catch (error) {
      setControlError(errorText(error))
      reportError('Could not change the Windows power mode', error)
    } finally {
      setBusy(false)
    }
  })()
}

async function optimizeMemory(): Promise<void> {
  if (scanning() || reclaiming()) return
  setScanning(true)
  setReclaiming(true)
  setMemoryError('')
  setMemoryResult('')
  setMemoryReleased(0)
  setMemoryCompleted(0)
  setMemoryTotal(0)
  try {
    const candidates = await cmd.memoryScan()
    if (!candidates.length) {
      setMemoryResult('No eligible background apps need trimming right now.')
      return
    }
    // The native preview is sorted largest-first and limits each process to
    // same-user, non-visible, non-critical candidates before a second validation.
    const results = await cmd.memoryReclaim(candidates.slice(0, 8).map(candidate => candidate.id))
    const total = results.reduce((sum, result) => sum + result.releasedWorkingSetBytes, 0)
    setMemoryReleased(total)
    const failures = results.filter(result => result.error).length
    const processed = results.length - failures
    setMemoryResult(total > 0
      ? `${processed} background app${processed===1?'':'s'} optimized${failures ? ` · ${failures} skipped` : ''}.`
      : `No working-set decrease was measured${processed ? ` across ${processed} app${processed === 1 ? '' : 's'}` : ''}${failures ? ` · ${failures} skipped` : ''}.`)
    if (total > 0) confirmAction('Memory optimize finished', `${formatBytes(total)} measured from background app working sets. Apps stay open; Windows may load the pages again.`)
  }
  catch (error) {
    setMemoryError(errorText(error))
    reportError('Could not optimize app memory', error)
  } finally { setScanning(false); setReclaiming(false) }
}

function openSettings(url: 'nightlight' | 'bluetooth' | 'power' | 'sound' | 'display', context: string): void {
  const action = url === 'nightlight' ? cmd.openNightLightSettings : url === 'bluetooth' ? cmd.openBluetoothSettings : url === 'power' ? cmd.openPowerSettings : () => cmd.openWindowsSettings(url)
  setControlError('')
  void action().catch(error => { setControlError(errorText(error)); reportError(context, error) })
}

export default function QuickSettingsView() {
  onCleanup(() => { commitVolume.cancel(); commitBrightness.cancel() })
  onMount(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void onMemoryReclaimProgress(progress => {
      if (!reclaiming()) return
      setMemoryReleased(progress.releasedWorkingSetBytes)
      setMemoryCompleted(progress.completed)
      setMemoryTotal(progress.total)
    }).then(stop => disposed ? stop() : unlisten = stop).catch(() => {})
    onCleanup(() => { disposed = true; unlisten?.() })
    void refresh()
    void cmd.systemStats().then(stats => {
      setBatteryText(stats.batteryPercent === null
        ? 'No battery detected'
        : `${Math.round(stats.batteryPercent)}% · ${stats.charging ? 'Charging' : 'Not charging'}`)
    }).catch(() => setBatteryText('Battery status unavailable'))
  })

  const volume = () => controls()?.volume
  const brightness = () => controls()?.brightness
  const bluetooth = () => controls()?.bluetooth
  const powerMode = () => controls()?.powerMode
  const nightLight = () => controls()?.nightLight
  const volumeUsable = () => !!volume()?.supported && volume()?.level !== null

  return <section class="quick-settings" aria-label="Quick settings">
    <header class="quick-settings__head">
      <Show when={memoryOpen()}>
        <button class="quick-settings__back" onClick={() => setMemoryOpen(false)}><ArrowLeft size={15}/> <span>Quick settings</span></button>
      </Show>
      <div classList={{ 'quick-settings__head-title': true, 'is-memory': memoryOpen() }}><span class="quick-settings__eyebrow">{memoryOpen() ? 'Windows tools' : 'Windows controls'}</span><strong>{memoryOpen() ? 'Memory reclaim' : 'Quick settings'}</strong></div>
      <Show when={!memoryOpen()}>
        <button class="quick-settings__refresh" aria-label="Refresh quick settings" title="Refresh" disabled={loading() || busy()} onClick={() => void refresh()}>
          <Show when={!loading()} fallback={<LoaderCircle size={15} class="quick-settings__spin"/>}><RefreshCw size={15}/></Show>
        </button>
      </Show>
    </header>

    <Show when={memoryOpen()} fallback={<div class="quick-settings__overview">
      <div class="quick-settings__sliders">
       <div class="quick-settings__slider-section">
        <div class="quick-settings__slider-row" classList={{ 'is-disabled': !volumeUsable() }}>
          <button class="quick-settings__icon quick-settings__icon--action" aria-label={volume()?.muted ? 'Unmute' : 'Mute'} title={volume()?.muted ? 'Unmute' : 'Mute'} disabled={!volume()?.supported || volume()?.muted === null || busy()} onClick={toggleMute}>
            {volume()?.muted ? <VolumeX size={17}/> : <Volume2 size={17}/>}
          </button>
          <div class="quick-settings__slider-body">
            <div class="quick-settings__slider-head"><span>Volume</span><span class="quick-settings__value">{volumeUsable() ? `${volumeLevel()}%` : '—'}</span></div>
            <input class="quick-settings__range" type="range" min="0" max="100" step="1" aria-label="System volume"
              disabled={!volumeUsable() || busy()} value={volumeLevel()} style={`--pct:${volumeUsable() ? volumeLevel() : 0}%`}
              onInput={event => onVolumeInput(event.currentTarget.value)} onChange={() => commitVolume.flush()}/>
          </div>
        </div>
        <Show when={!volume()?.supported}><button class="quick-settings__fallback" title={volume()?.error || ''} onClick={()=>openSettings('sound','Could not open Sound settings')}>Adjust sound in Windows<ChevronRight size={13}/></button></Show>
       </div>

       <div class="quick-settings__slider-section">
        <div class="quick-settings__slider-row" classList={{ 'is-disabled': !brightness()?.supported }}>
          <span class="quick-settings__icon"><Sun size={17}/></span>
          <div class="quick-settings__slider-body">
            <div class="quick-settings__slider-head"><span>Brightness</span><span class="quick-settings__value">{brightness()?.supported ? `${brightnessLevel()}%` : '—'}</span></div>
            <input class="quick-settings__range" type="range" min="0" max="100" step="1" aria-label="Display brightness"
              disabled={!brightness()?.supported || busy()} value={brightnessLevel()} style={`--pct:${brightness()?.supported ? brightnessLevel() : 0}%`}
              onInput={event => onBrightnessInput(event.currentTarget.value)} onChange={() => commitBrightness.flush()}/>
          </div>
        </div>
        <Show when={!brightness()?.supported}><button class="quick-settings__fallback" title={brightness()?.error || ''} onClick={()=>openSettings('display','Could not open Display settings')}>Adjust display in Windows<ChevronRight size={13}/></button></Show>
       </div>
      </div>

      <div class="quick-settings__tiles">
        <button class="quick-settings__tile" disabled={busy()} aria-pressed={bluetooth()?.supported ? bluetooth()?.enabled ?? false : undefined} title={bluetooth()?.error || 'Bluetooth'} onClick={()=>bluetooth()?.supported && bluetooth()?.enabled!==null ? toggleBluetooth() : openSettings('bluetooth','Could not open Bluetooth settings')}>
          <span class="quick-settings__icon"><Bluetooth size={17}/></span>
          <span class="quick-settings__text"><strong>Bluetooth</strong><small>{bluetooth()?.supported ? (bluetooth()?.enabled ? 'On' : 'Off') : 'Open Windows settings'}</small></span>
          <Show when={bluetooth()?.supported} fallback={<ChevronRight size={15}/>}><span class="quick-settings__switch" classList={{ 'is-on': !!bluetooth()?.enabled }} aria-hidden="true"><i/></span></Show>
        </button>

        <button class="quick-settings__tile" disabled={busy()} aria-pressed={nightLight()?.supported ? nightLight()?.enabled ?? false : undefined} title={nightLight()?.error || 'Night light'} onClick={()=>nightLight()?.supported && nightLight()?.enabled!==null ? toggleNightLight() : openSettings('nightlight','Could not open Night light settings')}>
          <span class="quick-settings__icon"><Sun size={17}/></span>
          <span class="quick-settings__text"><strong>Night light</strong><small>{nightLight()?.supported ? (nightLight()?.enabled ? 'On' : 'Off') : 'Adjust in Windows'}</small></span>
          <Show when={nightLight()?.supported} fallback={<ChevronRight size={15}/>}><span class="quick-settings__switch" classList={{ 'is-on': !!nightLight()?.enabled }} aria-hidden="true"><i/></span></Show>
        </button>

        <button class="quick-settings__tile" disabled={busy()} aria-pressed={settings.dnd} title="Silence notch notifications and chimes" onClick={toggleDnd}>
          <span class="quick-settings__icon"><Moon size={17}/></span>
          <span class="quick-settings__text"><strong>Do not disturb</strong><small>{settings.dnd ? 'Notch alerts silenced' : 'Notch alerts on'}</small></span>
          <span class="quick-settings__switch" classList={{ 'is-on': settings.dnd }} aria-hidden="true"><i/></span>
        </button>

        <button class="quick-settings__tile" disabled={busy()} aria-pressed={powerMode()?.bestEfficiencyActive ?? false} title={powerMode()?.error || powerMode()?.activeName || 'Power mode'} onClick={()=>powerMode()?.supported && !(powerMode()?.bestEfficiencyActive && !powerMode()?.canRestorePrevious) ? togglePowerEfficiency() : openSettings('power','Could not open Power settings')}>
          <span class="quick-settings__icon"><Leaf size={17}/></span>
          <span class="quick-settings__text"><strong>Power mode</strong><small>{powerMode()?.bestEfficiencyActive ? (powerMode()?.canRestorePrevious ? 'Best efficiency · restore' : 'Best efficiency active') : (powerMode()?.supported ? (powerMode()?.activeName || 'Choose in Windows') : 'Adjust in Windows')}</small></span>
          <Show when={powerMode()?.supported && !(powerMode()?.bestEfficiencyActive && !powerMode()?.canRestorePrevious)} fallback={<ChevronRight size={15}/>}><span class="quick-settings__switch" classList={{ 'is-on': !!powerMode()?.bestEfficiencyActive }} aria-hidden="true"><i/></span></Show>
        </button>
      </div>

      <div class="quick-settings__status">
        <div class="quick-settings__status-row">
          <span class="quick-settings__icon"><BatteryMedium size={17}/></span>
          <span class="quick-settings__text"><strong>Battery</strong><small>{batteryText()}</small></span>
        </div>
        <Show when={devices().length > 0}>
          <div class="quick-settings__devices" aria-label="Connected Bluetooth devices"><For each={devices()}>{name => <span>{name}</span>}</For></div>
        </Show>
        <Show when={deviceError()}><p class="quick-settings__inline-error" role="status">{deviceError()}</p></Show>
      </div>

      <div class="quick-settings__links">
        <button class="quick-settings__link" onClick={() => openSettings('power', 'Could not open Windows Power & battery')}><Leaf size={14}/> <span>Energy Saver &amp; power</span><small>Open Windows settings</small><ChevronRight size={15}/></button>
        <button class="quick-settings__link" onClick={() => openSettings('bluetooth', 'Could not open Bluetooth settings')}><Bluetooth size={14}/> <span>Bluetooth devices</span><small>Open Windows settings</small><ChevronRight size={15}/></button>
      </div>

      <Show when={controlError()}><p class="quick-settings__error" role="alert">{controlError()}</p></Show>

      <button class="quick-settings__memory-head" onClick={() => setMemoryOpen(true)}>
        <span class="quick-settings__icon"><MemoryStick size={17}/></span>
        <span class="quick-settings__text"><strong>Optimize memory</strong><small>Trim eligible background apps · apps stay open</small></span>
        <span class="quick-settings__chevron"><ChevronRight size={16}/></span>
      </button>
    </div>}>
      <div class="quick-settings__memory-page">
        <div class="memory-meter" classList={{'memory-meter--running':reclaiming()}} aria-live="polite">
          <span>Background memory released</span>
          <strong>{Math.round(memoryReleased()/1024/1024).toLocaleString()}<small>MB</small></strong>
          <progress aria-label="Memory optimization progress" max={Math.max(1,memoryTotal())} value={memoryCompleted()}/>
          <small>{reclaiming() ? memoryTotal() ? `${memoryCompleted()} of ${memoryTotal()} apps checked` : 'Finding eligible background apps…' : memoryCompleted() ? `${memoryCompleted()} apps checked` : 'A little breathing room for your PC'}</small>
        </div>
        <p class="quick-settings__memory-note">Apps stay open. Windows can reload this memory when needed.</p>
        <div class="quick-settings__memory-actions">
          <button class="quick-settings__scan" disabled={scanning() || reclaiming()} onClick={() => void optimizeMemory()}>
            <Show when={!scanning()} fallback={<LoaderCircle size={14} class="quick-settings__spin"/>}><RefreshCw size={14}/></Show>
            {scanning() ? 'Optimizing…' : reclaiming() ? 'Optimizing…' : 'Optimize memory'}
          </button>
        </div>
        <Show when={memoryResult()}><p class="quick-settings__result" classList={{ 'is-muted': memoryResult().startsWith('No ') }} role="status">{memoryResult()}</p></Show>
        <Show when={memoryError()}><p class="quick-settings__error" role="alert">{memoryError()}</p></Show>
      </div>
    </Show>
  </section>
}
