import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { CalendarPlus, ChevronLeft, ChevronRight, Pencil, Plus, Trash2, Upload, MapPin } from 'lucide-solid'
import { cmd, type CalendarEvent } from '../../lib/ipc'
import { dateKey, eventsOnDay, monthGrid, moveMonth, parseDateKey } from './calendarDate'
import './CalendarView.css'
import { calendarSources, subscribedEvents } from '../../state/calendarSources'
import { reportError } from '../../state/feedback'

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const EVENT_COLORS = ['#FF453A', '#FF9F0A', '#30D158', '#0A84FF', '#BF5AF2', '#64D2FF']

function eventColor(event: CalendarEvent): string {
  let hash = 0
  const key = event.id.startsWith('ics:') ? event.id.split(':')[1] ?? event.id : event.title
  for (let index = 0; index < key.length; index++) hash = (hash * 31 + key.charCodeAt(index)) >>> 0
  return EVENT_COLORS[hash % EVENT_COLORS.length]
}

function timeRange(event: CalendarEvent): string {
  if (event.allDay) return 'All day'
  const format = (value: number) => new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${format(event.start)} – ${format(event.end)}`
}


function localDateTime(value: number): string {
  const date = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function nextHalfHour(): number {
  const date = new Date()
  date.setSeconds(0, 0)
  date.setMinutes(date.getMinutes() < 30 ? 30 : 60)
  return date.getTime()
}

export default function CalendarView() {
  const [todayKey, setTodayKey] = createSignal(dateKey(new Date()))
  const [events, setEvents] = createSignal<CalendarEvent[]>([])
  const [failed, setFailed] = createSignal(false)
  const [month, setMonth] = createSignal(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const [selectedKey, setSelectedKey] = createSignal(todayKey())
  const [editing, setEditing] = createSignal<CalendarEvent | null>(null)
  const [formOpen, setFormOpen] = createSignal(false)
  const [title, setTitle] = createSignal('')
  const [start, setStart] = createSignal(localDateTime(nextHalfHour()))
  const [end, setEnd] = createSignal(localDateTime(nextHalfHour() + 30 * 60_000))
  const [location, setLocation] = createSignal('')
  const [saving, setSaving] = createSignal(false)
  const [formError, setFormError] = createSignal('')
  const [pageError, setPageError] = createSignal('')
  let icsInput: HTMLInputElement | undefined
  let request = 0
  let mutationRevision = 0
  let active = true

  const days = createMemo(() => monthGrid(month()))
  const selectedDate = createMemo(() => parseDateKey(selectedKey()))
  const allEvents = createMemo(()=>[...events(),...subscribedEvents()])
  const selectedEvents = createMemo(() => eventsOnDay(allEvents(), selectedDate()))
  const monthLabel = createMemo(() => month().toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))
  const weekdayLabel = () => selectedDate().toLocaleDateString(undefined, { weekday: 'long' })
  const dayNumber = () => selectedDate().getDate()
  const dayCaption = () => selectedDate().toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const calendarConnectionHint = () => {
    const sources = calendarSources()
    if (!sources.length) return 'No calendar subscriptions. Open Settings to connect a read-only ICS calendar.'
    const needsAttention = sources.filter((source) => source.error).length
    if (needsAttention) return `${sources.length} read-only calendar subscription${sources.length === 1 ? '' : 's'}; ${needsAttention} need${needsAttention === 1 ? 's' : ''} attention. Manage in Settings.`
    return `${sources.length} read-only calendar subscription${sources.length === 1 ? '' : 's'}, refreshed every five minutes. Manage in Settings.`
  }
  const eventDays = createMemo(() => new Set(days()
    .filter((day) => eventsOnDay(allEvents(), day).length > 0)
    .map(dateKey)))
  const openCalendarSettings = () => {
    void cmd.openSettingsWindow().catch((error) => reportError('Could not open calendar settings', error))
  }

  const load = () => {
    const current = ++request
    const currentMutation = mutationRevision
    cmd.calendarGet()
      .then((list) => {
        if (active && current === request && currentMutation === mutationRevision) {
          setEvents(list ?? [])
          setFailed(false)
        }
      })
      .catch(() => { if (active && current === request && currentMutation === mutationRevision) setFailed(true) })
  }

  const selectDay = (day: Date) => {
    setSelectedKey(dateKey(day))
    if (day.getMonth() !== month().getMonth() || day.getFullYear() !== month().getFullYear()) {
      setMonth(new Date(day.getFullYear(), day.getMonth(), 1))
    }
  }

  const beginCreate = () => {
    const selected = selectedDate()
    const selectedToday = selectedKey() === todayKey()
    const selectedStart = selectedToday
      ? nextHalfHour()
      : new Date(selected.getFullYear(), selected.getMonth(), selected.getDate(), 9, 0).getTime()
    setFormOpen(true)
    setEditing(null)
    setTitle('')
    setStart(localDateTime(selectedStart))
    setEnd(localDateTime(selectedStart + 30 * 60_000))
    setLocation('')
    setFormError('')
  }

  const beginEdit = (event: CalendarEvent) => {
    setFormOpen(true)
    setEditing(event)
    setTitle(event.title)
    setStart(localDateTime(event.start))
    setEnd(localDateTime(event.end))
    setLocation(event.location ?? '')
    setFormError('')
  }

  const save = async (submit: SubmitEvent) => {
    submit.preventDefault()
    if (saving()) return
    const startAt = new Date(start()).getTime()
    const endAt = new Date(end()).getTime()
    if (!title().trim() || !Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
      setFormError('Add a title and an end time after the start time.')
      return
    }
    setSaving(true)
    setFormError('')
    const currentMutation = ++mutationRevision
    request++
    try {
      const updated = await cmd.calendarSave({
        id: editing()?.id ?? `local:${crypto.randomUUID()}`,
        title: title().trim(), start: startAt, end: endAt, allDay: false,
        location: location().trim() || null,
      })
      if (active && currentMutation === mutationRevision) {
        mutationRevision++
        request++
        setEvents(updated)
        setFailed(false)
        setEditing(null)
        setFormOpen(false)
        setPageError('')
        setSelectedKey(dateKey(new Date(startAt)))
        setMonth(new Date(new Date(startAt).getFullYear(), new Date(startAt).getMonth(), 1))
      }
    } catch {
      if (active && currentMutation === mutationRevision) setFormError('Could not save the event. Please try again.')
    } finally { if (active) setSaving(false) }
  }

  const remove = async (event: CalendarEvent) => {
    const currentMutation = ++mutationRevision
    request++
    try {
      const updated = await cmd.calendarDelete(event.id)
      if (active && currentMutation === mutationRevision) {
        mutationRevision++
        request++
        setEvents(updated)
        setFailed(false)
        setPageError('')
      }
    } catch {
      if (active && currentMutation === mutationRevision) setPageError('Could not remove the event.')
    }
  }

  const importIcs = async (input: HTMLInputElement) => {
    const file = input.files?.[0]
    if (!file) return
    input.value = ''
    if (file.size > 2 * 1024 * 1024) {
      setPageError('Calendar files are limited to 2 MB.')
      return
    }
    const currentMutation = ++mutationRevision
    request++
    try {
      const updated = await cmd.calendarImportIcs(await file.text())
      if (active && currentMutation === mutationRevision) {
        mutationRevision++
        request++
        setEvents(updated)
        setFailed(false)
        setPageError('')
      }
    } catch {
      if (active && currentMutation === mutationRevision) setPageError('Could not import that calendar file.')
    }
  }

  onMount(() => {
    load()
    const timer = window.setInterval(() => {
      const previous = todayKey()
      const next = dateKey(new Date())
      if (previous !== next) {
        setTodayKey(next)
        if (selectedKey() === previous) {
          setSelectedKey(next)
          const date = parseDateKey(next)
          setMonth(new Date(date.getFullYear(), date.getMonth(), 1))
        }
      }
      load()
    }, 60_000)
    onCleanup(() => {
      active = false
      request++
      mutationRevision++
      clearInterval(timer)
    })
  })

  return (
    <section class="cal" classList={{ 'cal--editing': formOpen() }} aria-label="Local calendar">
      <div class="cal__layout">
        <div class="cal__month-pane">
          <header class="cal__head">
            <div class="cal__month-controls">
              <h2>{monthLabel()}</h2>
              <button type="button" class="cal__today" onClick={() => { setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); setSelectedKey(todayKey()) }}>Today</button>
              <button type="button" class="cal__nav" aria-label="Previous month" title="Previous month" onClick={() => setMonth(moveMonth(month(), -1))}><ChevronLeft size={16} /></button>
              <button type="button" class="cal__nav" aria-label="Next month" title="Next month" onClick={() => setMonth(moveMonth(month(), 1))}><ChevronRight size={16} /></button>
            </div>
          </header>
          <div class="cal__weekdays" aria-hidden="true">
            <For each={WEEKDAYS}>{(weekday) => <span>{weekday}</span>}</For>
          </div>
          <Show when={monthLabel()} keyed>
            {(label) => (
              <div class="cal__grid" role="grid" aria-label={label}>
                <For each={days()}>
                  {(day) => {
                    const key = dateKey(day)
                    return (
                      <button
                        type="button"
                        class="cal__cell"
                        classList={{
                          'cal__cell--outside': day.getMonth() !== month().getMonth(),
                          'cal__cell--today': key === todayKey(),
                          'cal__cell--selected': key === selectedKey(),
                          'cal__cell--events': eventDays().has(key),
                        }}
                        aria-label={`${day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}${eventDays().has(key) ? ', has events' : ''}`}
                        aria-pressed={key === selectedKey()}
                        onClick={() => selectDay(day)}
                      >
                        <span class="cal__num">{day.getDate()}</span>
                        <span class="cal__dot" aria-hidden="true" />
                      </button>
                    )
                  }}
                </For>
              </div>
            )}
          </Show>
        </div>

        <div class="cal__agenda-pane">
          <Show when={!formOpen()} fallback={
            <form class="cal__form" onSubmit={save}>
              <header class="cal__form-head">
                <strong>{editing() ? 'Edit event' : 'New event'}</strong>
              </header>
              <div class="cal__fields">
                <input aria-label="Event title" placeholder="Event title" maxlength={200} required value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
                <label><span>Starts</span><input aria-label="Starts" type="datetime-local" required value={start()} onInput={(e) => setStart(e.currentTarget.value)} /></label>
                <label><span>Ends</span><input aria-label="Ends" type="datetime-local" required value={end()} onInput={(e) => setEnd(e.currentTarget.value)} /></label>
                <input aria-label="Location" placeholder="Location (optional)" maxlength={256} value={location()} onInput={(e) => setLocation(e.currentTarget.value)} />
              </div>
              <Show when={formError()}><p class="cal__error" role="alert">{formError()}</p></Show>
              <div class="cal__form-actions">
                <button type="button" disabled={saving()} onClick={() => { setFormOpen(false); setEditing(null); setFormError('') }}>Cancel</button>
                <button type="submit" class="cal__save" disabled={saving()}>{saving() ? 'Saving…' : 'Save event'}</button>
              </div>
            </form>
          }>
            <div class="cal__agenda-head">
              <div class="cal__date">
                <span class="cal__weekday">{weekdayLabel()}</span>
                <span class="cal__bignum">{dayNumber()}</span>
                <span class="cal__monthcap">{dayCaption()}</span>
              </div>
              <div class="cal__head-actions">
                <input ref={icsInput} class="cal__file" type="file" accept=".ics,text/calendar" aria-label="Import calendar file" onChange={(event) => void importIcs(event.currentTarget)} />
                <button type="button" class="cal__icon" aria-label={calendarSources().length ? 'Manage calendars' : 'Connect calendar'} title={calendarConnectionHint()} onClick={openCalendarSettings}><CalendarPlus size={15} /></button>
                <button type="button" class="cal__icon" aria-label="Import calendar file" title="Import calendar file" onClick={() => icsInput?.click()}><Upload size={14} /></button>
                <button type="button" class="cal__add" aria-label="Add event" title="Add event on selected day" onClick={beginCreate}><Plus size={16} strokeWidth={2.2} /></button>
              </div>
            </div>
            <Show when={failed()}><p class="cal__error" role="status">Calendar is unavailable right now.</p></Show>
            <Show when={pageError()}><p class="cal__error" role="alert">{pageError()}</p></Show>
            <Show when={!failed() && selectedEvents().length === 0}>
              <p class="cal__empty">{allEvents().length ? 'No events' : 'Nothing planned. Enjoy the space.'}</p>
            </Show>
            <div class="cal__agenda" aria-label="Events for selected day">
              <For each={selectedEvents()}>
                {(event) => (
                  <div class="cal__event" style={{ '--event-color': eventColor(event) }}>
                    <span class="cal__event-bar" aria-hidden="true" />
                    <span class="cal__event-main">
                      <strong title={event.title}>{event.title}</strong>
                      <small>{timeRange(event)}</small>
                      <Show when={event.location}><small class="cal__event-where"><MapPin size={10} />{event.location}</small></Show>
                    </span>
                    <Show when={!event.id.startsWith('ics:')}>
                      <span class="cal__event-actions">
                        <button type="button" class="cal__action" aria-label={`Edit ${event.title}`} title="Edit" onClick={() => beginEdit(event)}><Pencil size={12} /></button>
                        <button type="button" class="cal__action cal__action--delete" aria-label={`Delete ${event.title}`} title="Delete" onClick={() => void remove(event)}><Trash2 size={12} /></button>
                      </span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </section>
  )
}
