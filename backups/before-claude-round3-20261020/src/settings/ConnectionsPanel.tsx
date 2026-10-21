import { createMemo, createSignal, For, onMount, onCleanup, Show } from 'solid-js'
import { Bell, BellOff, ExternalLink, Loader } from 'lucide-solid'
import { cmd, listen, type AppConnection, type AppNotification } from '../lib/ipc'
import { settings, patchSettings, flushSettings } from '../state/settings'
import { reportError } from '../state/feedback'
import { matchingConnection, notificationAllowed } from '../lib/connectionSources'
import BrandIcon from '../components/BrandIcon'
import NotificationAppIcon from '../components/shell/NotificationAppIcon'
import NotificationAccessPanel from './NotificationAccessPanel'
import './NotificationsSettings.css'

function host(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function ConnIcon(props: { connection: AppConnection }) {
  return <span class="conn__icon" aria-hidden="true"><Show when={props.connection.icon} fallback={<BrandIcon name={props.connection.id || props.connection.name} size={20} />}>{src => <img src={src()!} alt="" draggable={false} />}</Show></span>
}

/** App notifications: every app alerts by default; turn an app off to mute it. */
export default function ConnectionsPanel() {
  const [catalog, setCatalog] = createSignal<AppConnection[]>([])
  const [status, setStatus] = createSignal<'loading' | 'ready' | 'error'>('loading')
  const [observed, setObserved] = createSignal<Record<string, string | null>>({})
  const [testStatus, setTestStatus] = createSignal('')
  const [testing, setTesting] = createSignal(false)
  let disposed = false
  let stopListening: (() => void) | undefined

  const observe = (items: AppNotification[]) => setObserved(previous => {
    const next = { ...previous }
    for (const item of items) {
      if (!item.app || item.id.startsWith('notification:routing-test')) continue
      if (!(item.app in next) || (!next[item.app] && item.icon)) next[item.app] = item.icon ?? null
    }
    return next
  })
  onMount(() => {
    void cmd.notificationsGet().then(observe).catch(() => {})
    void listen<AppNotification[]>('notifications://changed', event => observe(event.payload)).then(fn => disposed ? fn() : stopListening = fn)
    cmd.connectionsList().then(list => { setCatalog(list ?? []); setStatus('ready') }).catch(() => setStatus('error'))
  })
  onCleanup(() => { disposed = true; stopListening?.() })

  /** Apps seen in Windows notifications plus apps the user already muted, A to Z. */
  const apps = createMemo(() => {
    const names = new Map<string, string | null>(Object.entries(observed()))
    for (const connection of settings.connections) if (!connection.url && !names.has(connection.name)) names.set(connection.name, connection.icon ?? null)
    return [...names.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, icon]) => ({ name, icon }))
  })
  const isOn = (name: string) => notificationAllowed({ app: name }, settings.connections)

  const toggleApp = (name: string) => {
    const connection = matchingConnection(name, settings.connections)
    if (isOn(name)) {
      if (connection) patchSettings({ connections: settings.connections.map(item => item.id === connection.id ? { ...item, notifications: false } : item) })
      else patchSettings({ connections: [...settings.connections, { id: `native:${crypto.randomUUID()}`, name, url: '', notifications: false, notificationSources: [name] }] })
    } else if (connection) {
      const muteOnly = connection.id.startsWith('native:') && (connection.notificationSources ?? []).every(source => source.trim().toLowerCase() === connection.name.trim().toLowerCase())
      patchSettings({ connections: muteOnly
        ? settings.connections.filter(item => item.id !== connection.id)
        : settings.connections.map(item => item.id === connection.id ? { ...item, notifications: true } : item) })
    }
  }

  const sendTest = async () => {
    setTesting(true)
    setTestStatus('')
    try {
      await flushSettings()
      await cmd.notificationsTestConnection('')
      setTestStatus('Test sent. Look at the notch.')
    } catch (error) { setTestStatus(error instanceof Error ? error.message : String(error)) }
    finally { setTesting(false) }
  }

  const connected = (id: string) => settings.connections.some(connection => connection.id === id)
  const notifyOn = (id: string) => settings.connections.find(connection => connection.id === id)?.notifications ?? false
  const toggleConnected = (entry: AppConnection) => patchSettings({ connections: connected(entry.id)
    ? settings.connections.filter(connection => connection.id !== entry.id)
    : [...settings.connections, { ...entry, notifications: entry.notifications ?? true }] })
  const toggleNotify = (entry: AppConnection) => patchSettings({ connections: settings.connections.map(connection => connection.id === entry.id ? { ...connection, notifications: !connection.notifications } : connection) })
  const open = (entry: AppConnection) => { if (entry.url) void cmd.appsOpenWebApp(entry.url).catch(error => reportError(`Could not open ${entry.name}`, error)) }
  const shortcutList = () => {
    const shortcuts = catalog().filter(entry => !!entry.url)
    const customShortcuts = settings.connections.filter(connection => !!connection.url && !shortcuts.some(entry => entry.id === connection.id))
    return [...shortcuts, ...customShortcuts]
  }

  return <div class="appn">
    <p class="appn__lead">Apps can show alerts in the notch. Turn an app off to mute it.</p>
    <NotificationAccessPanel />

    <section aria-labelledby="appn-apps-title">
      <div class="appn__section-head">
        <h3 id="appn-apps-title">Apps</h3>
        <button type="button" class="text-button" disabled={testing() || settings.dnd || !settings.notifications.enabled} onClick={() => void sendTest()}>{testing() ? 'Sending…' : 'Send test notification'}</button>
      </div>
      <Show when={apps().length} fallback={<p class="appn__empty">No apps yet. They show up here after Windows sends a notification from them.</p>}>
        <div class="appn__list" role="list">
          <For each={apps()}>{app => <div class="appn__row" role="listitem">
            <NotificationAppIcon app={app.name} icon={app.icon} size={32} />
            <div class="appn__row-copy"><span class="appn__name">{app.name}</span><span class="appn__sub">{isOn(app.name) ? 'Alerts on' : 'Muted'}</span></div>
            <button type="button" class="set-switch" classList={{ 'set-switch--on': isOn(app.name) }} role="switch" aria-checked={isOn(app.name)} aria-label={`${app.name} notifications`} onClick={() => toggleApp(app.name)}><span /></button>
          </div>}</For>
        </div>
      </Show>
      <Show when={testStatus()}><p class="appn__status" role="status">{testStatus()}</p></Show>
    </section>

    <details class="conn__shortcuts appn__shortcuts">
      <summary><ExternalLink size={13} />Website shortcuts <span>Open sites in your browser. These do not connect accounts.</span></summary>
      <Show when={status() === 'ready'} fallback={<div class="conn__state"><Show when={status() === 'loading'} fallback={<span>Could not load website shortcuts.</span>}><Loader class="icon conn__spin" strokeWidth={1.75} aria-hidden="true" /><span>Loading shortcuts…</span></Show></div>}>
        <div class="conn__list"><For each={shortcutList()}>{entry => <div class="conn__row" classList={{ 'conn__row--on': connected(entry.id) }}>
          <ConnIcon connection={entry} />
          <div class="conn__meta"><span class="conn__name">{entry.name}</span><span class="conn__host">{connected(entry.id) ? 'Shortcut saved' : host(entry.url)}</span></div>
          <button type="button" class="conn__open" aria-label={`Open ${entry.name}`} title={`Open ${entry.name}`} onClick={() => open(entry)}><ExternalLink size={15} /></button>
          <Show when={connected(entry.id)}><button type="button" class="conn__bell" classList={{ 'conn__bell--on': notifyOn(entry.id) }} aria-label={notifyOn(entry.id) ? `Mute ${entry.name} alerts` : `Show ${entry.name} alerts`} title={notifyOn(entry.id) ? 'Alerts on' : 'Alerts off'} onClick={() => toggleNotify(entry)}><Show when={notifyOn(entry.id)} fallback={<BellOff size={15} />}><Bell size={15} /></Show></button></Show>
          <button type="button" class="set-switch" classList={{ 'set-switch--on': connected(entry.id) }} role="switch" aria-checked={connected(entry.id)} aria-label={`${connected(entry.id) ? 'Remove' : 'Save'} ${entry.name} shortcut`} onClick={() => toggleConnected(entry)}><span /></button>
        </div>}</For><Show when={shortcutList().length === 0}><p class="muted">No shortcuts are available.</p></Show></div>
      </Show>
    </details>
  </div>
}
