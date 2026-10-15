import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, ListTodo, Pencil, Plus, Trash2, Upload, X } from 'lucide-solid'
import { cmd, type CalendarEvent } from '../../lib/ipc'
import { dateKey, eventsOnDay, monthGrid, moveMonth, parseDateKey } from './calendarDate'
import './widgets.css'
import './CalendarView.css'
import { requestWidgetDetail } from '../../state/panel'
import { calendarSources, subscribedEvents } from '../../state/calendarSources'
import { reportError } from '../../state/feedback'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function dayLabel(value: number): string {
  return new Date(value).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

function timeLabel(event: CalendarEvent): string {
  if (event.allDay) return 'All day'
  return new Date(event.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
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
  const [agendaPage, setAgendaPage] = createSignal(0)
  let icsInput: HTMLInputElement | undefined
  let request = 0
  let mutationRevision = 0
  let active = true

  const days = createMemo(() => monthGrid(month()))
  const selectedDate = createMemo(() => parseDateKey(selectedKey()))
  const allEvents = createMemo(()=>[...events(),...subscribedEvents()])
  const selectedEvents = createMemo(() => eventsOnDay(allEvents(), selectedDate()))
  const agendaPages = () => Math.max(1, Math.ceil(selectedEvents().length / 2))
  const currentAgendaPage = () => Math.min(agendaPage(), agendaPages() - 1)
  const visibleEvents = () => selectedEvents().slice(currentAgendaPage() * 2, currentAgendaPage() * 2 + 2)
  const monthLabel = createMemo(() => month().toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))
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
    setAgendaPage(0)
    setSelectedKey(dateKey(day))
    if (day.getMonth() !== month().getMonth() || day.getFullYear() !== month().getFullYear()) {
      setMonth(new Date(day.getFullYear(), day.getMonth(), 1))
    }
  }

  const beginCreate = () => {
    requestWidgetDetail('calendar')
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
    requestWidgetDetail('calendar')
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
    <section class="cal" aria-label="Local calendar">
      <header class="cal__head">
        <div class="cal__month-controls">
          <h2>{monthLabel()}</h2>
          <button type="button" class="cal__nav" aria-label="Previous month" title="Previous month" onClick={() => setMonth(moveMonth(month(), -1))}><ChevronLeft size={15} /></button>
          <button type="button" class="cal__nav" aria-label="Next month" title="Next month" onClick={() => setMonth(moveMonth(month(), 1))}><ChevronRight size={15} /></button>
          <button type="button" class="cal__today" onClick={() => { setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); setSelectedKey(todayKey()) }}>Today</button>
        </div>
        <div class="cal__head-actions">
          <button type="button" class="cal__connect" aria-label={calendarSources().length ? 'Manage calendars' : 'Connect calendar'} title={calendarConnectionHint()} onClick={openCalendarSettings}><CalendarPlus size={14} /><span class="cal__connect-label">{calendarSources().length ? 'Calendars' : 'Connect'}</span></button>
          <button type="button" class="cal__agenda-open" aria-label="Open calendar agenda" title="Open the calendar agenda" onClick={() => requestWidgetDetail('calendar')}><ListTodo size={14} />Agenda</button>
          <input ref={icsInput} class="cal__file" type="file" accept=".ics,text/calendar" aria-label="Import calendar file" onChange={(event) => void importIcs(event.currentTarget)} />
          <button type="button" class="cal__add" aria-label="Import calendar file" title="Import calendar file" onClick={() => icsInput?.click()}><Upload size={13} /></button>
          <button type="button" class="cal__add" aria-label="Add event" title="Add event on selected day" onClick={beginCreate}><Plus size={14} /></button>
        </div>
      </header>

      <div class="cal__layout">
        <div class="cal__month-pane">
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
                        }}
                        aria-label={`${day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}${eventDays().has(key) ? ', has events' : ''}`}
                        aria-pressed={key === selectedKey()}
                        onClick={() => selectDay(day)}
                      >
                        <span class="cal__num">
                          {day.getDate()}
                          <span class="cal__dot" classList={{ 'cal__dot--visible': eventDays().has(key) }} aria-hidden="true" />
                        </span>
                      </button>
                    )
                  }}
                </For>
              </div>
            )}
          </Show>
        </div>

        <div class="cal__agenda-pane">
          <div class="cal__agenda-head">
            <h3>{dayLabel(selectedDate().getTime())}</h3>
            <button type="button" class="cal__agenda-add" onClick={beginCreate}><Plus size={13} /> Add</button>
          </div>
          <Show when={failed()}><p class="cal__error" role="status">Calendar is unavailable right now.</p></Show>
          <Show when={pageError()}><p class="cal__error" role="alert">{pageError()}</p></Show>
          <Show when={!failed() && selectedEvents().length === 0}>
            <p class="cal__empty">{allEvents().length ? 'No events on this day.' : 'A little space in your day.'}</p>
          </Show>
          <div class="cal__agenda" aria-label="Events for selected day">
            <For each={visibleEvents()}>
              {(event) => (
                <div class="cal__event">
                  <span class="cal__event-time">{timeLabel(event)}</span>
                  <span class="cal__event-main">
                    <strong title={event.title}>{event.title}</strong>
                    <Show when={event.location}><small>{event.location}</small></Show>
                  </span>
                  <Show when={!event.id.startsWith('ics:')}>
                    <button type="button" class="cal__action" aria-label={`Edit ${event.title}`} title="Edit" onClick={() => beginEdit(event)}><Pencil size={12} /></button>
                    <button type="button" class="cal__action cal__action--delete" aria-label={`Delete ${event.title}`} title="Delete" onClick={() => void remove(event)}><Trash2 size={12} /></button>
                  </Show>
                </div>
              )}
            </For>
          </div>
          <Show when={agendaPages() > 1}><nav class="widget-list-pager" aria-label="Calendar events"><button aria-label="Previous calendar events" disabled={currentAgendaPage() === 0} onClick={() => setAgendaPage(currentAgendaPage() - 1)}>‹</button><span>{currentAgendaPage() + 1} / {agendaPages()}</span><button aria-label="Next calendar events" disabled={currentAgendaPage() >= agendaPages() - 1} onClick={() => setAgendaPage(currentAgendaPage() + 1)}>›</button></nav></Show>
        </div>
      </div>

      <Show when={formOpen()}>
        <form class="cal__form" onSubmit={save}>
          <input aria-label="Event title" placeholder="Event title" maxlength={200} required value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
          <div class="cal__times">
            <label>Starts<input aria-label="Starts" type="datetime-local" required value={start()} onInput={(e) => setStart(e.currentTarget.value)} /></label>
            <label>Ends<input aria-label="Ends" type="datetime-local" required value={end()} onInput={(e) => setEnd(e.currentTarget.value)} /></label>
          </div>
          <input aria-label="Location" placeholder="Location (optional)" maxlength={256} value={location()} onInput={(e) => setLocation(e.currentTarget.value)} />
          <Show when={formError()}><p role="alert">{formError()}</p></Show>
          <div class="cal__form-actions">
            <button type="button" disabled={saving()} onClick={() => { setFormOpen(false); setEditing(null); setFormError('') }}><X size={13} /> Cancel</button>
            <button type="submit" disabled={saving()}>{saving() ? 'Saving…' : 'Save event'}</button>
          </div>
        </form>
      </Show>
    </section>
  )
}
