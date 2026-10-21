import { createSignal } from 'solid-js'

/**
 * Pomodoro timer state. The timer stores an absolute `endsAt` timestamp rather than
 * counting down, so it stays correct across throttled intervals, a closed island and
 * an app restart. It runs its own ticker while a session is active, so it no longer
 * depends on the window being open to notice that time is up.
 */
const KEY = 'hover-island.focus.v1'

export type FocusMode = 'focus' | 'short' | 'long'
export const FOCUS_MODES: FocusMode[] = ['focus', 'short', 'long']
export const FOCUS_MODE_LABEL: Record<FocusMode, string> = { focus: 'Focus', short: 'Break', long: 'Long break' }
/** A long break follows every this many focus sessions. */
export const SESSIONS_PER_CYCLE = 4
const MIN_MINUTES = 1
const MAX_MINUTES = 180
const DEFAULT_MINUTES: Record<FocusMode, number> = { focus: 25, short: 5, long: 15 }
/** A finish older than this (the app was closed meanwhile) completes quietly. */
const FRESH_FINISH_MS = 90_000

export interface FocusTimer {
  mode: FocusMode
  /** seconds in the current mode */
  duration: number
  /** seconds left */
  remaining: number
  /** epoch ms the session ends, null when paused or idle */
  endsAt: number | null
  /** the last session ran out and the next mode is waiting to start */
  completed: boolean
  /** minutes for each mode */
  durations: Record<FocusMode, number>
  /** focus sessions finished on `day` */
  sessions: number
  day: string
  /** show a notch alert and chime when a session ends */
  alerts: boolean
}

export interface FocusFinished {
  finished: FocusMode
  next: FocusMode
  sessions: number
}

const dayKey = (time = Date.now()) => {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
const clampMinutes = (minutes: number) => Math.round(Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, minutes)))
const isMode = (value: unknown): value is FocusMode => value === 'focus' || value === 'short' || value === 'long'

const defaults = (): FocusTimer => ({
  mode: 'focus', duration: DEFAULT_MINUTES.focus * 60, remaining: DEFAULT_MINUTES.focus * 60, endsAt: null, completed: false,
  durations: { ...DEFAULT_MINUTES }, sessions: 0, day: dayKey(), alerts: true,
})

function restore(): FocusTimer {
  try {
    const item = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<FocusTimer> | null
    if (item && Number.isInteger(item.duration) && item.duration! >= 60 && item.duration! <= 10800
      && Number.isFinite(item.remaining) && item.remaining! >= 0 && item.remaining! <= item.duration!
      && typeof item.completed === 'boolean' && (item.endsAt === null || Number.isFinite(item.endsAt))) {
      const base = defaults()
      const mode = isMode(item.mode) ? item.mode : 'focus'
      const durations = { ...base.durations }
      for (const key of FOCUS_MODES) {
        const minutes = item.durations?.[key]
        if (Number.isInteger(minutes) && minutes! >= MIN_MINUTES && minutes! <= MAX_MINUTES) durations[key] = minutes!
      }
      // The running duration always wins, which also carries over a v1 save.
      if (item.duration! % 60 === 0) durations[mode] = item.duration! / 60
      const sameDay = item.day === base.day
      return {
        mode, duration: item.duration!, remaining: item.remaining!, endsAt: item.endsAt ?? null, completed: item.completed,
        durations, sessions: sameDay && Number.isInteger(item.sessions) && item.sessions! >= 0 ? item.sessions! : 0, day: base.day,
        alerts: item.alerts !== false,
      }
    }
  } catch { /* fall through to a fresh timer */ }
  return defaults()
}

const [focusTimer, setFocusTimer] = createSignal(restore())
const listeners = new Set<(event: FocusFinished) => void>()
let ticker: ReturnType<typeof setInterval> | undefined

const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(focusTimer())) } catch { /* storage can be unavailable */ } }
function syncTicker() {
  const running = !!focusTimer().endsAt
  if (running && ticker === undefined && typeof setInterval === 'function') ticker = setInterval(tickFocus, 500)
  else if (!running && ticker !== undefined) { clearInterval(ticker); ticker = undefined }
}
function commit(next: FocusTimer) {
  setFocusTimer(next)
  persist()
  syncTicker()
}
/** A new day starts the session count over. */
const rolled = (item: FocusTimer): FocusTimer => item.day === dayKey() ? item : { ...item, day: dayKey(), sessions: 0 }
const nextModeAfter = (mode: FocusMode, sessions: number): FocusMode =>
  mode !== 'focus' ? 'focus' : sessions % SESSIONS_PER_CYCLE === 0 ? 'long' : 'short'

function finish(item: FocusTimer) {
  const base = rolled(item)
  const sessions = item.mode === 'focus' ? base.sessions + 1 : base.sessions
  const mode = nextModeAfter(item.mode, sessions)
  const duration = base.durations[mode] * 60
  commit({ ...base, mode, duration, remaining: duration, endsAt: null, completed: true, sessions })
  const fresh = item.endsAt !== null && Date.now() - item.endsAt < FRESH_FINISH_MS
  if (fresh && item.alerts) for (const listener of [...listeners]) {
    try { listener({ finished: item.mode, next: mode, sessions }) } catch { /* one bad listener must not stop the timer */ }
  }
}

/** Advance the countdown. Safe to call as often as you like. */
export function tickFocus(): void {
  const item = focusTimer()
  if (!item.endsAt) return
  const remaining = Math.max(0, Math.ceil((item.endsAt - Date.now()) / 1000))
  if (remaining > 0) {
    if (remaining !== item.remaining) setFocusTimer({ ...item, remaining })
    return
  }
  finish(item)
}

export function startFocus(): void {
  const item = rolled(focusTimer())
  if (item.endsAt) return
  const remaining = item.remaining || item.duration
  commit({ ...item, remaining, endsAt: Date.now() + remaining * 1000, completed: false })
}

export function pauseFocus(): void {
  tickFocus()
  const item = focusTimer()
  if (!item.endsAt) return
  commit({ ...item, remaining: Math.max(1, Math.ceil((item.endsAt - Date.now()) / 1000)), endsAt: null })
}

/** Put the current mode back to its full length; with `minutes` it also saves that length for the mode. */
export function resetFocus(minutes?: number): void {
  const item = focusTimer()
  let durations = item.durations
  if (minutes !== undefined) {
    if (!Number.isFinite(minutes)) return
    durations = { ...durations, [item.mode]: clampMinutes(minutes) }
  }
  const duration = durations[item.mode] * 60
  commit({ ...rolled(item), durations, duration, remaining: duration, endsAt: null, completed: false })
}

/** Step the current mode's length up or down; focus moves in fives, breaks in ones. */
export function nudgeFocusMinutes(direction: 1 | -1): void {
  const item = focusTimer()
  if (item.endsAt) return
  const minutes = item.durations[item.mode]
  const step = item.mode === 'focus' ? 5 : 1
  const next = step === 1 ? minutes + direction : direction > 0 ? Math.floor(minutes / step) * step + step : Math.ceil(minutes / step) * step - step
  resetFocus(next)
}

export function setFocusMode(mode: FocusMode): void {
  const item = focusTimer()
  if (item.endsAt || !isMode(mode)) return
  const duration = item.durations[mode] * 60
  commit({ ...rolled(item), mode, duration, remaining: duration, endsAt: null, completed: false })
}

/** Jump to the next mode without counting a finished session. */
export function skipFocus(): void {
  const item = focusTimer()
  const mode: FocusMode = item.mode === 'focus' ? 'short' : 'focus'
  const duration = item.durations[mode] * 60
  commit({ ...rolled(item), mode, duration, remaining: duration, endsAt: null, completed: false })
}

export function toggleFocusAlerts(): void {
  commit({ ...focusTimer(), alerts: !focusTimer().alerts })
}

export function clearFocusSessions(): void {
  commit({ ...focusTimer(), sessions: 0, day: dayKey() })
}

/** Sessions finished today, even if the app was left open past midnight. */
export const focusSessionsToday = () => focusTimer().day === dayKey() ? focusTimer().sessions : 0

/** Subscribe to the moment a session runs out. Returns an unsubscribe function. */
export function onFocusComplete(listener: (event: FocusFinished) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const formatFocus = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`

export { focusTimer }

// A session that was running when the app closed resumes counting, or completes quietly.
syncTicker()
tickFocus()
