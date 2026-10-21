import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { ChevronDown, Plus, Search, X } from 'lucide-solid'
import { cmd, type AppConnection, type InstalledApp } from '../lib/ipc'
import { settings, patchSettings } from '../state/settings'
import AppLogo from './AppLogo'
import { loadInstalledApps } from '../lib/appIcons'
import { NATIVE_APPS, NATIVE_GROUPS, appSlug, connectionForEntry, connectionFromEntry, connectionFromInstalled, filterApps, groupByLetter, nativeAppState, nativeRules, uniqueApps, type ListedApp } from '../lib/nativeApps'
import { Group, Switch } from './controls'
import './NativeAppsPanel.css'

type Navigate = (page: string) => void
const PAGE = 120

/**
 * Connect native Windows apps to the island. Everything here is saved in
 * `settings.connections` with the same default-allow rule the notification
 * pipeline uses: an app alerts unless its rule says notifications are off.
 */
export default function NativeAppsPanel(_props: { onNavigate: Navigate }) {
  const [query, setQuery] = createSignal('')
  const [onlyConnected, setOnlyConnected] = createSignal(false)
  const [installed, setInstalled] = createSignal<InstalledApp[] | null>(null)
  const [seen, setSeen] = createSignal<Set<string>>(new Set())
  const [loadError, setLoadError] = createSignal(false)
  const [limit, setLimit] = createSignal(PAGE)
  const [browse, setBrowse] = createSignal(false)

  const load = () => {
    setLoadError(false)
    loadInstalledApps(true).then(setInstalled).catch(() => { setLoadError(true); setInstalled([]) })
  }
  onMount(() => {
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

  const connected = () => rules()
  return <>
    <Group title="Apps" description="Connected apps show their alerts in the island. Switch one off to silence it, or remove it from the list. Apps you have not connected still alert unless you mute them under Notifications." flush>
      <div class="nat-bento">
        <Show when={connected().length} fallback={<p class="nat-empty nat-bento__wide">No apps connected yet. Pick one below.</p>}>
          <For each={connected()}>{rule => <div class="nat-tile" classList={{ 'nat-tile--off': !rule.notifications }}>
            <AppLogo app={rule.name} aliases={rule.notificationSources} icon={rule.icon} size={34} />
            <span class="nat-tile__text"><strong title={rule.name}>{rule.name}</strong><small>{rule.notifications ? 'Alerts on' : 'Silenced'}</small></span>
            <Switch checked={rule.notifications} label={`${rule.name} alerts`} onChange={value => setAlerts(rule.id, value)} />
            <button type="button" class="nat-x nat-tile__x" aria-label={`Remove ${rule.name} from this list`} title="Remove from list" onClick={() => removeRule(rule.id)}><X size={12} strokeWidth={2.4} /></button>
          </div>}</For>
        </Show>
      </div>
      <Show when={suggestions().length}>
        <p class="nat-bento__label">Suggested</p>
        <div class="nat-bento">
          <For each={suggestions()}>{entry => <button type="button" class="nat-tile nat-tile--suggest" title={entry.hint} aria-label={`Connect ${entry.name}`} onClick={() => connectEntry(entry.id)}>
            <AppLogo app={entry.name} aliases={entry.sources} size={34} />
            <span class="nat-tile__text"><strong>{entry.name}</strong></span>
            <span class="nat-tile__add" aria-hidden="true"><Plus size={14} strokeWidth={2.4} /></span>
          </button>}</For>
        </div>
      </Show>
      <button type="button" class="nat-browse" aria-expanded={browse()} onClick={() => setBrowse(value => !value)}>
        <span>Browse every app on this PC{apps().length ? ` (${apps().length})` : ''}</span>
        <ChevronDown size={14} strokeWidth={2.2} class="nat-browse__chev" classList={{ 'nat-browse__chev--open': browse() }} />
      </button>
      <Show when={browse()}>
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
      </Show>
    </Group>
  </>
}
