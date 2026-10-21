import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { Bell, BellRing, Check, Clock, Link as LinkIcon, Plus, Repeat, Trash2, X } from 'lucide-solid'
import { describeRecur, formatDue, parseReminder } from '../../lib/reminderParse'
import {
  acceptSuggestion, addReminderFromText, attentionCount, clearDoneReminders, completeReminder, deleteReminder, dismissSuggestion, justDone,
  linkNotes, loadReminders, noteSuggestions, reminderCount, reminderStatus, reminders, remindersError, remindersLoaded, remindersNow,
  scanNotes, setLinkNotes, snoozeReminder, sortReminders, type ReminderStatus,
} from '../../state/reminders'
import type { Reminder } from '../../lib/ipc'
import './widgetKit.css'
import './RemindersView.css'

const SNOOZES: Array<[number, string]> = [[5, '5m'], [15, '15m'], [60, '1h']]

export default function RemindersView() {
  const [draft, setDraft] = createSignal('')
  const [snoozing, setSnoozing] = createSignal<string | null>(null)
  const [message, setMessage] = createSignal<string | null>(null)
  let scanTimer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    void loadReminders()
    void scanNotes()
    scanTimer = setInterval(() => void scanNotes(), 10_000)
  })
  onCleanup(() => clearInterval(scanTimer))

  const sorted = createMemo(() => sortReminders(reminders()))
  const doneCount = () => reminders().filter((item) => item.done).length
  const parsed = createMemo(() => (draft().trim() ? parseReminder(draft().trim(), remindersNow()) : null))
  const previewLabel = () => {
    const value = draft().trim()
    if (!value) return ''
    const p = parsed()
    if (!p) return 'In 1 hour'
    if (p.past) return 'Time passed'
    return p.recur ? describeRecur(p.recur) : formatDue(p.due, remindersNow())
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const text = draft().trim()
    if (!text) return
    setMessage(null)
    const { reminder } = await addReminderFromText(text)
    if (reminder) setDraft('')
  }

  const statusChip = (status: ReminderStatus, item: Reminder) => {
    if (status === 'due') return 'Due now'
    if (status === 'missed') return 'Missed'
    return item.important ? 'Important' : null
  }

  const subline = (item: Reminder, status: ReminderStatus) => {
    if (status === 'done') return 'Done'
    const repeat = item.recur ? describeRecur({ ...item.recur, weekday: item.recur.weekday ?? undefined }) : null
    const when = status === 'due' ? 'Now' : status === 'missed' ? (item.recur ? `Was ${formatDue(item.missedAt ?? item.due, remindersNow())}` : formatDue(item.due, remindersNow())) : formatDue(item.due, remindersNow())
    return repeat && status === 'upcoming' && (item.recur?.kind === 'weekly') ? `${when} · weekly` : when
  }

  return (
    <section class="wk rm" data-attn={attentionCount() > 0 ? "" : undefined} aria-label="Reminders">
      <header class="wk-head">
        <span class="wk-title">
          <span class="wk-glyph rm__badge"><Show when={attentionCount() > 0} fallback={<Bell size={13} strokeWidth={2} />}><BellRing size={13} strokeWidth={2} /></Show></span>
          <span>Reminders</span>
        </span>
        <span class="wk-tools">
          <Show when={doneCount() > 0}><button type="button" class="rm__clear" onClick={() => void clearDoneReminders()}>Clear done</button></Show>
          <button type="button" class="wk-icon-btn rm__link" aria-pressed={linkNotes()} aria-label="Link to Notes" title={linkNotes() ? 'Linked to Notes: tasks with a time can become reminders' : 'Link to Notes'} onClick={() => setLinkNotes(!linkNotes())}>
            <LinkIcon size={14} strokeWidth={2} />
          </button>
          <span class="wk-sub rm__count" title={`${reminderCount()} upcoming`}>{reminderCount()}</span>
        </span>
      </header>

      <form class="rm__add" onSubmit={submit}>
        <input class="rm__input" type="text" aria-label="Add a reminder" placeholder="in 20 min call mom" maxLength={200} value={draft()} onInput={(event) => { setDraft(event.currentTarget.value); setMessage(null) }} />
        <Show when={draft().trim()}><span class="rm__parse" classList={{ 'rm__parse--warn': !parsed() || !!parsed()?.past }}>{previewLabel()}</span></Show>
        <button type="submit" class="rm__plus" aria-label="Add reminder" disabled={!draft().trim()}><Plus size={14} strokeWidth={2.4} /></button>
      </form>
      <Show when={remindersError() ?? message()}><p class="wk-error rm__error">{remindersError() ?? message()}</p></Show>

      <Show when={sorted().length > 0 || noteSuggestions().length > 0 || !remindersLoaded()} fallback={
        <div class="wk-empty"><strong>No reminders</strong><p>Try "tomorrow 9am standup".</p></div>
      }>
        <ul class="rm__list" aria-label="Reminders">
          <For each={sorted()}>{(item) => {
            const status = () => reminderStatus(item)
            const chip = () => statusChip(status(), item)
            return (
              <li class="rm__row" data-status={status()} classList={{ 'rm__row--just': justDone() === item.id }}>
                <button type="button" class="rm__check" role="checkbox" aria-checked={status() === 'done'} aria-label={`Mark ${item.title} done`} title="Done" disabled={status() === 'done'} onClick={() => void completeReminder(item.id)}>
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.5 7 11.5 12 5" /></svg>
                </button>
                <Show when={snoozing() === item.id} fallback={
                  <>
                    <span class="rm__text">
                      <span class="rm__title" title={item.title}>{item.title}</span>
                      <span class="rm__sub">
                        <Show when={chip()}><b class="rm__chip" classList={{ 'rm__chip--due': status() === 'due', 'rm__chip--missed': status() === 'missed' }}>{chip()}</b></Show>
                        <span>{subline(item, status())}</span>
                        <Show when={item.recur}><Repeat size={10} aria-label="Repeats" /></Show>
                        <Show when={item.link}><LinkIcon size={10} aria-label="Linked to a note" /></Show>
                      </span>
                    </span>
                    <span class="rm__actions">
                      <Show when={status() !== 'done'}>
                        <button type="button" class="rm__act" aria-label={`Snooze ${item.title}`} title="Snooze" onClick={() => setSnoozing(item.id)}><Clock size={13} /></button>
                      </Show>
                      <button type="button" class="rm__act rm__act--del" aria-label={`Delete ${item.title}`} title="Delete" onClick={() => void deleteReminder(item.id)}><Trash2 size={13} /></button>
                    </span>
                  </>
                }>
                  <span class="rm__snooze" role="group" aria-label="Snooze for">
                    <span class="rm__snooze-label">Snooze</span>
                    <For each={SNOOZES}>{([minutes, label]) => <button type="button" class="rm__pill" onClick={() => { setSnoozing(null); void snoozeReminder(item.id, minutes) }}>{label}</button>}</For>
                  </span>
                  <button type="button" class="rm__act" aria-label="Cancel snooze" onClick={() => setSnoozing(null)}><X size={13} /></button>
                </Show>
              </li>
            )
          }}</For>
          <Show when={linkNotes()}>
            <For each={noteSuggestions()}>{(item) => (
              <li class="rm__row rm__row--suggest">
                <span class="rm__bell" aria-hidden="true"><Bell size={12} /></span>
                <span class="rm__text">
                  <span class="rm__title" title={item.title}>{item.parsed.title}</span>
                  <span class="rm__sub"><span>From Notes · {item.parsed.recur ? describeRecur(item.parsed.recur) : formatDue(item.parsed.due, remindersNow())}</span></span>
                </span>
                <span class="rm__actions rm__actions--on">
                  <button type="button" class="rm__pill rm__pill--blue" onClick={() => void acceptSuggestion(item)}>Remind</button>
                  <button type="button" class="rm__act" aria-label="Dismiss suggestion" title="Not now" onClick={() => dismissSuggestion(item.noteId)}><X size={13} /></button>
                </span>
              </li>
            )}</For>
          </Show>
        </ul>
      </Show>
    </section>
  )
}
