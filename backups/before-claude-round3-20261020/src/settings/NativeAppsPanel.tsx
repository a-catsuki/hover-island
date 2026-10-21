import { createMemo, createSignal, For, onMount, Show } from 'solid-js'
import { CalendarDays, ChevronRight, Music2, Plus, Search, Sparkles, X } from 'lucide-solid'
import { cmd, type AppConnection, type InstalledApp } from '../lib/ipc'
import { settings, patchSettings } from '../state/settings'
import { calendarSources, refreshCalendarSources } from '../state/calendarSources'
import NotificationAppIcon from '../components/shell/NotificationAppIcon'
import { NATIVE_APPS, NATIVE_GROUPS, connectionForEntry, connectionFromEntry, connectionFromInstalled, installedAppCovered, nativeAppState, nativeRules } from '../lib/nativeApps'
import { Group, Subhead, Switch } from './controls'
import './NativeAppsPanel.css'

type Navigate = (page: string) => void

/** A row that is a short explanation plus one action, for things that connect another way. */
function LinkRow(props: { icon: any; tint: string; title: string; hint: string; action: string; onAction: () => void; status?: string }) {
  const Icon = props.icon
  return <div class="set-row nat-link">
    <span class="nat-link__tile" style={{ background: props.tint }} aria-hidden="true"><Icon size={16} strokeWidth={1.9} /></span>
    <span class="set-row__text"><strong>{props.title}</strong><small>{props.hint}</small></span>
    <span class="set-row__control">
      <Show when={props.status}><span class="nat-chip">{props.status}</span></Show>
      <button type="button" class="button" onClick={props.onAction}>{props.action}<ChevronRight size={12} strokeWidth={2.2} /></button>
    </span>
  </div>
}

/**
 * Connect native Windows apps to the island. Everything here is saved in
 * `settings.connections` with the same default-allow rule the notification
 * pipeline uses: an app alerts unless its rule says notifications are off.
 */
export default function NativeAppsPanel(props: { onNavigate: Navigate }) {
  const [picking, setPicking] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [installed, setInstalled] = createSignal<InstalledApp[] | null>(null)
  const [seen, setSeen] = createSignal<{ name: string; icon: string | null }[]>([])
  const [loadError, setLoadError] = createSignal(false)
  let searchEl: HTMLInputElement | undefined

  onMount(() => { void refreshCalendarSources().catch(() => {}) })

  const rules = () => nativeRules(settings.connections)
  const setRules = (next: AppConnection[]) => patchSettings({ connections: [...settings.connections.filter(connection => !!connection.url), ...next] })

  const connectEntry = (entryId: string) => {
    const entry = NATIVE_APPS.find(item => item.id === entryId)
    if (!entry) return
    const existing = connectionForEntry(entry, settings.connections)
    if (existing) setRules(rules().map(rule => rule.id === existing.id ? { ...rule, notifications: true } : rule))
    else setRules([...rules(), connectionFromEntry(entry)])
  }
  const setAlerts = (id: string, on: boolean) => setRules(rules().map(rule => rule.id === id ? { ...rule, notifications: on } : rule))
  const removeRule = (id: string) => setRules(rules().filter(rule => rule.id !== id))

  const suggestions = createMemo(() => NATIVE_APPS.filter(entry => nativeAppState(entry, settings.connections) === 'default'))

  const openPicker = async () => {
    setPicking(true)
    queueMicrotask(() => searchEl?.focus())
    if (installed() === null) {
      try {
        const [apps, recent] = await Promise.all([
          cmd.appsList(),
          cmd.notificationsGet().catch(() => []),
        ])
        setInstalled(apps)
        const names = new Map<string, string | null>()
        for (const item of recent) if (item.app && !names.has(item.app)) names.set(item.app, item.icon ?? null)
        setSeen([...names.entries()].map(([name, icon]) => ({ name, icon })))
      } catch { setLoadError(true); setInstalled([]) }
    }
  }
  const closePicker = () => { setPicking(false); setQuery('') }

  const matches = (name: string) => !query().trim() || name.toLowerCase().includes(query().trim().toLowerCase())
  const pickable = createMemo(() => {
    const covered = (name: string) => installedAppCovered(name, settings.connections)
    const recent = seen().filter(item => !covered(item.name) && matches(item.name))
    const recentNames = new Set(recent.map(item => item.name.toLowerCase()))
    const apps = (installed() ?? [])
      .filter(app => app.kind !== 'url' && !covered(app.name) && !recentNames.has(app.name.toLowerCase()) && matches(app.name))
      .sort((a, b) => a.name.localeCompare(b.name))
    // Same app can have several shortcuts; show each name once.
    const unique = apps.filter((app, index) => apps.findIndex(other => other.name.toLowerCase() === app.name.toLowerCase()) === index)
    return { recent, apps: unique.slice(0, 80), more: Math.max(0, unique.length - 80) }
  })
  const addPicked = (name: string, icon: string | null | undefined) => {
    const rule = connectionFromInstalled({ name, icon })
    if (!rules().some(item => item.id === rule.id)) setRules([...rules(), rule])
    closePicker()
  }

  const calendarCount = () => calendarSources().length

  return <>
    <Group
      title="Connected apps"
      description="Windows apps show their alerts in the island. Connect an app to keep it here, then switch it off any time to silence it. Apps you have not connected still alert unless you mute them under Notifications."
    >
      <Show when={rules().length} fallback={<p class="nat-empty">No apps connected yet. Pick one from the suggestions below, or add any app installed on this PC.</p>}>
        <For each={rules()}>{rule => {
          const on = () => rule.notifications
          return <div class="set-row nat-row">
            <NotificationAppIcon app={rule.name} icon={rule.icon} size={30} />
            <span class="set-row__text">
              <strong>{rule.name}</strong>
              <small>{on() ? 'Connected. Alerts show in the island.' : 'Switched off. Alerts are silenced.'}</small>
            </span>
            <span class="set-row__control">
              <Switch checked={on()} label={`${rule.name} alerts`} onChange={value => setAlerts(rule.id, value)} />
              <button type="button" class="nat-x" aria-label={`Remove ${rule.name} from this list`} title="Remove from list" onClick={() => removeRule(rule.id)}><X size={13} strokeWidth={2.2} /></button>
            </span>
          </div>
        }}</For>
      </Show>
      <div class="set-row nat-add">
        <span class="set-row__text"><strong>Add an app</strong><small>Choose from the apps installed on this PC</small></span>
        <span class="set-row__control">
          <button type="button" class="button" aria-expanded={picking()} onClick={() => (picking() ? closePicker() : void openPicker())}>
            <Plus size={13} strokeWidth={2.2} />{picking() ? 'Close' : 'Add app'}
          </button>
        </span>
      </div>
      <Show when={picking()}>
        <div class="nat-picker">
          <label class="nat-picker__search">
            <Search size={13} strokeWidth={2} aria-hidden="true" />
            <input ref={searchEl} type="search" aria-label="Search installed apps" placeholder="Search apps" value={query()} onInput={event => setQuery(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closePicker() } }} />
          </label>
          <div class="nat-picker__list" role="listbox" aria-label="Installed apps">
            <Show when={installed() !== null} fallback={<p class="nat-picker__note">Looking for apps…</p>}>
              <Show when={pickable().recent.length}>
                <p class="nat-picker__head">Sent an alert recently</p>
                <For each={pickable().recent}>{item => <button type="button" class="nat-pick" role="option" aria-selected="false" onClick={() => addPicked(item.name, item.icon)}><NotificationAppIcon app={item.name} icon={item.icon} size={26} /><span class="nat-pick__name">{item.name}</span><em>Add</em></button>}</For>
              </Show>
              <Show when={pickable().apps.length}>
                <p class="nat-picker__head">Installed apps</p>
                <For each={pickable().apps}>{app => <button type="button" class="nat-pick" role="option" aria-selected="false" onClick={() => addPicked(app.name, app.icon)}><NotificationAppIcon app={app.name} icon={app.icon} size={26} /><span class="nat-pick__name">{app.name}</span><em>Add</em></button>}</For>
                <Show when={pickable().more > 0}><p class="nat-picker__note">{pickable().more} more. Type to narrow the list.</p></Show>
              </Show>
              <Show when={!pickable().recent.length && !pickable().apps.length}>
                <p class="nat-picker__note">{loadError() ? 'Could not read the installed apps. Try again in a moment.' : query().trim() ? `No app matches “${query().trim()}”.` : 'Every app on this PC is already connected.'}</p>
              </Show>
            </Show>
          </div>
        </div>
      </Show>
    </Group>

    <Show when={suggestions().length}>
      <Group title="Suggested apps" description="Popular Windows apps. Connecting one does not sign in to anything, it only keeps the app in your list.">
        <For each={NATIVE_GROUPS}>{group => {
          const items = () => suggestions().filter(entry => entry.group === group.id)
          return <Show when={items().length}>
            <Subhead title={group.label} />
            <For each={items()}>{entry => <div class="set-row nat-row">
              <NotificationAppIcon app={entry.name} size={30} />
              <span class="set-row__text"><strong>{entry.name}</strong><small>{entry.hint}</small></span>
              <span class="set-row__control"><button type="button" class="button" aria-label={`Connect ${entry.name}`} onClick={() => connectEntry(entry.id)}>Connect</button></span>
            </div>}</For>
          </Show>
        }}</For>
      </Group>
    </Show>

    <Group title="Music, calendars and AI tools" description="These connect in their own way.">
      <div class="set-row nat-link">
        <span class="nat-link__tile" style={{ background: '#ff375f' }} aria-hidden="true"><Music2 size={16} strokeWidth={1.9} /></span>
        <span class="set-row__text"><strong>Music and video</strong><small>Spotify, Apple Music, browsers, VLC and any app that uses Windows media controls show up in the island on their own.</small></span>
        <span class="set-row__control"><span class="nat-chip nat-chip--ok">Automatic</span></span>
      </div>
      <LinkRow icon={CalendarDays} tint="#ff453a" title="Calendars" hint={calendarCount() ? `${calendarCount()} subscribed. Outlook, Windows Calendar and Google connect with a private link.` : 'Outlook, Windows Calendar and Google connect with a private calendar link. Desktop calendars are not read directly.'} action={calendarCount() ? 'Manage' : 'Set up'} onAction={() => props.onNavigate('calendar')} />
      <LinkRow icon={Sparkles} tint="#bf5af2" title="AI tools" hint="Claude Code, Codex and Cursor usage, plus alerts when an agent finishes or needs you." action="Open" onAction={() => props.onNavigate('ai')} />
    </Group>
  </>
}
