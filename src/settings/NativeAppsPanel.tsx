import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { CalendarDays, ChevronRight, Music2, Search, Sparkles, X } from 'lucide-solid'
import { cmd, type AppConnection, type InstalledApp } from '../lib/ipc'
import { settings, patchSettings } from '../state/settings'
import { calendarSources, refreshCalendarSources } from '../state/calendarSources'
import AppLogo from './AppLogo'
import { loadInstalledApps } from '../lib/appIcons'
import { NATIVE_APPS, NATIVE_GROUPS, appSlug, connectionForEntry, connectionFromEntry, connectionFromInstalled, filterApps, groupByLetter, nativeAppState, nativeRules, uniqueApps, type ListedApp } from '../lib/nativeApps'
import { Group, Subhead, Switch } from './controls'
import './NativeAppsPanel.css'

type Navigate = (page: string) => void
const PAGE = 120

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
  const [query, setQuery] = createSignal('')
  const [onlyConnected, setOnlyConnected] = createSignal(false)
  const [installed, setInstalled] = createSignal<InstalledApp[] | null>(null)
  const [seen, setSeen] = createSignal<Set<string>>(new Set())
  const [loadError, setLoadError] = createSignal(false)
  const [limit, setLimit] = createSignal(PAGE)

  const load = () => {
    setLoadError(false)
    loadInstalledApps(true).then(setInstalled).catch(() => { setLoadError(true); setInstalled([]) })
  }
  onMount(() => {
    void refreshCalendarSources().catch(() => {})
    load()
    void cmd.notificationsGet().then(items => setSeen(new Set(items.map(item => item.app?.trim().toLowerCase()).filter(Boolean) as string[]))).catch(() => {})
  })

  const rules = () => nativeRules(settings.connections)
  const setRules = (next: AppConnection[]) => patchSettings({ connections: [...settings.connections.filter(connection => !!connection.url), ...next] })
  const ruleFor = (name: string) => rules().find(rule => rule.id === `native:app-${appSlug(name)}`) ?? connectionForEntry({ id: '', sources: [name] }, settings.connections)
  const isOn = (name: string) => !!ruleFor(name)?.notifications

  const connectEntry = (entryId: string) => {
    const entry = NATIVE_APPS.find(item => item.id === entryId)
    if (!entry) return
    const existing = connectionForEntry(entry, settings.connections)
    if (existing) setRules(rules().map(rule => rule.id === existing.id ? { ...rule, notifications: true } : rule))
    else setRules([...rules(), connectionFromEntry(entry)])
  }
  const setAlerts = (id: string, on: boolean) => setRules(rules().map(rule => rule.id === id ? { ...rule, notifications: on } : rule))
  const removeRule = (id: string) => setRules(rules().filter(rule => rule.id !== id))
  /** Switch in the full list: on connects (or unmutes), off disconnects by muting so the app stays in Connected apps. */
  const toggleApp = (app: ListedApp, on: boolean) => {
    const existing = ruleFor(app.name)
    if (existing) setAlerts(existing.id, on)
    else if (on) setRules([...rules(), connectionFromInstalled({ name: app.name })])
  }

  const suggestions = createMemo(() => NATIVE_APPS.filter(entry => nativeAppState(entry, settings.connections) === 'default'))
  const apps = createMemo(() => uniqueApps(installed() ?? []))
  const shown = createMemo(() => {
    const list = filterApps(apps(), query())
    return onlyConnected() ? list.filter(app => isOn(app.name)) : list
  })
  const visible = createMemo(() => shown().slice(0, limit()))
  const sections = createMemo(() => query().trim() ? [{ letter: '', apps: visible() }] : groupByLetter(visible()))
  const connectedCount = createMemo(() => rules().filter(rule => rule.notifications).length)

  let sentinel: HTMLDivElement | undefined
  createEffect(() => {
    visible(); shown()
    const node = sentinel
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) setLimit(count => count + PAGE) }, { rootMargin: '200px' })
    observer.observe(node)
    onCleanup(() => observer.disconnect())
  })
  createEffect(() => { query(); onlyConnected(); setLimit(PAGE) })

  const calendarCount = () => calendarSources().length

  return <>
    <Group
      title="Connected apps"
      description="Windows apps show their alerts in the island. Connect an app to keep it here, then switch it off any time to silence it. Apps you have not connected still alert unless you mute them under Notifications."
    >
      <Show when={rules().length} fallback={<p class="nat-empty">No apps connected yet. Switch one on in the list below.</p>}>
        <For each={rules()}>{rule => <div class="set-row nat-row">
          <AppLogo app={rule.name} aliases={rule.notificationSources} icon={rule.icon} size={30} />
          <span class="set-row__text">
            <strong>{rule.name}</strong>
            <small>{rule.notifications ? 'Connected. Alerts show in the island.' : 'Switched off. Alerts are silenced.'}</small>
          </span>
          <span class="set-row__control">
            <Switch checked={rule.notifications} label={`${rule.name} alerts`} onChange={value => setAlerts(rule.id, value)} />
            <button type="button" class="nat-x" aria-label={`Remove ${rule.name} from this list`} title="Remove from list" onClick={() => removeRule(rule.id)}><X size={13} strokeWidth={2.2} /></button>
          </span>
        </div>}</For>
      </Show>
    </Group>

    <Group title="All apps on this PC" description="Every app Windows can launch. Switch one on to connect it. A dot means it sent an alert recently.">
      <div class="nat-toolbar">
        <label class="nat-search">
          <Search size={13} strokeWidth={2} aria-hidden="true" />
          <input type="search" aria-label="Search apps" placeholder="Search apps" value={query()} onInput={event => setQuery(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Escape' && query()) { event.stopPropagation(); setQuery('') } }} />
        </label>
        <button type="button" class="nat-chip-btn" classList={{ 'nat-chip-btn--on': !onlyConnected() }} aria-pressed={!onlyConnected()} onClick={() => setOnlyConnected(false)}>All</button>
        <button type="button" class="nat-chip-btn" classList={{ 'nat-chip-btn--on': onlyConnected() }} aria-pressed={onlyConnected()} onClick={() => setOnlyConnected(true)}>Connected{connectedCount() ? ` ${connectedCount()}` : ''}</button>
      </div>
      <div class="nat-list" role="list" aria-label="Apps on this PC">
        <Show when={installed() !== null} fallback={<p class="nat-list__note">Looking for apps…</p>}>
          <For each={sections()}>{section => <>
            <Show when={section.letter}><p class="nat-list__letter" role="presentation">{section.letter}</p></Show>
            <For each={section.apps}>{app => <div class="nat-item" role="listitem">
              <AppLogo app={app.name} id={app.id} icon={app.icon} size={28} />
              <span class="nat-item__name">{app.name}</span>
              <Show when={seen().has(app.name.trim().toLowerCase())}><span class="nat-item__dot" title="Sent an alert recently" aria-label="Sent an alert recently" /></Show>
              <Switch checked={isOn(app.name)} label={`${app.name} alerts`} onChange={value => toggleApp(app, value)} />
            </div>}</For>
          </>}</For>
          <Show when={shown().length > visible().length}><div ref={sentinel} class="nat-list__more"><button type="button" class="text-button" onClick={() => setLimit(count => count + PAGE)}>Show more ({shown().length - visible().length})</button></div></Show>
          <Show when={!shown().length}>
            <p class="nat-list__note">
              {loadError() ? 'Could not read the installed apps.' : onlyConnected() ? 'No connected apps match.' : query().trim() ? `No app matches “${query().trim()}”.` : 'No apps found.'}
              <Show when={loadError()}> <button type="button" class="text-button" onClick={load}>Try again</button></Show>
            </p>
          </Show>
        </Show>
      </div>
    </Group>

    <Show when={suggestions().length}>
      <Group title="Suggested apps" description="Popular Windows apps. Connecting one does not sign in to anything, it only keeps the app in your list.">
        <For each={NATIVE_GROUPS}>{group => {
          const items = () => suggestions().filter(entry => entry.group === group.id)
          return <Show when={items().length}>
            <Subhead title={group.label} />
            <For each={items()}>{entry => <div class="set-row nat-row">
              <AppLogo app={entry.name} aliases={entry.sources} size={30} />
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
