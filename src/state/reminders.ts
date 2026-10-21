import { createRoot, createSignal } from 'solid-js'
import { cmd, listen, type AppNotification, type Reminder } from '../lib/ipc'
import { formatDue, describeRecur, parseReminder, type ParsedReminder } from '../lib/reminderParse'
import { encodeTodoList, flushNotesWriters, parseNotes } from '../components/widgets/notesPersistence'
import { ingestActionPeek, ingestUrgentPeek, ingestFeedbackToast } from './peek'

/**
 * Timed reminders. The native scheduler (reminders.rs) owns storage and the clock; this module mirrors
 * the list for the widget, raises the notch peek when one comes due and keeps linked Notes items in
 * step. It runs for the whole app session. The settings window imports the widget registry too, so it
 * stays inert there.
 */

const LINK_KEY = 'hover-island.reminders.link-notes'
const DISMISSED_KEY = 'hover-island.reminders.dismissed-suggestions'
const NOTES_CHANGED = 'hover-island:notes-changed'

const isSettingsWindow = typeof location !== 'undefined' && /settings\.html$/.test(location.pathname)

function readFlag(key: string, fallback: boolean): boolean {
  try { const raw = localStorage.getItem(key); return raw === null ? fallback : raw === '1' } catch { return fallback }
}
function readSet(key: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]) } catch { return new Set() }
}

const [list, setList] = createSignal<Reminder[]>([])
const [loaded, setLoaded] = createSignal(false)
const [now, setNow] = createSignal(Date.now())
const [linkNotes, setLinkNotesSignal] = createSignal(readFlag(LINK_KEY, true))
const [noteTitles, setNoteTitles] = createSignal<Map<string, { title: string; completed: boolean }>>(new Map())
const [dismissed, setDismissed] = createSignal<Set<string>>(readSet(DISMISSED_KEY))
const [error, setError] = createSignal<string | null>(null)
/** The reminder that just completed, so its row can play the check animation before it leaves. */
const [justDone, setJustDone] = createSignal<string | null>(null)

export { list as reminders, loaded as remindersLoaded, now as remindersNow, linkNotes, error as remindersError, justDone }

export function setLinkNotes(value: boolean): void {
  setLinkNotesSignal(value)
  try { localStorage.setItem(LINK_KEY, value ? '1' : '0') } catch { /* private window */ }
  if (value) void scanNotes()
}

const BELL_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#0A84FF"/><path d="M32 14c-7 0-12 5-12 12v8l-4 6h32l-4-6v-8c0-7-5-12-12-12zm-5 36a5 5 0 0 0 10 0z" fill="#fff"/></svg>')}`

/* ------------------------------------------------------------------ status */

export type ReminderStatus = 'due' | 'missed' | 'upcoming' | 'done'

export function reminderStatus(reminder: Reminder): ReminderStatus {
  if (reminder.done) return 'done'
  if (reminder.missedAt) return 'missed'
  if (reminder.firedAt) return 'due'
  return 'upcoming'
}

/** Needs an answer first, then by next due time, finished ones last. */
export function sortReminders(items: Reminder[]): Reminder[] {
  const rank = (reminder: Reminder) => {
    const status = reminderStatus(reminder)
    return status === 'due' ? 0 : status === 'missed' ? 1 : status === 'upcoming' ? 2 : 3
  }
  return [...items].sort((a, b) => rank(a) - rank(b) || (rank(a) === 3 ? (b.doneAt ?? 0) - (a.doneAt ?? 0) : a.due - b.due))
}

export const reminderCount = () => list().filter((reminder) => !reminder.done).length
export const attentionCount = () => list().filter((reminder) => ['due', 'missed'].includes(reminderStatus(reminder))).length
export const reminderDueLabel = (reminder: Reminder): string => formatDue(reminder.due, now())
export const reminderRepeatLabel = (reminder: Reminder): string | null => (reminder.recur ? describeRecur({ ...reminder.recur, weekday: reminder.recur.weekday ?? undefined }) : null)
export const reminderForNote = (noteId: string): Reminder | undefined => list().find((reminder) => reminder.link === noteId && !reminder.done)

/* ----------------------------------------------------------------- commands */

function failure(value: unknown, fallback: string): string {
  return value instanceof Error ? value.message : typeof value === 'string' ? value : fallback
}

async function run(work: Promise<Reminder[]>, fallback: string): Promise<boolean> {
  try {
    setList(await work)
    setError(null)
    return true
  } catch (problem) {
    setError(failure(problem, fallback))
    return false
  }
}

export async function loadReminders(): Promise<void> {
  try {
    setList(await cmd.remindersList())
    setLoaded(true)
    setError(null)
  } catch (problem) {
    setLoaded(true)
    setError(failure(problem, 'Could not load reminders.'))
  }
}

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

export interface NewReminder { title: string; due: number; recur?: Reminder['recur']; important?: boolean; link?: string | null }

export async function createReminder(input: NewReminder): Promise<Reminder | null> {
  const reminder: Reminder = {
    id: newId(), title: input.title, due: input.due, recur: input.recur ?? null, important: !!input.important, done: false,
    link: input.link ?? null, createdAt: Date.now(), snoozes: 0,
  }
  return (await run(cmd.remindersSave(reminder), 'Could not save the reminder.')) ? reminder : null
}

/** Turn a typed phrase into a reminder. Without a time it is set for an hour from now. */
export async function addReminderFromText(text: string, link?: string | null): Promise<{ reminder: Reminder | null; parsed: ParsedReminder | null }> {
  const parsed = parseReminder(text)
  if (parsed?.past) {
    setError('That time has already passed. Pick a later one.')
    return { reminder: null, parsed }
  }
  const title = parsed ? parsed.title : text.trim()
  if (!title) return { reminder: null, parsed }
  const reminder = await createReminder({ title, due: parsed ? parsed.due : Date.now() + 3_600_000, recur: parsed?.recur ?? null, important: parsed?.important, link })
  return { reminder, parsed }
}

export async function completeReminder(id: string, options: { skipNote?: boolean } = {}): Promise<void> {
  const reminder = list().find((item) => item.id === id)
  if (!reminder) return
  setJustDone(id)
  setTimeout(() => setJustDone((current) => (current === id ? null : current)), 700)
  await run(cmd.remindersDone(id), 'Could not mark it done.')
  if (reminder.link && !reminder.recur && !options.skipNote) void setNoteCompleted(reminder.link, true)
}

export const snoozeReminder = (id: string, minutes: number) => run(cmd.remindersSnooze(id, minutes), 'Could not snooze it.')
export const deleteReminder = (id: string) => run(cmd.remindersDelete(id), 'Could not delete it.')
export const clearDoneReminders = () => run(cmd.remindersClearDone(), 'Could not clear finished reminders.')
export const updateReminder = (reminder: Reminder) => run(cmd.remindersSave(reminder), 'Could not save the reminder.')

/* --------------------------------------------------------------------- notes */

export interface NoteSuggestion { noteId: string; title: string; parsed: ParsedReminder }
const [suggestions, setSuggestions] = createSignal<NoteSuggestion[]>([])
export { suggestions as noteSuggestions }

async function setNoteCompleted(noteId: string, completed: boolean): Promise<void> {
  try {
    await flushNotesWriters()
    const parsed = parseNotes((await cmd.notesGet())?.text)
    if (!parsed.items.some((item) => item.id === noteId && item.completed !== completed)) return
    await cmd.notesSet(encodeTodoList(parsed.items.map((item) => (item.id === noteId ? { ...item, completed } : item))))
    window.dispatchEvent(new CustomEvent(NOTES_CHANGED))
  } catch {
    // The Notes list is only kept in step on a best effort basis.
  }
}

/** Reads Notes, keeps linked reminders in step with their items and refreshes the suggestions. */
export async function scanNotes(): Promise<void> {
  try {
    await flushNotesWriters()
    const items = parseNotes((await cmd.notesGet())?.text).items
    const byId = new Map(items.map((item) => [item.id, { title: item.title, completed: item.completed }]))
    setNoteTitles(byId)
    for (const reminder of list()) {
      if (!reminder.link || reminder.done) continue
      const note = byId.get(reminder.link)
      if (!note) await updateReminder({ ...reminder, link: null })
      else if (note.completed) await completeReminder(reminder.id, { skipNote: true })
    }
    if (!linkNotes()) { setSuggestions([]); return }
    const linked = new Set(list().filter((reminder) => reminder.link && !reminder.done).map((reminder) => reminder.link as string))
    const skipped = dismissed()
    const found: NoteSuggestion[] = []
    for (const item of items) {
      if (item.completed || linked.has(item.id) || skipped.has(item.id)) continue
      const parsed = parseReminder(item.title)
      if (parsed && !parsed.past) found.push({ noteId: item.id, title: item.title, parsed })
    }
    setSuggestions(found.slice(0, 20))
  } catch {
    // Notes unavailable: leave things as they were.
  }
}

export function dismissSuggestion(noteId: string): void {
  const next = new Set(dismissed()).add(noteId)
  setDismissed(next)
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next].slice(-200))) } catch { /* private window */ }
  setSuggestions(suggestions().filter((item) => item.noteId !== noteId))
}

export async function acceptSuggestion(suggestion: NoteSuggestion): Promise<void> {
  await createReminder({ title: suggestion.parsed.title, due: suggestion.parsed.due, recur: suggestion.parsed.recur ?? null, important: suggestion.parsed.important, link: suggestion.noteId })
  setSuggestions(suggestions().filter((item) => item.noteId !== suggestion.noteId))
}

/** The bell on a Notes row: make a reminder from the item (its own time words, otherwise an hour from now), or remove the existing one. */
export async function toggleNoteReminder(note: { id: string; title: string }): Promise<'created' | 'removed' | 'failed'> {
  const existing = reminderForNote(note.id)
  if (existing) return (await deleteReminder(existing.id)) ? 'removed' : 'failed'
  const parsed = parseReminder(note.title)
  const usable = parsed && !parsed.past ? parsed : null
  const created = await createReminder({
    title: usable ? usable.title : note.title.trim(),
    due: usable ? usable.due : Date.now() + 3_600_000,
    recur: usable?.recur ?? null,
    important: usable?.important,
    link: note.id,
  })
  if (!created) return 'failed'
  ingestFeedbackToast({ id: `reminder-set:${created.id}`, app: 'Reminders', text: `Reminder ${formatDue(created.due).toLowerCase()}` })
  return 'created'
}

/* ------------------------------------------------------------ peeks and events */

/** Buttons offered on the notch peek. The peek renderer calls this with the reminder id and chosen action id. */
export function reminderPeekAction(reminderId: string, actionId: string): void {
  if (actionId === 'done') void completeReminder(reminderId)
  else if (actionId.startsWith('snooze')) void snoozeReminder(reminderId, Number(actionId.slice(6)) || 15)
}

function peekDue(reminder: Reminder): void {
  const repeat = reminderRepeatLabel(reminder)
  const item: AppNotification = {
    id: `reminder:${reminder.id}:${reminder.firedAt ?? reminder.due}`, app: 'Reminders', title: reminder.title,
    body: repeat ?? (reminder.snoozes ? `Snoozed ${reminder.snoozes} ${reminder.snoozes === 1 ? 'time' : 'times'}` : 'Due now'),
    timestamp: Date.now(), icon: BELL_ICON, priority: reminder.important ? 'urgent' : 'normal',
    reminderId: reminder.id, actionOwner: 'reminders',
    actions: [{ id: 'done', label: 'Done', primary: true }, { id: 'snooze15', label: 'Snooze 15 min' }],
  }
  if (reminder.important) ingestUrgentPeek(item)
  else ingestActionPeek(item)
}

let started = false
function start(): void {
  if (started || isSettingsWindow) return
  started = true
  void loadReminders().then(() => {
    const missed = list().filter((reminder) => reminderStatus(reminder) === 'missed')
    if (!missed.length) return
    ingestActionPeek({
      id: `reminders-missed:${Date.now()}`, app: 'Reminders', icon: BELL_ICON, timestamp: Date.now(),
      title: missed.length === 1 ? 'Missed reminder' : `${missed.length} missed reminders`,
      body: missed.slice(0, 2).map((reminder) => reminder.title).join(', '),
    })
  })
  void listen<Reminder[]>('reminders://changed', (event) => setList(event.payload))
  void listen<Reminder>('reminders://due', (event) => {
    setList((current) => current.map((item) => (item.id === event.payload.id ? event.payload : item)))
    peekDue(event.payload)
  })
  window.addEventListener(NOTES_CHANGED, () => { void scanNotes() })
  createRoot(() => {
    setInterval(() => setNow(Date.now()), 15_000)
    // Linked reminders follow their Notes item even when the widget is closed.
    setInterval(() => { if (list().some((reminder) => reminder.link && !reminder.done)) void scanNotes() }, 20_000)
  })
}
start()

export { noteTitles }
