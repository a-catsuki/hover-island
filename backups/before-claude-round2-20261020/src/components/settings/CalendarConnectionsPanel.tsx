import { createSignal, For, onMount, Show } from 'solid-js'
import { CalendarDays, RefreshCw, Trash2 } from 'lucide-solid'
import { addCalendarSource, calendarSources, calendarSourceError, refreshCalendarSources, removeCalendarSource } from '../../state/calendarSources'
import { Group } from '../../settings/controls'

const providerNames: Record<string, string> = {
  google: 'Google Calendar',
  outlook: 'Outlook',
  ical: 'iCalendar',
}

export default function CalendarConnectionsPanel() {
  const [provider, setProvider] = createSignal('google')
  const [label, setLabel] = createSignal('')
  const [url, setUrl] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')

  onMount(() => void refreshCalendarSources())

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await addCalendarSource(label(), provider(), url())
      setUrl('')
      setLabel('')
    } catch (caught) {
      setError(String(caught))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    setBusy(true)
    setError('')
    try {
      await removeCalendarSource(id)
    } catch (caught) {
      setError(String(caught))
    } finally {
      setBusy(false)
    }
  }

  const sync = async () => {
    setBusy(true)
    setError('')
    try {
      await refreshCalendarSources(true)
    } catch (caught) {
      setError(String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Group title="Calendars" description="Subscribe with a private iCal link. Hover Island refreshes feeds every five minutes; it does not sign in to Google or Outlook.">
      <Show when={calendarSources().length > 0} fallback={<p class="set-note">No calendars connected. Your local events still work without a subscription.</p>}>
        <For each={calendarSources()}>{source => (
          <div class="calendar-link-row">
            <CalendarDays size={18} />
            <div>
              <strong>{source.label}</strong>
              <small>
                {source.error || `${providerNames[source.provider] ?? 'iCalendar'} · ${source.updatedAt ? `Synced ${new Date(source.updatedAt).toLocaleString()}` : 'Waiting for first sync'}`}
              </small>
            </div>
            <button type="button" class="text-button" aria-label={'Remove calendar ' + source.label} disabled={busy()} onClick={() => void remove(source.id)}><Trash2 size={15} /></button>
          </div>
        )}</For>
      </Show>

      <Show when={calendarSources().length < 6}>
        <form class="calendar-connect-form" onSubmit={submit}>
          <label>Provider
            <select aria-label="Calendar provider" value={provider()} onChange={event => setProvider(event.currentTarget.value)}>
              <option value="google">Google Calendar</option>
              <option value="outlook">Outlook</option>
              <option value="ical">Other iCalendar</option>
            </select>
          </label>
          <label>Calendar name
            <input aria-label="Calendar name" required maxlength={60} placeholder="Personal calendar" value={label()} onInput={event => setLabel(event.currentTarget.value)} />
          </label>
          <label>Private iCal link
            <input aria-label="Private calendar link" type="password" autocomplete="off" required placeholder="https://…/calendar.ics" value={url()} onInput={event => setUrl(event.currentTarget.value)} />
          </label>
          <p class="set-note">
            <Show when={provider() === 'google'} fallback={<Show when={provider() === 'outlook'} fallback="Paste your calendar's HTTPS iCalendar subscription link.">In Outlook, open Settings → Calendar → Shared calendars → Publish calendar, then copy the ICS link.</Show>}>
              In Google Calendar, open Settings → your calendar → Integrate calendar, then copy the Secret address in iCal format.
            </Show>
          </p>
          <button type="submit" class="button" disabled={busy()}><CalendarDays size={14} />{busy() ? 'Connecting…' : 'Connect calendar'}</button>
        </form>
      </Show>

      <Show when={error() || calendarSourceError()}><p class="inline-error" role="alert">{error() || calendarSourceError()}</p></Show>
      <div class="calendar-connect-foot">
        <p class="set-note">Subscriptions are read-only. Edit subscribed events in Google or Outlook; local events stay editable here. Private links are encrypted on this PC.</p>
        <button type="button" class="text-button" disabled={busy()} onClick={() => void sync()}><RefreshCw size={13} />Sync now</button>
      </div>
    </Group>
  )
}
