import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { ArrowLeft, BatteryCharging, BatteryMedium, BatteryWarning, Bluetooth, BluetoothConnected, ChevronRight, Leaf, LoaderCircle, MemoryStick, Moon, MoonStar, Plane, RefreshCw, Sun, SunDim, SunMoon, Volume1, Volume2, VolumeX, Wifi, WifiOff } from 'lucide-solid'
import type { JSX } from 'solid-js'
import { cmd, listen, onMemoryReclaimProgress, type QuickControlsSnapshot, type AppNotification } from '../../lib/ipc'
import { open as islandOpen } from '../../state/ui'
import { reportError } from '../../state/feedback'
import { ingestActionPeek } from '../../state/peek'
import { createSliderCommitter } from '../../lib/sliderCommitter'
import BluetoothView from '../widgets/BluetoothView'
import { settings, patchSettings } from '../../state/settings'
import './QuickSettingsView.css'

/** Shapes the Widgets agent can pick from; `auto` follows the widget's measured size. */
export const QUICK_SETTINGS_ORIENTATIONS = ['auto', 'wide', 'tall', 'compact'] as const
export type QuickSettingsOrientation = (typeof QUICK_SETTINGS_ORIENTATIONS)[number]

type ToggleKey = 'wifi' | 'bluetooth' | 'airplane' | 'nightLight' | 'doNotDisturb' | 'theme'
type Page = 'main' | 'memory' | 'bluetooth'

const [controls, setControls] = createSignal<QuickControlsSnapshot | null>(null)
const [loaded, setLoaded] = createSignal(false)
const [devices, setDevices] = createSignal<string[]>([])
const [deviceError, setDeviceError] = createSignal('')
const [batteryText, setBatteryText] = createSignal('Checking battery')
const [batteryPercent, setBatteryPercent] = createSignal<number | null>(null)
const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set())
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
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const isPending = (id: string) => pending().has(id)
function markPending(id: string, on: boolean): void {
  setPending(previous => { const next = new Set(previous); if (on) next.add(id); else next.delete(id); return next })
}

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

function patchControl(key: keyof QuickControlsSnapshot, value: unknown): void {
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

/** Reads everything from Windows. Pending toggles keep their optimistic value until they settle. */
async function refresh(quiet = false): Promise<void> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = Promise.all([cmd.quickControlsGet(), cmd.devicesGet().catch(() => null)])
    .then(([snapshot, deviceSnapshot]) => {
      const held = pending()
      setControls(previous => {
        if (!previous || held.size === 0) return snapshot
        const merged = { ...snapshot } as Record<string, unknown>
        for (const key of held) if (key in previous) merged[key] = (previous as unknown as Record<string, unknown>)[key]
        return merged as unknown as QuickControlsSnapshot
      })
      setLoaded(true)
      if (typeof snapshot.volume?.level === 'number' && Date.now() - lastSliderInput > 1800) setVolumeLevel(snapshot.volume.level)
      if (typeof snapshot.brightness?.level === 'number' && Date.now() - lastSliderInput > 1800) setBrightnessLevel(snapshot.brightness.level)
      if (deviceSnapshot) { setDevices(deviceSnapshot.bluetooth); setDeviceError(deviceSnapshot.error || '') }
      // Two-way Focus: follow Windows when it changes outside the island.
      const dnd = snapshot.doNotDisturb
      if (!held.has('doNotDisturb') && dnd?.supported && typeof dnd.enabled === 'boolean' && dnd.enabled !== settings.dnd) patchSettings({ dnd: dnd.enabled })
      if (!quiet) setControlError('')
    })
    .catch(error => {
      setLoaded(true)
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

/**
 * Optimistic toggle: flip the tile now, ask Windows, then confirm against the real state
 * (some radios take a moment to report). Any failure puts the tile back.
 */
async function applyToggle(key: ToggleKey, next: boolean, call: () => Promise<unknown>, announce: [string, string] | null, context: string): Promise<void> {
  if (isPending(key)) return
  const previous = controls()?.[key]
  if (!previous) return
  patchControl(key, { ...previous, enabled: next })
  markPending(key, true)
  setControlError('')
  try {
    await call()
    let confirmed = false
    for (let attempt = 0; attempt < 6 && !confirmed; attempt++) {
      const latest = await cmd.quickControlsGet()
      const value = latest[key]
      if (value?.enabled === next) { patchControl(key, value); confirmed = true }
      else await sleep(350)
    }
    if (!confirmed) throw new Error('Windows did not confirm the change. Try again.')
    if (announce) confirmAction(announce[0], announce[1])
  } catch (error) {
    patchControl(key, previous)
    setControlError(errorText(error))
    reportError(context, error)
  } finally {
    markPending(key, false)
  }
}

function onVolumeInput(raw: string): void {
  lastSliderInput = Date.now()
  setControlError('')
  const value = Math.round(Number(raw))
  if (!Number.isFinite(value)) return
  setVolumeLevel(value)
  const volume = controls()?.volume
  if (volume?.muted) patchControl('volume', { ...volume, muted: false })
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
  if (!volume?.supported || volume.muted === null || isPending('mute')) return
  const next = !volume.muted
  patchControl('volume', { ...volume, muted: next })
  markPending('mute', true)
  setControlError('')
  void cmd.setMute(next)
    .then(async () => {
      const latest = await cmd.quickControlsGet()
      if (latest.volume?.muted !== next) throw new Error('Windows did not confirm the mute state. Try again.')
      patchControl('volume', latest.volume)
      if (typeof latest.volume.level === 'number') setVolumeLevel(latest.volume.level)
    })
    .catch(error => {
      patchControl('volume', volume)
      setControlError(errorText(error))
      reportError('Could not change mute', error)
    })
    .finally(() => markPending('mute', false))
}

function toggleDnd(): void {
  const control = controls()?.doNotDisturb
  if (isPending('doNotDisturb')) return
  const current = control?.supported && typeof control.enabled === 'boolean' ? control.enabled : settings.dnd
  const next = !current
  const windowsLive = !!control?.supported && control.enabled !== null
  patchSettings({ dnd: next })
  if (!windowsLive) return
  void applyToggle('doNotDisturb', next, () => cmd.setDoNotDisturb(next), null, 'Could not change Do Not Disturb').then(() => {
    // If Windows refused, the tile rolled back; keep the island's own flag in step with it.
    const confirmed = controls()?.doNotDisturb?.enabled
    if (typeof confirmed === 'boolean') patchSettings({ dnd: confirmed })
  })
}

function togglePowerEfficiency(): void {
  const power = controls()?.powerMode
  if (!power?.supported || (power.bestEfficiencyActive && !power.canRestorePrevious) || isPending('powerMode')) return
  const enable = !power.bestEfficiencyActive
  void (async () => {
    markPending('powerMode', true)
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
      markPending('powerMode', false)
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

function openSettings(page: 'nightlight' | 'bluetooth' | 'power' | 'sound' | 'display' | 'wifi' | 'airplane' | 'colors' | 'battery' | 'focus', context: string): void {
  const action = page === 'nightlight' ? cmd.openNightLightSettings : page === 'bluetooth' ? cmd.openBluetoothSettings : page === 'power' ? cmd.openPowerSettings : () => cmd.openWindowsSettings(page)
  setControlError('')
  void action().catch(error => { setControlError(errorText(error)); reportError(context, error) })
}

/** Capsule slider: the whole track is the control, the glyph sits inside it, drag is 1:1. */
function CapsuleSlider(props: {
  label: string
  caption: string
  value: number
  usable: boolean
  reason: string
  horizontal: boolean
  glyph: JSX.Element
  onValue: (value: number) => void
  onCommit: () => void
  glyphAction?: { label: string; disabled: boolean; run: () => void }
  fallback?: { label: string; run: () => void }
}) {
  const locked = () => !props.usable
  let dragging = false
  const fromPointer = (event: PointerEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const fraction = props.horizontal
      ? (event.clientX - rect.left) / Math.max(1, rect.width)
      : 1 - (event.clientY - rect.top) / Math.max(1, rect.height)
    props.onValue(Math.round(Math.max(0, Math.min(1, fraction)) * 100))
  }
  return <div class="qs-slider" classList={{ 'is-disabled': !props.usable, 'is-horizontal': props.horizontal }} data-no-drag>
    <div class="qs-slider__track" title={props.usable ? `${props.label} ${props.value}%` : props.reason} style={`--pct:${props.usable ? props.value : 0}%`}>
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

type Tint = 'blue' | 'orange' | 'purple' | 'green' | ''
/** One Control Center tile: circle, label, status. Unavailable tiles say why and open Windows settings. */
function Tile(props: { label: string; status: string; icon: JSX.Element; on: boolean; live: boolean; pending?: boolean; tip: string; tint?: Tint; onClick: () => void; loading?: boolean }) {
  return <button type="button" class="quick-settings__tile qs-tile" classList={{ 'is-active': props.on && props.live, 'is-unsupported': !props.live && !props.loading, 'is-pending': !!props.pending, 'is-loading': !!props.loading }}
    data-tint={props.tint || undefined} aria-pressed={props.live ? props.on : undefined} aria-disabled={!props.live || undefined} aria-busy={props.pending || undefined} title={props.tip}
    onClick={() => { if (!props.pending && !props.loading) props.onClick() }}>
    <span class="qs-circle">{props.pending ? <LoaderCircle size={17} class="quick-settings__spin"/> : props.icon}</span>
    <span class="quick-settings__text"><strong>{props.label}</strong><small>{props.status}</small></span>
  </button>
}

export default function QuickSettingsView(props: { shape?: QuickSettingsOrientation }) {
  const [measured, setMeasured] = createSignal<Exclude<QuickSettingsOrientation, 'auto'>>('wide')
  let root: HTMLElement | undefined
  const shape = () => (props.shape && props.shape !== 'auto' ? props.shape : measured())
  onCleanup(() => { commitVolume.cancel(); commitBrightness.cancel() })
  onMount(() => {
    setPage('main')
    let disposed = false
    let unlisten: (() => void) | undefined
    if (root && typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(entries => {
        const box = entries[0]?.contentRect
        if (!box || !box.width || !box.height) return
        setMeasured(box.height < 190 || box.width < 300 ? 'compact' : box.width >= box.height * 1.35 ? 'wide' : 'tall')
      })
      observer.observe(root)
      onCleanup(() => observer.disconnect())
    }
    void onMemoryReclaimProgress(progress => {
      if (!reclaiming()) return
      setMemoryReleased(progress.releasedWorkingSetBytes)
      setMemoryCompleted(progress.completed)
      setMemoryTotal(progress.total)
    }).then(stop => disposed ? stop() : unlisten = stop).catch(() => {})
    onCleanup(() => { disposed = true; unlisten?.() })
    let stateRefresh: ReturnType<typeof setTimeout> | undefined
    let stopControls: (() => void) | undefined
    // Only talk to Windows while the island is open and visible.
    const sync = () => {
      if (disposed || !islandOpen() || document.visibilityState === 'hidden' || page() === 'memory' || commitBrightness.isPending() || commitVolume.isPending() || Date.now() - lastSliderInput <= 1800) return
      void refresh(true)
      void refreshBattery()
    }
    void listen<AppNotification>('device://event', event => {
      if (!['Brightness', 'Volume'].includes(event.payload.app)) return
      clearTimeout(stateRefresh)
      stateRefresh = setTimeout(sync, 300)
    }).then(stop => disposed ? stop() : stopControls = stop).catch(() => {})
    const poll = setInterval(sync, 3000)
    window.addEventListener('focus', sync)
    document.addEventListener('visibilitychange', sync)
    onCleanup(() => { clearInterval(poll); clearTimeout(stateRefresh); stopControls?.(); window.removeEventListener('focus', sync); document.removeEventListener('visibilitychange', sync); setControlError('') })
    void refresh()
    void refreshBattery()
  })

  const volume = () => controls()?.volume
  const brightness = () => controls()?.brightness
  const bluetooth = () => controls()?.bluetooth
  const wifi = () => controls()?.wifi
  const airplane = () => controls()?.airplane
  const theme = () => controls()?.theme
  const batterySaver = () => controls()?.batterySaver
  const powerMode = () => controls()?.powerMode
  const nightLight = () => controls()?.nightLight
  const doNotDisturb = () => controls()?.doNotDisturb
  const volumeUsable = () => !!volume()?.supported && volume()?.level !== null
  const brightnessUsable = () => !!brightness()?.supported
  const unsupportedLabel = 'Not available'
  const live = (control: { supported: boolean; enabled: boolean | null } | undefined) => !!control?.supported && control.enabled !== null && control.enabled !== undefined
  const word = (control: { supported: boolean; enabled: boolean | null } | undefined, on = 'On', off = 'Off') => !loaded() ? '…' : live(control) ? (control!.enabled ? on : off) : unsupportedLabel
  const why = (error: string | null | undefined, fallback: string) => error || fallback
  const hint = (control: { supported: boolean; enabled: boolean | null; error?: string | null } | undefined, state: string, fallback: string) =>
    live(control) ? state : `${why(control?.error, fallback)}. Click to open Windows settings.`
  const powerLive = () => !!powerMode()?.supported && !(powerMode()?.bestEfficiencyActive && !powerMode()?.canRestorePrevious)
  const powerModeLabel = () => powerMode()?.supported
    ? powerMode()?.bestEfficiencyActive ? powerMode()?.canRestorePrevious ? 'Efficiency on' : 'Best efficiency' : powerMode()?.activeName || 'Balanced'
    : unsupportedLabel
  const focusOn = () => doNotDisturb()?.supported && typeof doNotDisturb()?.enabled === 'boolean' ? !!doNotDisturb()?.enabled : settings.dnd
  const volumeGlyph = () => volume()?.muted || volumeLevel() === 0 ? <VolumeX size={20}/> : volumeLevel() < 50 ? <Volume1 size={20}/> : <Volume2 size={20}/>
  const horizontal = () => shape() !== 'wide'

  const flip = (key: ToggleKey, control: { supported: boolean; enabled: boolean | null } | undefined, call: (next: boolean) => Promise<unknown>, announce: (next: boolean) => [string, string] | null, context: string, fallback: () => void) => () => {
    if (!live(control)) { fallback(); return }
    const next = !control!.enabled
    void applyToggle(key, next, () => call(next), announce(next), context)
  }

  const slider = (kind: 'brightness' | 'volume') => kind === 'brightness'
    ? <CapsuleSlider label="Display brightness" caption="Display" value={brightnessLevel()} usable={brightnessUsable()} horizontal={horizontal()}
        reason={why(brightness()?.error, 'Brightness control is not available on this display')}
        glyph={brightnessLevel() < 35 ? <SunDim size={20}/> : <Sun size={20}/>}
        onValue={value => onBrightnessInput(String(value))} onCommit={() => commitBrightness.flush()}
        fallback={{ label: 'Open Display', run: () => openSettings('display', 'Could not open Display settings') }}/>
    : <CapsuleSlider label="System volume" caption="Sound" value={volumeLevel()} usable={volumeUsable()} horizontal={horizontal()}
        reason={why(volume()?.error, 'Volume control is not available on this PC')}
        glyph={volumeGlyph()}
        glyphAction={{ label: volume()?.muted ? 'Unmute' : 'Mute', disabled: !volume()?.supported || volume()?.muted === null || isPending('mute'), run: toggleMute }}
        onValue={value => onVolumeInput(String(value))} onCommit={() => commitVolume.flush()}
        fallback={{ label: 'Open Sound', run: () => openSettings('sound', 'Could not open Sound settings') }}/>

  return <section class="quick-settings" ref={element => (root = element)} data-shape={shape()} aria-label="Quick settings">
    <Show when={page() !== 'main'}>
      <header class="quick-settings__head">
        <button class="quick-settings__back" onClick={() => setPage('main')}><ArrowLeft size={15}/> <span>Quick settings</span></button>
        <strong class="quick-settings__head-title">{page() === 'memory' ? 'Optimize memory' : 'Bluetooth devices'}</strong>
      </header>
    </Show>

    <Show when={page() === 'main'}>
      <div class="quick-settings__overview">
        <div class="qs-body">
          <div class="qs-tiles" role="group" aria-label="Quick toggles">
            <Tile label="Wi-Fi" status={word(wifi())} tint="blue" on={!!wifi()?.enabled} live={live(wifi())} loading={!loaded()} pending={isPending('wifi')}
              icon={wifi()?.enabled || !live(wifi()) ? <Wifi size={18}/> : <WifiOff size={18}/>}
              tip={hint(wifi(), `Wi-Fi ${word(wifi()).toLowerCase()}`, 'Wi-Fi is not available on this PC')}
              onClick={flip('wifi', wifi(), next => cmd.setWifiRadio(next), next => [next ? 'Wi-Fi on' : 'Wi-Fi off', next ? 'Windows radio state changed.' : 'You may lose your network connection.'], 'Could not change Wi-Fi', () => openSettings('wifi', 'Could not open Wi-Fi settings'))}/>
            <Tile label="Bluetooth" status={word(bluetooth())} tint="blue" on={!!bluetooth()?.enabled} live={live(bluetooth())} loading={!loaded()} pending={isPending('bluetooth')}
              icon={<Bluetooth size={18}/>}
              tip={hint(bluetooth(), `Bluetooth ${word(bluetooth()).toLowerCase()}`, 'Bluetooth is not available on this PC')}
              onClick={flip('bluetooth', bluetooth(), next => cmd.setBluetoothRadio(next), next => [next ? 'Bluetooth turned on' : 'Bluetooth turned off', next ? 'Windows radio state changed.' : 'Connected Bluetooth devices may disconnect.'], 'Could not change Bluetooth', () => openSettings('bluetooth', 'Could not open Bluetooth settings'))}/>
            <Tile label="Airplane" status={word(airplane())} tint="orange" on={!!airplane()?.enabled} live={live(airplane())} loading={!loaded()} pending={isPending('airplane')}
              icon={<Plane size={18}/>}
              tip={hint(airplane(), `Airplane mode ${word(airplane()).toLowerCase()}. Turns every wireless radio off.`, 'No wireless radios were found')}
              onClick={flip('airplane', airplane(), next => cmd.setAirplaneMode(next), next => [next ? 'Airplane mode on' : 'Airplane mode off', next ? 'Wi-Fi and Bluetooth are off.' : 'Wireless radios are back on.'], 'Could not change Airplane mode', () => openSettings('airplane', 'Could not open Airplane mode settings'))}/>
            <Tile label="Focus" status={!loaded() && !doNotDisturb() ? (settings.dnd ? 'On' : 'Off') : doNotDisturb()?.supported ? (focusOn() ? 'On' : 'Off') : settings.dnd ? 'Alerts off' : 'Alerts on'} tint="purple" on={focusOn()} live={true} pending={isPending('doNotDisturb')}
              icon={focusOn() ? <MoonStar size={18}/> : <Moon size={18}/>}
              tip={doNotDisturb()?.supported ? 'Do Not Disturb. Also silences Hover Island alerts.' : 'Silences Hover Island alerts. Windows Do Not Disturb is not available here.'}
              onClick={toggleDnd}/>
            <Tile label="Night light" status={word(nightLight())} on={!!nightLight()?.enabled} live={live(nightLight())} loading={!loaded()} pending={isPending('nightLight')}
              icon={<SunDim size={18}/>}
              tip={hint(nightLight(), `Night light ${word(nightLight()).toLowerCase()}`, 'Night light is not set up')}
              onClick={flip('nightLight', nightLight(), next => cmd.setNightLight(next), next => [next ? 'Night light on' : 'Night light off', 'Windows display warmth changed (best effort).'], 'Could not change Night light', () => openSettings('nightlight', 'Could not open Night light settings'))}/>
            <Tile label="Dark mode" status={word(theme(), 'Dark', 'Light')} on={!!theme()?.enabled} live={live(theme())} loading={!loaded()} pending={isPending('theme')}
              icon={<SunMoon size={18}/>}
              tip={hint(theme(), `${word(theme(), 'Dark', 'Light')} theme`, 'Theme control is not available')}
              onClick={flip('theme', theme(), next => cmd.setDarkMode(next), () => null, 'Could not change the theme', () => openSettings('colors', 'Could not open Colors settings'))}/>
            <Tile label="Battery saver" status={batterySaver()?.supported ? (batterySaver()?.enabled ? 'On' : 'Off') : !loaded() ? '…' : unsupportedLabel} tint="green" on={!!batterySaver()?.enabled} live={!!batterySaver()?.supported} loading={!loaded()}
              icon={<BatteryWarning size={18}/>}
              tip={batterySaver()?.supported ? 'Windows does not let apps switch Energy Saver. Click to open its settings.' : `${why(batterySaver()?.error, 'No battery found')}. Click to open Windows settings.`}
              onClick={() => openSettings('battery', 'Could not open Battery settings')}/>
            <Tile label="Power mode" status={powerModeLabel()} tint="green" on={!!powerMode()?.bestEfficiencyActive} live={powerLive()} loading={!loaded()} pending={isPending('powerMode')}
              icon={<Leaf size={18}/>}
              tip={powerMode()?.supported ? powerMode()?.activeName || 'Power mode' : `${why(powerMode()?.error, unsupportedLabel)}. Click to open Windows settings.`}
              onClick={() => powerLive() ? togglePowerEfficiency() : openSettings('power', 'Could not open Power settings')}/>
            <Tile label="Devices" status={devices().length ? devices().length === 1 ? devices()[0] : `${devices().length} connected` : 'Manage paired'} tint="blue" on={devices().length > 0} live={true}
              icon={<BluetoothConnected size={18}/>} tip="Paired Bluetooth devices" onClick={() => setPage('bluetooth')}/>
            <Tile label="Memory" status="Apps stay open" on={false} live={true} icon={<MemoryStick size={18}/>} tip="Free up memory from background apps" onClick={() => setPage('memory')}/>
          </div>
          <div class="qs-sliders" role="group" aria-label="Volume and display brightness">
            {slider('brightness')}
            {slider('volume')}
          </div>
        </div>

        <div class="quick-settings__status qs-module">
          <span class="qs-battery" aria-hidden="true">{batteryText() === 'Charging' ? <BatteryCharging size={17}/> : <BatteryMedium size={17}/>}</span>
          <span class="quick-settings__text"><strong>Battery</strong><small>{batteryPercent() !== null ? `${batteryPercent()}% · ${batteryText()}` : batteryText()}</small></span>
          <button class="quick-settings__link" onClick={() => openSettings('battery', 'Could not open Windows Power & battery')}><Leaf size={14}/> <span class="qs-link-label">Energy Saver &amp; power</span><ChevronRight size={14}/></button>
        </div>
        <Show when={deviceError()}><p class="quick-settings__inline-error" role="status">{deviceError()}</p></Show>
        <Show when={controlError()}><p class="quick-settings__error" role="alert">{controlError()}</p></Show>
      </div>
    </Show>

    <Show when={page() === 'bluetooth'}><div class="quick-settings__sub"><BluetoothView shape={props.shape === 'compact' ? 'compact' : 'auto'}/></div></Show>

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
