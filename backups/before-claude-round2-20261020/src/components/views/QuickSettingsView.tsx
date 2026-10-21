import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { ArrowLeft, BatteryCharging, BatteryMedium, Bluetooth, BluetoothConnected, ChevronRight, Leaf, LoaderCircle, MemoryStick, Moon, RefreshCw, Sun, SunDim, Volume1, Volume2, VolumeX } from 'lucide-solid'
import type { JSX } from 'solid-js'
import { cmd, listen, onMemoryReclaimProgress, type QuickControlsSnapshot, type AppNotification } from '../../lib/ipc'
import { open as islandOpen } from '../../state/ui'
import { reportError } from '../../state/feedback'
import { ingestActionPeek } from '../../state/peek'
import { createSliderCommitter } from '../../lib/sliderCommitter'
import BluetoothView from '../widgets/BluetoothView'
import { settings, patchSettings, flushSettings } from '../../state/settings'
import './QuickSettingsView.css'

type ControlKey = 'volume' | 'brightness' | 'bluetooth' | 'powerMode' | 'nightLight' | 'doNotDisturb'

const [controls, setControls] = createSignal<QuickControlsSnapshot | null>(null)
const [devices, setDevices] = createSignal<string[]>([])
const [deviceError, setDeviceError] = createSignal('')
const [batteryText, setBatteryText] = createSignal('Checking battery')
const [batteryPercent, setBatteryPercent] = createSignal<number | null>(null)
const [busy, setBusy] = createSignal(false)
const [controlError, setControlErrorValue] = createSignal('')
let controlErrorExpiry: ReturnType<typeof setTimeout> | undefined
function setControlError(message: string): void {
  clearTimeout(controlErrorExpiry)
  setControlErrorValue(message)
  if (message) controlErrorExpiry = setTimeout(() => setControlErrorValue(''), 6000)
}
let lastSliderInput = 0
const [volumeLevel, setVolumeLevel] = createSignal(0)
const [brightnessLevel, setBrightnessLevel] = createSignal(0)
type Page = 'main' | 'memory' | 'bluetooth'
const [page, setPage] = createSignal<Page>('main')
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
  error => {
    setControlError(`Could not set system volume: ${errorText(error)}`)
    reportError('Could not set the system volume', error)
  },
  80, () => void restoreSliderReadback('volume'),
)
const commitBrightness = createSliderCommitter(
  value => cmd.setBrightness(value),
  error => {
    setControlError(`Could not set display brightness: ${errorText(error)}`)
    reportError('Could not set the display brightness', error)
  },
  80, () => void restoreSliderReadback('brightness'),
)

function patchControl<K extends ControlKey>(key: K, value: QuickControlsSnapshot[K]): void {
  setControls(previous => (previous ? { ...previous, [key]: value } : previous))
}

async function restoreSliderReadback(key: 'volume' | 'brightness'): Promise<void> {
  const inputRevision = lastSliderInput
  try {
    const latest = await cmd.quickControlsGet()
    if (inputRevision !== lastSliderInput) return
    const control = latest[key]
    patchControl(key, control)
    if (typeof control?.level === 'number') {
      if (key === 'volume') setVolumeLevel(control.level)
      else setBrightnessLevel(control.level)
    }
  } catch {
    setControlError('The change failed and Windows could not confirm the current value. Try again.')
  }
}

async function refresh(quiet = false): Promise<void> {
  if (refreshInFlight) return refreshInFlight
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
      if (!quiet) { setControlError(errorText(error)); reportError('Could not read Windows quick controls', error) }
    })
    .finally(() => { refreshInFlight = undefined })
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
    if (verified?.enabled !== next) throw new Error('Windows did not confirm the requested setting. Try again.')
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
  lastSliderInput = Date.now()
  setControlError('')
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
  lastSliderInput = Date.now()
  setControlError('')
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
    .then(async () => {
      const latest = await cmd.quickControlsGet()
      if (latest.volume?.muted !== next) throw new Error('Windows did not confirm the mute state. Try again.')
      patchControl('volume', latest.volume)
      if (typeof latest.volume.level === 'number') setVolumeLevel(latest.volume.level)
      confirmAction(next ? 'Muted' : 'Unmuted', next ? 'System volume is muted.' : 'System volume is back on.')
    })
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
        try {
          await cmd.setDoNotDisturb(next)
          const latest = await cmd.quickControlsGet()
          if (latest.doNotDisturb?.enabled !== next) {
            setControlError(`Notch alerts ${next ? 'are silenced' : 'are on'}, but Windows Do Not Disturb did not confirm the change.`)
          } else patchControl('doNotDisturb', latest.doNotDisturb)
        } catch { setControlError(`Notch alerts ${next ? 'are silenced' : 'are on'}, but Windows Do Not Disturb could not be changed.`) }
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
      const latest = await cmd.quickControlsGet()
      if (latest.powerMode?.bestEfficiencyActive !== enable) throw new Error('Windows did not confirm the requested power mode. Try again.')
      patchControl('powerMode', latest.powerMode)
      confirmAction(enable ? 'Best power efficiency enabled' : 'Previous power mode restored', enable ? 'Windows selected Best power efficiency. Energy Saver is a separate Windows setting.' : 'Windows restored the power modes that were active before this change.')
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

async function refreshBattery(): Promise<void> {
  try {
    const stats = await cmd.systemStats()
    setBatteryPercent(stats.batteryPercent === null ? null : Math.round(stats.batteryPercent))
    setBatteryText(stats.batteryPercent === null ? 'No battery detected' : stats.charging ? 'Charging' : 'On battery')
  } catch { setBatteryPercent(null); setBatteryText('Battery status unavailable') }
}

function openSettings(url: 'nightlight' | 'bluetooth' | 'power' | 'sound' | 'display', context: string): void {
  const action = url === 'nightlight' ? cmd.openNightLightSettings : url === 'bluetooth' ? cmd.openBluetoothSettings : url === 'power' ? cmd.openPowerSettings : () => cmd.openWindowsSettings(url)
  setControlError('')
  void action().catch(error => { setControlError(errorText(error)); reportError(context, error) })
}

/** Capsule slider: the whole track is the control, the glyph sits inside it, drag is 1:1. */
function CapsuleSlider(props: {
  label: string
  caption: string
  value: number
  usable: boolean
  busy: boolean
  reason: string
  glyph: JSX.Element
  onValue: (value: number) => void
  onCommit: () => void
  glyphAction?: { label: string; disabled: boolean; run: () => void }
  fallback?: { label: string; run: () => void }
}) {
  const locked = () => !props.usable || props.busy
  let dragging = false
  const fromPointer = (event: PointerEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const fraction = 1 - (event.clientY - rect.top) / Math.max(1, rect.height)
    props.onValue(Math.round(Math.max(0, Math.min(1, fraction)) * 100))
  }
  return <div class="qs-slider" classList={{ 'is-disabled': !props.usable }} data-no-drag>
    <div class="qs-slider__track" title={props.usable ? undefined : props.reason} style={`--pct:${props.usable ? props.value : 0}%`}>
      <span class="qs-slider__fill" aria-hidden="true"/>
      <input class="qs-slider__input" type="range" min="0" max="100" step="1" aria-label={props.label}
        disabled={locked()} value={props.value}
        onInput={event => props.onValue(Math.round(Number(event.currentTarget.value)))} onChange={() => props.onCommit()}
        on:pointerdown={event => { if (locked() || event.button !== 0) return; event.preventDefault(); dragging = true; event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId); fromPointer(event) }}
        on:pointermove={event => { if (dragging) fromPointer(event) }}
        on:pointerup={event => { if (!dragging) return; dragging = false; try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* released */ } props.onCommit() }}
        on:pointercancel={() => { if (dragging) { dragging = false; props.onCommit() } }}/>
      <Show when={props.glyphAction} fallback={<span class="qs-slider__glyph" classList={{ 'is-on-fill': props.usable && props.value > 12 }} aria-hidden="true">{props.glyph}</span>}>
        {action => <button type="button" class="qs-slider__glyph qs-slider__glyph--button" classList={{ 'is-on-fill': props.usable && props.value > 12 }}
          aria-label={action().label} title={action().label} disabled={action().disabled} onClick={action().run}>{props.glyph}</button>}
      </Show>
    </div>
    <Show when={props.usable || !props.fallback} fallback={<button type="button" class="qs-slider__fallback" title={props.reason} onClick={props.fallback!.run}>{props.fallback!.label}</button>}>
      <span class="qs-slider__caption"><strong>{props.caption}</strong><small>{props.usable ? `${props.value}%` : 'Unavailable'}</small></span>
    </Show>
  </div>
}

export default function QuickSettingsView() {
  onCleanup(() => { commitVolume.cancel(); commitBrightness.cancel() })
  onMount(() => {
    setPage('main')
    let disposed = false
    let unlisten: (() => void) | undefined
    void onMemoryReclaimProgress(progress => {
      if (!reclaiming()) return
      setMemoryReleased(progress.releasedWorkingSetBytes)
      setMemoryCompleted(progress.completed)
      setMemoryTotal(progress.total)
    }).then(stop => disposed ? stop() : unlisten = stop).catch(() => {})
    onCleanup(() => { disposed = true; unlisten?.() })
    let stateRefresh: ReturnType<typeof setTimeout> | undefined
    let stopControls: (() => void) | undefined
    const sync = () => {
      if (disposed || !islandOpen() || busy() || commitBrightness.isPending() || commitVolume.isPending() || Date.now() - lastSliderInput <= 1800) return
      void refresh(true)
      void refreshBattery()
    }
    void listen<AppNotification>('device://event', event => {
      if (!['Brightness', 'Volume'].includes(event.payload.app)) return
      clearTimeout(stateRefresh)
      stateRefresh = setTimeout(sync, 300)
    }).then(stop => disposed ? stop() : stopControls = stop).catch(() => {})
    const poll = setInterval(sync, 5000)
    window.addEventListener('focus', sync)
    onCleanup(() => { clearInterval(poll); clearTimeout(stateRefresh); stopControls?.(); window.removeEventListener('focus', sync); setControlError('') })
    void refresh()
    void refreshBattery()
  })

  const volume = () => controls()?.volume
  const brightness = () => controls()?.brightness
  const bluetooth = () => controls()?.bluetooth
  const powerMode = () => controls()?.powerMode
  const nightLight = () => controls()?.nightLight
  const doNotDisturb = () => controls()?.doNotDisturb
  const volumeUsable = () => !!volume()?.supported && volume()?.level !== null
  const brightnessUsable = () => !!brightness()?.supported
  const unsupportedLabel = 'Not available on this PC'
  const reasonFor = (error: string | null | undefined, fallback: string) => error || fallback
  const toggleLabel = (control: { supported: boolean; enabled: boolean | null } | undefined) =>
    control?.supported ? control.enabled === null ? 'Status unavailable' : control.enabled ? 'On' : 'Off' : unsupportedLabel
  const bluetoothLive = () => !!bluetooth()?.supported && bluetooth()?.enabled !== null
  const nightLightLive = () => !!nightLight()?.supported && nightLight()?.enabled !== null
  const powerLive = () => !!powerMode()?.supported && !(powerMode()?.bestEfficiencyActive && !powerMode()?.canRestorePrevious)
  const powerModeLabel = () => powerMode()?.supported
    ? powerMode()?.bestEfficiencyActive ? powerMode()?.canRestorePrevious ? 'Efficiency on' : 'Best efficiency' : powerMode()?.activeName || 'Balanced'
    : unsupportedLabel
  const focusLabel = () => settings.dnd ? 'Alerts off' : 'Alerts on'
  const volumeGlyph = () => volume()?.muted || volumeLevel() === 0 ? <VolumeX size={20}/> : volumeLevel() < 50 ? <Volume1 size={20}/> : <Volume2 size={20}/>

  const settingsHint = (reason: string) => `${reason}. Click to open Windows settings.`

  return <section class="quick-settings" aria-label="Quick settings">
    <Show when={page() !== 'main'}>
      <header class="quick-settings__head">
        <button class="quick-settings__back" onClick={() => setPage('main')}><ArrowLeft size={15}/> <span>Quick settings</span></button>
        <strong class="quick-settings__head-title">{page() === 'memory' ? 'Optimize memory' : 'Bluetooth devices'}</strong>
      </header>
    </Show>

    <Show when={page() === 'main'}>
      <div class="quick-settings__overview">
        <div class="qs-grid">
          <div class="qs-module qs-module--connect" role="group" aria-label="Connectivity">
            <button class="quick-settings__tile qs-row" classList={{ 'is-active': !!bluetooth()?.enabled, 'is-unsupported': !bluetoothLive() }} disabled={busy()}
              aria-pressed={bluetoothLive() ? !!bluetooth()?.enabled : undefined}
              title={bluetoothLive() ? toggleLabel(bluetooth()) : settingsHint(reasonFor(bluetooth()?.error, unsupportedLabel))}
              onClick={() => bluetoothLive() ? toggleBluetooth() : openSettings('bluetooth', 'Could not open Bluetooth settings')}>
              <span class="qs-circle qs-circle--blue"><Bluetooth size={18}/></span>
              <span class="quick-settings__text"><strong>Bluetooth</strong><small>{bluetoothLive() ? toggleLabel(bluetooth()) : unsupportedLabel}</small></span>
            </button>
            <button class="quick-settings__tile qs-row" classList={{ 'is-active': devices().length > 0 }} onClick={() => setPage('bluetooth')} title="Manage paired devices">
              <span class="qs-circle qs-circle--blue"><BluetoothConnected size={18}/></span>
              <span class="quick-settings__text"><strong>Devices</strong><small>{devices().length ? devices().length === 1 ? devices()[0] : `${devices().length} connected` : 'Manage paired'}</small></span>
            </button>
          </div>

          <button class="quick-settings__tile qs-module qs-module--focus" classList={{ 'is-active': settings.dnd }} disabled={busy()} aria-pressed={settings.dnd}
            title={doNotDisturb()?.error || 'Silence Hover Island alerts. Windows focus follows when it can.'} onClick={toggleDnd}>
            <span class="qs-circle"><Moon size={19}/></span>
            <span class="quick-settings__text"><strong>Focus</strong><small>{focusLabel()}{doNotDisturb()?.supported && doNotDisturb()?.enabled !== null ? ` · Windows ${doNotDisturb()?.enabled ? 'on' : 'off'}` : ''}</small></span>
          </button>

          <div class="qs-sliders" role="group" aria-label="Volume and display brightness">
            <CapsuleSlider label="Display brightness" caption="Display" value={brightnessLevel()} usable={brightnessUsable()} busy={busy()}
              reason={reasonFor(brightness()?.error, 'Brightness control is not available on this display')}
              glyph={brightnessLevel() < 35 ? <SunDim size={20}/> : <Sun size={20}/>}
              onValue={value => onBrightnessInput(String(value))} onCommit={() => commitBrightness.flush()}
              fallback={{ label: 'Open Display', run: () => openSettings('display', 'Could not open Display settings') }}/>
            <CapsuleSlider label="System volume" caption="Sound" value={volumeLevel()} usable={volumeUsable()} busy={busy()}
              reason={reasonFor(volume()?.error, 'Volume control is not available on this PC')}
              glyph={volumeGlyph()}
              glyphAction={{ label: volume()?.muted ? 'Unmute' : 'Mute', disabled: !volume()?.supported || volume()?.muted === null || busy(), run: toggleMute }}
              onValue={value => onVolumeInput(String(value))} onCommit={() => commitVolume.flush()}
              fallback={{ label: 'Open Sound', run: () => openSettings('sound', 'Could not open Sound settings') }}/>
          </div>

          <button class="quick-settings__tile qs-module qs-tile" classList={{ 'is-active': !!nightLight()?.enabled, 'is-unsupported': !nightLightLive() }} disabled={busy()}
            aria-pressed={nightLightLive() ? !!nightLight()?.enabled : undefined}
            title={nightLightLive() ? toggleLabel(nightLight()) : settingsHint(reasonFor(nightLight()?.error, unsupportedLabel))}
            onClick={() => nightLightLive() ? toggleNightLight() : openSettings('nightlight', 'Could not open Night light settings')}>
            <span class="qs-circle"><Sun size={19}/></span>
            <span class="quick-settings__text"><strong>Night light</strong><small>{toggleLabel(nightLight())}</small></span>
          </button>

          <button class="quick-settings__tile qs-module qs-tile" classList={{ 'is-active': !!powerMode()?.bestEfficiencyActive, 'is-unsupported': !powerMode()?.supported }} disabled={busy()}
            aria-pressed={powerMode()?.supported ? !!powerMode()?.bestEfficiencyActive : undefined}
            title={powerMode()?.supported ? powerMode()?.activeName || 'Power mode' : settingsHint(reasonFor(powerMode()?.error, unsupportedLabel))}
            onClick={() => powerLive() ? togglePowerEfficiency() : openSettings('power', 'Could not open Power settings')}>
            <span class="qs-circle"><Leaf size={19}/></span>
            <span class="quick-settings__text"><strong>Power mode</strong><small>{powerModeLabel()}</small></span>
          </button>

          <button class="quick-settings__memory-head qs-module qs-tile" onClick={() => setPage('memory')}>
            <span class="qs-circle"><MemoryStick size={19}/></span>
            <span class="quick-settings__text"><strong>Optimize memory</strong><small>Apps stay open</small></span>
          </button>
        </div>

        <div class="quick-settings__status qs-module">
          <span class="qs-battery" aria-hidden="true">{batteryText() === 'Charging' ? <BatteryCharging size={17}/> : <BatteryMedium size={17}/>}</span>
          <span class="quick-settings__text"><strong>Battery</strong><small>{batteryPercent() !== null ? `${batteryPercent()}% · ${batteryText()}` : batteryText()}</small></span>
          <button class="quick-settings__link" onClick={() => openSettings('power', 'Could not open Windows Power & battery')}><Leaf size={14}/> <span>Energy Saver &amp; power</span><ChevronRight size={14}/></button>
        </div>
        <Show when={deviceError()}><p class="quick-settings__inline-error" role="status">{deviceError()}</p></Show>
        <Show when={controlError()}><p class="quick-settings__error" role="alert">{controlError()}</p></Show>
      </div>
    </Show>

    <Show when={page() === 'bluetooth'}><div class="quick-settings__sub"><BluetoothView/></div></Show>

    <Show when={page() === 'memory'}>
      <div class="quick-settings__memory-page">
        <div class="memory-meter" classList={{ 'memory-meter--running': reclaiming() }} aria-live="polite">
          <span>Background memory released</span>
          <strong>{Math.round(memoryReleased() / 1024 / 1024).toLocaleString()}<small>MB</small></strong>
          <progress aria-label="Memory optimization progress" max={Math.max(1, memoryTotal())} value={memoryCompleted()}/>
          <small>{reclaiming() ? memoryTotal() ? `${memoryCompleted()} of ${memoryTotal()} apps checked` : 'Finding background apps' : memoryCompleted() ? `${memoryCompleted()} apps checked` : 'Frees up a little room on your PC'}</small>
        </div>
        <p class="quick-settings__memory-note">Apps stay open. Windows can reload this memory when needed.</p>
        <div class="quick-settings__memory-actions">
          <button class="quick-settings__scan" disabled={scanning() || reclaiming()} onClick={() => void optimizeMemory()}>
            <Show when={!scanning()} fallback={<LoaderCircle size={14} class="quick-settings__spin"/>}><RefreshCw size={14}/></Show>
            {scanning() || reclaiming() ? 'Optimizing' : 'Optimize memory'}
          </button>
        </div>
        <Show when={memoryResult()}><p class="quick-settings__result" classList={{ 'is-muted': memoryResult().startsWith('No ') }} role="status">{memoryResult()}</p></Show>
        <Show when={memoryError()}><p class="quick-settings__error" role="alert">{memoryError()}</p></Show>
        <Show when={controlError()}><p class="quick-settings__error" role="alert">{controlError()}</p></Show>
      </div>
    </Show>
  </section>
}
