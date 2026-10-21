import { createEffect, createMemo, createRoot, createSignal } from 'solid-js'
import { cmd, listen, type AwakeAlarm, type AwakeIntensity, type AwakeStatus, type AppNotification } from '../lib/ipc'
import { canLoadWeather } from '../lib/weatherLayout'
import { settings } from './settings'
import {
  DEFAULT_SUNRISE, chipEnd, formatClock, formatRemaining, glyphFor, intensityInfo, urgency, validateEnd,
  type AwakeGlyph, type EndChip,
} from '../lib/awakeSchedule'
import { isSoundPack, playPack, primeAudio, type SoundPack } from '../lib/awakeSounds'
import { ingestActionPeek, ingestUrgentPeek, ingestFeedbackToast } from './peek'

/**
 * Keep me awake. The native side (awake.rs) owns the timers, the sleep block and a fallback alarm
 * sound; this module mirrors its status for the widget, plays the chosen WebAudio sound when an
 * alarm arrives and raises the notch peek. It runs for the whole app session, not only while the
 * widget is on screen. The settings window imports the widget registry too, so it stays inert there.
 */

const DRAFT_KEY = 'hover-island.awake.draft.v1'

export interface AwakeDraft { intensity: AwakeIntensity; sound: SoundPack; volume: number }

const IDLE: AwakeStatus = {
  active: false, endEpochMs: 0, startedAtMs: 0, intensity: 'medium', volume: 0.6, sound: 'chimes', nextAlarmAtMs: null, pending: false,
  pendingSinceMs: null, level: 0, alarmCount: 0, seq: 0, lastConfirmedAtMs: null, snoozedUntilMs: null, keepingAwake: false, nowMs: 0,
}

function loadDraft(): AwakeDraft {
  const fallback: AwakeDraft = { intensity: 'medium', sound: 'chimes', volume: 0.6 }
  try {
    const raw = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as Partial<AwakeDraft> | null
    if (!raw) return fallback
    return {
      intensity: raw.intensity === 'gentle' || raw.intensity === 'relentless' ? raw.intensity : 'medium',
      sound: isSoundPack(raw.sound) ? raw.sound : 'chimes',
      volume: typeof raw.volume === 'number' && raw.volume >= 0.05 && raw.volume <= 1 ? raw.volume : 0.6,
    }
  } catch {
    return fallback
  }
}

const isSettingsWindow = typeof location !== 'undefined' && /settings\.html$/.test(location.pathname)

const [status, setStatus] = createSignal<AwakeStatus>(IDLE)
const [now, setNow] = createSignal(Date.now())
const [draft, setDraftSignal] = createSignal<AwakeDraft>(loadDraft())
const [endChoice, setEndChoice] = createSignal<number>(chipEnd('plus-2h', Date.now()))
const [error, setError] = createSignal<string | null>(null)
const [busy, setBusy] = createSignal(false)
/** Rises by one for every alarm so the widget can restart its ripple and shake. */
const [alarmBurst, setAlarmBurst] = createSignal(0)
/** Set when a session reached its end; the widget shows a calm "Nice work" for a few seconds. */
const [celebration, setCelebration] = createSignal<{ endMs: number; startedMs: number; alarms: number } | null>(null)
const [sunrise, setSunrise] = createSignal(DEFAULT_SUNRISE)
let celebrationTimer: ReturnType<typeof setTimeout> | undefined

export { status as awakeStatus, now as awakeNow, draft as awakeDraft, endChoice as awakeEnd, error as awakeError, busy as awakeBusy, alarmBurst, celebration as awakeCelebration, sunrise as awakeSunrise }

export function setAwakeDraft(patch: Partial<AwakeDraft>): void {
  const next = { ...draft(), ...patch }
  setDraftSignal(next)
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(next)) } catch { /* private window */ }
}
export const setAwakeEnd = setEndChoice
export function pickAwakeChip(chip: EndChip): void { setEndChoice(chipEnd(chip, Date.now(), sunrise())) }

/** Sunrise for the "Sunrise" chip comes from the weather widget when a location is set. */
export function refreshSunrise(): void {
  if (!canLoadWeather(settings)) return
  void cmd.weatherGet().then((weather) => {
    const time = Date.now()
    for (const day of weather?.daily ?? []) {
      const match = /T(\d{2}):(\d{2})/.exec(day.sunrise ?? '')
      if (!match) continue
      const parsed = { hour: Number(match[1]), minute: Number(match[2]) }
      if (chipEnd('sunrise', time, parsed) > time) { setSunrise(parsed); return }
    }
  }).catch(() => undefined)
}

/* ------------------------------------------------------------- derived values */

export const awakeActive = () => status().active
export const awakeRemainingMs = () => Math.max(0, status().endEpochMs - now())
export const awakeUrgency = () => (status().active ? urgency(now(), status().startedAtMs, status().endEpochMs) : 0)
export const awakeGlyph = (): AwakeGlyph => glyphFor(now(), status().startedAtMs, status().endEpochMs)
export const awakeProgress = () => {
  const { startedAtMs, endEpochMs } = status()
  return endEpochMs > startedAtMs ? Math.min(1, Math.max(0, (now() - startedAtMs) / (endEpochMs - startedAtMs))) : 0
}
/** Seconds until the unanswered alarm repeats louder (0 when nothing waits). */
export const awakeEscalateInMs = () => {
  const s = status()
  if (!s.pending || s.pendingSinceMs === null) return 0
  const gap = intensityInfo(s.intensity).confirmSeconds * 1000
  const steps = Math.floor(Math.max(0, now() - s.pendingSinceMs) / gap) + 1
  return Math.max(0, s.pendingSinceMs + steps * gap - now())
}
export const awakeConfirmWindowMs = () => intensityInfo(status().intensity).confirmSeconds * 1000

/**
 * What the collapsed pill could show while a session runs: a short countdown and an urgency flag.
 * (CollapsedPill is owned by another agent; it can render this without any other wiring.)
 */
export const awakeLive = createRoot(() => createMemo(() => {
  const s = status()
  if (!s.active) return null
  return { remaining: formatRemaining(Math.max(0, s.endEpochMs - now())), pending: s.pending, urgency: urgency(now(), s.startedAtMs, s.endEpochMs) }
}))

/* ------------------------------------------------------------------- actions */

function apply(next: AwakeStatus | null | undefined): void {
  if (!next) return
  setStatus(next)
  setNow(Date.now())
}

export async function startAwake(): Promise<void> {
  if (busy()) return
  const end = endChoice()
  const problem = validateEnd(end, Date.now())
  if (problem) { setError(problem); return }
  setError(null)
  setBusy(true)
  primeAudio()
  try {
    const d = draft()
    apply(await cmd.awakeStart(end, d.intensity, d.volume, d.sound))
    setCelebration(null)
    ingestFeedbackToast({ id: `awake-start:${end}`, app: 'Keep me awake', text: `Awake until ${formatClock(end)}` })
  } catch (failure) {
    setError(failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : 'Could not start. Try again.')
  } finally {
    setBusy(false)
  }
}

export async function stopAwake(): Promise<void> {
  try { apply(await cmd.awakeStop()) } catch (failure) { setError(typeof failure === 'string' ? failure : 'Could not stop. Try again.') }
}

export async function confirmAwake(snoozeMinutes?: number): Promise<void> {
  primeAudio()
  try { apply(await cmd.awakeConfirm(snoozeMinutes)) } catch (failure) { setError(typeof failure === 'string' ? failure : 'Could not confirm. Try again.') }
}

/** Plays the chosen sound once at the chosen volume. Must run from a click so the browser allows audio. */
export async function previewAwakeSound(): Promise<void> {
  const d = draft()
  primeAudio()
  if (d.sound === 'system') return
  await playPack(d.sound, { volume: d.volume })
}

export function dismissCelebration(): void {
  clearTimeout(celebrationTimer)
  setCelebration(null)
}

/** Buttons offered on the notch peek. The peek renderer calls this with the chosen action id. */
export function awakePeekAction(actionId: string): void {
  if (actionId === 'confirm') void confirmAwake()
  else if (actionId === 'snooze') void confirmAwake(10)
}

/* -------------------------------------------------------------- native events */

const APP_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#FF9F0A"/><path d="M36 10 20 36h11l-3 18 16-27H33z" fill="#fff"/></svg>')}`

function peekFor(alarm: AwakeAlarm): void {
  const base: AppNotification = {
    id: `awake-alarm:${alarm.seq}`, app: 'Keep me awake', title: '', body: '', timestamp: Date.now(), icon: APP_ICON,
    priority: 'urgent', actionOwner: 'awake', actions: [{ id: 'confirm', label: "I'm awake", primary: true }, { id: 'snooze', label: 'Snooze 10 min' }],
  }
  if (alarm.final) {
    ingestActionPeek({ ...base, title: 'Nice work', body: `You made it to ${formatClock(alarm.status.endEpochMs)}.`, priority: 'normal', actions: undefined })
    return
  }
  ingestUrgentPeek({
    ...base,
    title: alarm.level > 0 ? 'Still there? Tap to confirm' : 'Still here? Tap to confirm',
    body: `${formatRemaining(Math.max(0, alarm.status.endEpochMs - Date.now()))} to go`,
  })
}

async function handleAlarm(alarm: AwakeAlarm): Promise<void> {
  apply(alarm.status)
  setAlarmBurst((count) => count + 1)
  peekFor(alarm)
  const pack: SoundPack = isSoundPack(alarm.sound) ? alarm.sound : 'chimes'
  // The Windows sound is played natively. Anything else plays here, and the native side only steps in if this cannot.
  if (pack === 'system' && !alarm.final) return
  const played = await playPack(pack, { volume: alarm.volume, level: alarm.level, final: alarm.final })
  if (played) void cmd.awakeAudioAck(alarm.seq).catch(() => undefined)
}

function handleFinished(final: AwakeStatus): void {
  const startedMs = final.startedAtMs || status().startedAtMs
  const endMs = final.endEpochMs || status().endEpochMs
  const alarms = final.alarmCount || status().alarmCount
  setCelebration({ endMs, startedMs, alarms })
  clearTimeout(celebrationTimer)
  celebrationTimer = setTimeout(() => setCelebration(null), 9000)
}

let started = false
function start(): void {
  if (started || isSettingsWindow) return
  started = true
  void cmd.awakeStatus().then(apply).catch(() => undefined)
  const guard = <T,>(handler: (payload: T) => void) => (event: { payload: T }) => handler(event.payload)
  void listen<AwakeStatus>('awake://state', guard(apply))
  void listen<AwakeStatus>('awake://tick', guard(apply))
  void listen<AwakeAlarm>('awake://alarm', guard((alarm) => { void handleAlarm(alarm) }))
  void listen<AwakeStatus>('awake://finished', guard(handleFinished))

  createRoot(() => {
    // One-second clock while a session runs (or the closing animation shows).
    let interval: ReturnType<typeof setInterval> | undefined
    createEffect(() => {
      const running = status().active || celebration() !== null
      if (running && interval === undefined) interval = setInterval(() => setNow(Date.now()), 1000)
      if (!running && interval !== undefined) { clearInterval(interval); interval = undefined }
    })
    // Enter, Space or A answers a waiting alarm when no text field has focus.
    createEffect(() => {
      if (!status().pending) return
      const onKey = (event: KeyboardEvent) => {
        const target = event.target as HTMLElement | null
        if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
        if (event.key === 'Enter' || event.key === ' ' || event.key.toLowerCase() === 'a') {
          event.preventDefault()
          void confirmAwake()
        }
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    })
  })
}
start()
