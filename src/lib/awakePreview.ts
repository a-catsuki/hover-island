// Browser-preview stand-in for src-tauri/src/awake.rs: the same session rules (awakeSchedule.ts) on a
// JS timer, so the widget and its alarms can be tried without the desktop app.
import type { AwakeIntensity, AwakeStatus } from './ipc'
import { confirmSession, createSession, escalatedVolume, stepSession, validateEnd, type SessionState } from './awakeSchedule'

type Emit = (name: string, payload: unknown) => void

let session: SessionState | null = null
let params = { volume: 0.6, sound: 'chimes' }
let timer: ReturnType<typeof setInterval> | undefined
let seeded = false

const flag = (): string | null => {
  try { return JSON.parse(localStorage.getItem('hover-island.preview.awake') ?? 'null') } catch { return null }
}

function status(now = Date.now()): AwakeStatus {
  if (!session) {
    return { active: false, endEpochMs: 0, startedAtMs: 0, intensity: 'medium', volume: params.volume, sound: params.sound, nextAlarmAtMs: null, pending: false, pendingSinceMs: null, level: 0, alarmCount: 0, seq: 0, lastConfirmedAtMs: null, snoozedUntilMs: null, keepingAwake: false, nowMs: now }
  }
  return {
    active: true, endEpochMs: session.end, startedAtMs: session.start, intensity: session.intensity, volume: params.volume, sound: params.sound,
    nextAlarmAtMs: session.pendingSince === null ? session.nextAlarm : null, pending: session.pendingSince !== null, pendingSinceMs: session.pendingSince,
    level: session.level, alarmCount: session.alarmCount, seq: session.seq, lastConfirmedAtMs: null, snoozedUntilMs: null, keepingAwake: true, nowMs: now,
  }
}

function run(emit: Emit) {
  clearInterval(timer)
  timer = setInterval(() => {
    if (!session) { clearInterval(timer); return }
    const now = Date.now()
    const event = stepSession(session, now)
    if (!event) return
    if (event.type === 'finish') {
      const final = { seq: session.seq + 1, level: 0, final: true, volume: Math.min(0.7, params.volume), sound: params.sound, status: status(now) }
      session = null
      clearInterval(timer)
      emit('awake://alarm', final)
      emit('awake://finished', status(now))
      emit('awake://state', status(now))
      return
    }
    emit('awake://alarm', { seq: event.seq, level: event.level, final: false, volume: escalatedVolume(params.volume, event.level), sound: params.sound, status: status(now) })
  }, 1000)
}

function seed(emit: Emit) {
  if (seeded) return
  seeded = true
  const mode = flag()
  if (mode !== 'active' && mode !== 'pending') return
  const now = Date.now()
  session = createSession(now - 2 * 3_600_000, now + 3 * 3_600_000 + 25 * 60_000, 'medium')
  session.nextAlarm = now + 95_000
  if (mode === 'pending') {
    session.pendingSince = now - 12_000
    session.escalateAt = now + 28_000
    session.alarmCount = 4
    session.seq = 4
    session.nextAlarm = null
  }
  run(emit)
}

export function awakePreview(command: string, args: Record<string, unknown>, emit: Emit): unknown {
  seed(emit)
  switch (command) {
    case 'awake_status': return status()
    case 'awake_start': {
      const end = Number(args.endEpochMs)
      const problem = validateEnd(end, Date.now())
      if (problem) throw new Error(problem)
      params = { volume: Math.min(1, Math.max(0.05, Number(args.volume) || 0.6)), sound: String(args.sound ?? 'chimes') }
      session = createSession(Date.now(), end, args.intensity as AwakeIntensity)
      run(emit)
      emit('awake://state', status())
      return status()
    }
    case 'awake_stop':
      session = null
      clearInterval(timer)
      emit('awake://state', status())
      return status()
    case 'awake_confirm':
      if (session) confirmSession(session, Date.now(), Number(args.snoozeMinutes) || 0)
      emit('awake://state', status())
      return status()
    case 'awake_audio_ack': return undefined
  }
  throw new Error(`Browser preview does not implement ${command}`)
}
