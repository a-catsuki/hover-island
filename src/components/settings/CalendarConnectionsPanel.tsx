import { createSignal, For, onMount, Show } from 'solid-js'
import { CalendarDays, Plus, RefreshCw, Trash2 } from 'lucide-solid'
import { addCalendarSource, calendarSources, calendarSourceError, refreshCalendarSources, removeCalendarSource } from '../../state/calendarSources'
import { Group, SettingsDropdown } from '../../settings/controls'
import './panels.css'

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
    <Group title="Calendars" description="Subscribe with a private iCal link. Hover Island refreshes feeds every five minutes. It does not sign in to Google or Outlook. Subscriptions are read-only, local events stay editable here, and private links are encrypted on this PC.">
      <Show when={calendarSources().length > 0} fallback={<p class="slist-empty">No calendars connected. Your local events still work without a subscription.</p>}>
        <For each={calendarSources()}>{source => (
          <div class="slist-row">
            <span class="slist-row__tile" style={{ background: '#ff453a' }} aria-hidden="true"><CalendarDays size={15} strokeWidth={1.9} /></span>
            <span class="slist-row__text">
              <strong>{source.label}</strong>
              <small classList={{ 'is-error': !!source.error }}>
                {source.error || `${providerNames[source.provider] ?? 'iCalendar'} · ${source.updatedAt ? `Synced ${new Date(source.updatedAt).toLocaleString()}` : 'Waiting for first sync'}`}
              </small>
            </span>
            <span class="slist-row__actions">
              <button type="button" class="slist-icon-btn slist-icon-btn--danger" aria-label={'Remove calendar ' + source.label} title="Remove" disabled={busy()} onClick={() => void remove(source.id)}><Trash2 size={14} /></button>
            </span>
          </div>
        )}</For>
      </Show>

      <Show when={calendarSources().length < 6}>
        <form class="sform" onSubmit={submit}>
          <h3 class="sform__title"><Plus size={14} strokeWidth={2} />Connect a calendar</h3>
          <div class="sform__grid">
            <div class="sform__field">Provider
              <SettingsDropdown block ariaLabel="Calendar provider" value={provider()} onChange={setProvider} options={[['google', 'Google Calendar'], ['outlook', 'Outlook'], ['ical', 'Other iCalendar']]} />
            </div>
            <label class="sform__field">Calendar name
              <input aria-label="Calendar name" required maxlength={60} placeholder="Personal calendar" value={label()} onInput={event => setLabel(event.currentTarget.value)} />
            </label>
            <label class="sform__field sform__field--wide">Private iCal link
              <input aria-label="Private calendar link" type="password" autocomplete="off" required placeholder="https://…/calendar.ics" value={url()} onInput={event => setUrl(event.currentTarget.value)} />
            </label>
          </div>
          <p class="sform__note">
            <Show when={provider() === 'google'} fallback={<Show when={provider() === 'outlook'} fallback="Paste your calendar's HTTPS iCalendar subscription link.">In Outlook, open Settings, then Calendar, Shared calendars, Publish a calendar, and copy the ICS link.</Show>}>
              In Google Calendar, open Settings, pick your calendar, then Integrate calendar, and copy the Secret address in iCal format.
            </Show>
          </p>
          <Show when={error() || calendarSourceError()}><p class="sform__error" role="alert">{error() || calendarSourceError()}</p></Show>
          <div class="sform__actions">
            <button type="submit" class="button button--primary" disabled={busy()}><CalendarDays size={13} />{busy() ? 'Connecting…' : 'Connect calendar'}</button>
            <button type="button" class="text-button" disabled={busy()} onClick={() => void sync()}><RefreshCw size={12} /> Sync now</button>
          </div>
        </form>
      </Show>
      <Show when={!(calendarSources().length < 6) && (error() || calendarSourceError())}><p class="sform__error" role="alert" style={{ padding: '10px 16px' }}>{error() || calendarSourceError()}</p></Show>
    </Group>
  )
}
