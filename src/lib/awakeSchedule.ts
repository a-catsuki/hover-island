/**
 * Schedule rules for "Keep me awake". The native side (src-tauri/src/awake_core.rs) owns the real
 * timers; this module mirrors the same rules so the browser preview behaves alike, and holds the
 * time-picking helpers the widget uses. Everything takes an injected `rng` and `now` so tests are
 * deterministic.
 */

export type AwakeIntensity = 'gentle' | 'medium' | 'relentless'
export type Rng = () => number

export interface IntensityInfo {
  id: AwakeIntensity
  label: string
  /** random gap between check-ins, minutes */
  minMinutes: number
  maxMinutes: number
  /** seconds without an answer before the alarm repeats louder */
  confirmSeconds: number
  hint: string
}

export const INTENSITIES: IntensityInfo[] = [
  { id: 'gentle', label: 'Gentle', minMinutes: 4, maxMinutes: 9, confirmSeconds: 60, hint: 'Every 4 to 9 min' },
  { id: 'medium', label: 'Medium', minMinutes: 2, maxMinutes: 5, confirmSeconds: 40, hint: 'Every 2 to 5 min' },
  { id: 'relentless', label: 'Relentless', minMinutes: 1, maxMinutes: 3, confirmSeconds: 25, hint: 'Every 1 to 3 min' },
]

export const intensityInfo = (id: AwakeIntensity): IntensityInfo => INTENSITIES.find((item) => item.id === id) ?? INTENSITIES[1]

/** No check-in is planned this close to the end; the final alarm covers it. */
export const FINAL_GUARD_MS = 20_000
export const MAX_LEVEL = 4
export const MIN_SESSION_MS = 60_000
export const MAX_SESSION_MS = 18 * 3_600_000

/** A random gap before the next check-in, whole seconds inside the intensity's range. */
export function nextDelayMs(intensity: AwakeIntensity, rng: Rng = Math.random): number {
  const { minMinutes, maxMinutes } = intensityInfo(intensity)
  const low = minMinutes * 60
  const span = (maxMinutes - minMinutes) * 60
  const secs = low + Math.min(span, Math.floor(rng() * (span + 1)))
  return secs * 1000
}

/** The time of the next alarm, or null when it would land too close to the end. */
export function planNextAlarm(from: number, end: number, intensity: AwakeIntensity, rng: Rng = Math.random): number | null {
  const at = from + nextDelayMs(intensity, rng)
  return at > end - FINAL_GUARD_MS ? null : at
}

/** Every alarm that would sound between `from` and `end` if the user always confirms instantly. */
export function planAlarms(from: number, end: number, intensity: AwakeIntensity, rng: Rng = Math.random): number[] {
  const out: number[] = []
  let cursor = from
  for (let guard = 0; guard < 2000; guard++) {
    const at = planNextAlarm(cursor, end, intensity, rng)
    if (at === null) break
    out.push(at)
    cursor = at
  }
  return out
}

/** Volume for an escalation step: each unconfirmed repeat is louder, capped at full volume. */
export function escalatedVolume(base: number, level: number): number {
  const clamped = Math.min(1, Math.max(0.05, base))
  return Math.min(1, clamped * (1 + 0.4 * Math.min(MAX_LEVEL, Math.max(0, level))))
}

/** Which escalation step an unanswered alarm is on after `unansweredMs`. */
export function escalationLevel(unansweredMs: number, confirmSeconds: number): number {
  if (unansweredMs <= 0) return 0
  return Math.min(MAX_LEVEL, Math.floor(unansweredMs / (confirmSeconds * 1000)))
}

/** 0 when the end is far away and the session just started, 1 at the end. Eases so the last stretch feels urgent. */
export function urgency(now: number, start: number, end: number): number {
  const total = end - start
  if (total <= 0) return 1
  const done = Math.min(1, Math.max(0, (now - start) / total))
  // Time left matters more than share complete: the last 30 minutes ramp up regardless of session length.
  const left = Math.max(0, end - now)
  const byLeft = 1 - Math.min(1, left / (30 * 60_000))
  return Math.min(1, Math.max(done * 0.55, byLeft))
}

export type AwakeGlyph = 'coffee' | 'zap' | 'sun'
/** The hero glyph morphs as the end gets closer: coffee, then lightning, then the sun coming up. */
export function glyphFor(now: number, start: number, end: number): AwakeGlyph {
  const total = Math.max(1, end - start)
  const leftShare = (end - now) / total
  const left = end - now
  if (left <= 10 * 60_000 || leftShare <= 0.1) return 'sun'
  if (leftShare <= 0.5) return 'zap'
  return 'coffee'
}

/* ------------------------------------------------------------- picking an end time */

/** The next time the wall clock reads hour:minute, strictly more than a minute from now. */
export function nextClockTime(hour: number, minute: number, now: number): number {
  const date = new Date(now)
  date.setHours(hour, minute, 0, 0)
  if (date.getTime() - now < MIN_SESSION_MS) date.setDate(date.getDate() + 1)
  return date.getTime()
}

export type EndChip = 'until-2' | 'until-4' | 'sunrise' | 'plus-1h' | 'plus-2h'
export const END_CHIPS: Array<{ id: EndChip; label: string }> = [
  { id: 'until-2', label: '2 AM' },
  { id: 'until-4', label: '4 AM' },
  { id: 'sunrise', label: 'Sunrise' },
  { id: 'plus-1h', label: '+1h' },
  { id: 'plus-2h', label: '+2h' },
]

/** Default sunrise when no weather data is available. */
export const DEFAULT_SUNRISE = { hour: 6, minute: 0 }

export function chipEnd(chip: EndChip, now: number, sunrise = DEFAULT_SUNRISE): number {
  switch (chip) {
    case 'until-2': return nextClockTime(2, 0, now)
    case 'until-4': return nextClockTime(4, 0, now)
    case 'sunrise': return nextClockTime(sunrise.hour, sunrise.minute, now)
    case 'plus-1h': return roundToMinute(now + 3_600_000)
    case 'plus-2h': return roundToMinute(now + 2 * 3_600_000)
  }
}

export const roundToMinute = (time: number): number => Math.round(time / 60_000) * 60_000

/** Parse "HH:MM" from a time input. */
export function parseTimeInput(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour > 23 || minute > 59 ? null : { hour, minute }
}

export function toTimeInput(time: number): string {
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function validateEnd(end: number, now: number): string | null {
  if (!Number.isFinite(end)) return 'Pick an end time.'
  if (end - now < MIN_SESSION_MS) return 'Pick a time at least a minute from now.'
  if (end - now > MAX_SESSION_MS) return 'Pick a time within the next 18 hours.'
  return null
}

/* --------------------------------------------------------------------- formatting */

/** 3:05:09 for an hour or more, 4:09 below. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** "2:00 AM" */
export function formatClock(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** "5h 20m left", "42m left", "Under a minute". */
export function formatLeft(ms: number): string {
  if (ms < 60_000) return 'Under a minute'
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes}m left`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h}h ${m}m left` : `${h}h left`
}

/* ------------------------------------------------- the session state machine (preview) */

export interface SessionState {
  start: number
  end: number
  intensity: AwakeIntensity
  nextAlarm: number | null
  /** when the current unanswered alarm started, null when nothing is waiting */
  pendingSince: number | null
  escalateAt: number
  level: number
  alarmCount: number
  seq: number
}

export type SessionEvent =
  | { type: 'alarm'; seq: number; level: number; volumeScale: number }
  | { type: 'finish' }

export function createSession(now: number, end: number, intensity: AwakeIntensity, rng: Rng = Math.random): SessionState {
  return { start: now, end, intensity, nextAlarm: planNextAlarm(now, end, intensity, rng), pendingSince: null, escalateAt: 0, level: 0, alarmCount: 0, seq: 0 }
}

/** Advances the session to `now` and reports what should happen. Mutates and returns the same object. */
export function stepSession(session: SessionState, now: number): SessionEvent | null {
  if (now >= session.end) return { type: 'finish' }
  const confirmMs = intensityInfo(session.intensity).confirmSeconds * 1000
  if (session.pendingSince !== null) {
    if (now >= session.escalateAt) {
      session.level = Math.min(MAX_LEVEL, session.level + 1)
      session.seq += 1
      session.escalateAt = now + confirmMs
      return { type: 'alarm', seq: session.seq, level: session.level, volumeScale: 1 + 0.4 * session.level }
    }
  } else if (session.nextAlarm !== null && now >= session.nextAlarm) {
    session.pendingSince = now
    session.level = 0
    session.alarmCount += 1
    session.seq += 1
    session.escalateAt = now + confirmMs
    session.nextAlarm = null
    return { type: 'alarm', seq: session.seq, level: 0, volumeScale: 1 }
  }
  return null
}

/** The user answered. Optionally push the next alarm out by `snoozeMinutes`. */
export function confirmSession(session: SessionState, now: number, snoozeMinutes = 0, rng: Rng = Math.random): void {
  session.pendingSince = null
  session.level = 0
  if (snoozeMinutes > 0) {
    const until = now + snoozeMinutes * 60_000
    session.nextAlarm = until > session.end - FINAL_GUARD_MS ? null : until
  } else {
    session.nextAlarm = planNextAlarm(now, session.end, session.intensity, rng)
  }
}
