// Browser-preview stand-in for src-tauri/src/reminders.rs: a localStorage list plus a one-second
// scheduler that raises `reminders://due` like the native thread does.
import type { Reminder } from './ipc'
import { nextOccurrence } from './reminderParse'

type Emit = (name: string, payload: unknown) => void

const KEY = 'hover-island.preview.reminders'
const MISS_GRACE_MS = 120_000
let items: Reminder[] | null = null
let timer: ReturnType<typeof setInterval> | undefined

function sample(): Reminder[] {
  const now = Date.now()
  const day = new Date(now)
  const at = (offsetDays: number, hour: number, minute = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + offsetDays, hour, minute).getTime()
  const base = { important: false, done: false, snoozes: 0, createdAt: now - 3_600_000 }
  const mode = (() => { try { return JSON.parse(localStorage.getItem('hover-island.preview.reminders-mode') ?? 'null') } catch { return null } })()
  if (mode === 'empty') return []
  const list: Reminder[] = [
    { ...base, id: 'r-call', title: 'Call mom', due: now + 18 * 60_000 },
    { ...base, id: 'r-gym', title: 'Gym', due: at(0, 18) > now ? at(0, 18) : at(1, 18) },
    { ...base, id: 'r-standup', title: 'Standup', due: at(1, 9) },
    { ...base, id: 'r-stretch', title: 'Stretch', due: nextOccurrence({ kind: 'weekdays', hour: 10, minute: 0 }, now), recur: { kind: 'weekdays', hour: 10, minute: 0 } },
    { ...base, id: 'r-rent', title: 'Pay rent', due: at(3, 8), important: true },
    { ...base, id: 'r-groceries', title: 'Order groceries', due: now - 40 * 60_000, firedAt: now - 38 * 60_000, missedAt: now - 40 * 60_000 },
  ]
  if (mode === 'due') list.unshift({ ...base, id: 'r-due', title: 'Submit timesheet', due: now - 30_000, firedAt: now - 28_000, important: true })
  return list
}

function load(): Reminder[] {
  if (items) return items
  try {
    const raw = localStorage.getItem(KEY)
    items = raw ? (JSON.parse(raw) as Reminder[]) : sample()
  } catch {
    items = sample()
  }
  return items
}

function save(emit: Emit): Reminder[] {
  const list = load()
  try { localStorage.setItem(KEY, JSON.stringify(list)) } catch { /* private window */ }
  emit('reminders://changed', list)
  return list
}

function advance(reminder: Reminder, after: number) {
  if (reminder.recur) reminder.due = nextOccurrence({ ...reminder.recur, weekday: reminder.recur.weekday ?? undefined }, after)
}

function tick(emit: Emit) {
  const now = Date.now()
  let changed = false
  for (const reminder of load()) {
    if (reminder.done || reminder.firedAt || reminder.due > now) continue
    changed = true
    reminder.firedAt = now
    if (now - reminder.due > MISS_GRACE_MS) {
      reminder.missedAt = reminder.due
      if (reminder.recur) { reminder.firedAt = null; advance(reminder, now) }
    } else {
      emit('reminders://due', { ...reminder })
    }
  }
  if (changed) save(emit)
}

export function remindersPreview(command: string, args: Record<string, unknown>, emit: Emit): unknown {
  load()
  if (!timer) timer = setInterval(() => tick(emit), 1000)
  const list = load()
  const find = () => list.find((item) => item.id === args.id)
  switch (command) {
    case 'reminders_list': return list
    case 'reminders_save': {
      const reminder = args.reminder as Reminder
      const index = list.findIndex((item) => item.id === reminder.id)
      if (index >= 0) list[index] = reminder
      else list.push({ ...reminder, id: reminder.id || `r-${Date.now()}` })
      return save(emit)
    }
    case 'reminders_done': {
      const reminder = find()
      if (!reminder) throw new Error('That reminder no longer exists.')
      reminder.doneAt = Date.now(); reminder.firedAt = null; reminder.missedAt = null
      if (reminder.recur) advance(reminder, Math.max(Date.now(), reminder.due))
      else reminder.done = true
      return save(emit)
    }
    case 'reminders_snooze': {
      const reminder = find()
      if (!reminder) throw new Error('That reminder no longer exists.')
      reminder.due = Date.now() + Math.max(1, Number(args.minutes) || 5) * 60_000
      reminder.done = false; reminder.firedAt = null; reminder.missedAt = null; reminder.snoozes += 1
      return save(emit)
    }
    case 'reminders_delete': items = list.filter((item) => item.id !== args.id); return save(emit)
    case 'reminders_clear_done': items = list.filter((item) => !item.done); return save(emit)
  }
  throw new Error(`Browser preview does not implement ${command}`)
}
