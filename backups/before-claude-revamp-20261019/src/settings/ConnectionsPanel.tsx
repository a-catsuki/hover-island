import { createSignal, For, onMount, onCleanup, Show } from 'solid-js'
import { Bell, BellOff, ExternalLink, Loader, Plus, Trash2 } from 'lucide-solid'
import { cmd, listen, type AppConnection, type AppNotification } from '../lib/ipc'
import { settings, patchSettings, flushSettings } from '../state/settings'
import { reportError } from '../state/feedback'
import BrandIcon from '../components/BrandIcon'
import NotificationAccessPanel from './NotificationAccessPanel'

function host(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function ConnIcon(props: { connection: AppConnection }) {
  return <span class="conn__icon" aria-hidden="true"><Show when={props.connection.icon} fallback={<BrandIcon name={props.connection.id || props.connection.name} size={20} />}>{src => <img src={src()!} alt="" draggable={false} />}</Show></span>
}

export default function ConnectionsPanel() {
  const [catalog, setCatalog] = createSignal<AppConnection[]>([])
  const [status, setStatus] = createSignal<'loading' | 'ready' | 'error'>('loading')
  const [nativeName, setNativeName] = createSignal('')
  const [nativeSources, setNativeSources] = createSignal('')
  const [observedApps, setObservedApps] = createSignal<string[]>([])
  const [testStatus, setTestStatus] = createSignal('')
  const [testing, setTesting] = createSignal('')
  let disposed = false
  let stopListening: (() => void) | undefined

  const observe = (items: AppNotification[]) => setObservedApps(previous => [...new Set([...previous, ...items.map(item => item.app).filter(Boolean)])].sort((a, b) => a.localeCompare(b)).slice(0, 100))
  onMount(() => {
    void cmd.notificationsGet().then(observe).catch(() => {})
    void listen<AppNotification[]>('notifications://changed', event => observe(event.payload)).then(fn => disposed ? fn() : stopListening = fn)
    cmd.connectionsList().then(list => { setCatalog(list ?? []); setStatus('ready') }).catch(() => setStatus('error'))
  })
  onCleanup(() => { disposed = true; stopListening?.() })

  const nativeConnections = () => settings.connections.filter(connection => !connection.url)
  const connected = (id: string) => settings.connections.some(connection => connection.id === id)
  const notifyOn = (id: string) => settings.connections.find(connection => connection.id === id)?.notifications ?? false
  const notificationSources = (id: string) => settings.connections.find(connection => connection.id === id)?.notificationSources ?? []
  const hasNativeSource = (name: string) => nativeConnections().some(connection => notificationSources(connection.id).some(source => source.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0))

  const capturePreferences = () => ({ modules: { ...settings.modules, notifications: true }, notifications: { ...settings.notifications, enabled: true, systemListener: true } })
  const toggleConnected = (entry: AppConnection) => {
    const adding = !connected(entry.id)
    patchSettings({ ...(adding ? capturePreferences() : {}), connections: adding
      ? [...settings.connections, { ...entry, notifications: entry.notifications ?? true }]
      : settings.connections.filter(connection => connection.id !== entry.id) })
  }
  const toggleNotify = (entry: AppConnection) => patchSettings({ ...(!notifyOn(entry.id) ? capturePreferences() : {}), connections: settings.connections.map(connection => connection.id === entry.id ? { ...connection, notifications: !connection.notifications } : connection) })
  const setSources = (id: string, value: string) => {
    const connection = settings.connections.find(item => item.id === id)
    const sources = [...new Set([connection?.name ?? '', ...value.split(',').map(item => item.trim())].filter(Boolean))].slice(0, 16)
    patchSettings({ connections: settings.connections.map(connection => connection.id === id ? { ...connection, notificationSources: sources } : connection) })
  }
  const open = (entry: AppConnection) => { if (entry.url) void cmd.appsOpenWebApp(entry.url).catch(error => reportError(`Could not open ${entry.name}`, error)) }
  const test = async (entry: AppConnection) => {
    setTesting(entry.id)
    setTestStatus('')
    try {
      await flushSettings()
      await cmd.notificationsTestConnection(entry.id)
      setTestStatus(`Routing test sent for ${entry.name}. Look at the notch; real Windows delivery still needs notification access.`)
    } catch (error) { setTestStatus(error instanceof Error ? error.message : String(error)) }
    finally { setTesting('') }
  }
  const addNative = (nameInput: string, sourcesInput = '') => {
    const name = nameInput.trim()
    if (!name) return
    const sources = [...new Set([name, ...sourcesInput.split(',').map(item => item.trim()).filter(Boolean)])].slice(0, 16)
    if (sources.some(source => hasNativeSource(source))) return
    const id = `native:${crypto.randomUUID()}`
    patchSettings({ ...capturePreferences(), connections: [...settings.connections, { id, name, url: '', notifications: true, notificationSources: sources }] })
    setTestStatus(`${name} is ready to match Windows notifications from ${sources.join(', ')}.`)
  }
  const addObserved = (name: string) => addNative(name)
  const addNativeApp = (event: SubmitEvent) => {
    event.preventDefault()
    addNative(nativeName(), nativeSources())
    setNativeName('')
    setNativeSources('')
  }
  const removeNative = (id: string) => patchSettings({ connections: settings.connections.filter(connection => connection.id !== id) })
  const shortcutList = () => {
    const shortcuts = catalog().filter(entry => !!entry.url)
    const customShortcuts = settings.connections.filter(connection => !!connection.url && !shortcuts.some(entry => entry.id === connection.id))
    return [...shortcuts, ...customShortcuts]
  }

  return <div class="conn">
    <p class="conn__lead">Choose an app Windows has notified you about. Hover Island matches its alert source and can test routing into the notch. Enable notification capture and grant access in Alerts to receive real Windows notifications.</p>
    <NotificationAccessPanel />
    <Show when={testStatus()}><p class="set-note" role="status">{testStatus()}</p></Show>

    <section class="conn__native" aria-labelledby="conn-native-title">
      <div class="conn__section-heading"><div><h3 id="conn-native-title">Windows apps</h3><p>Only installed apps and browsers that produce Windows notifications can be matched here.</p></div></div>
      <Show when={observedApps().length} fallback={<p class="conn__empty">No notification sources observed yet. Open an app and let it send a Windows notification, or add its source name below.</p>}>
        <div class="conn__observed-list" aria-label="Apps seen in Windows notifications">
          <For each={observedApps()}>{name => <div class="conn__observed-row"><span><strong>{name}</strong><small>Seen in Windows notifications</small></span><button type="button" class="button button--secondary" disabled={hasNativeSource(name)} onClick={() => addObserved(name)}>{hasNativeSource(name) ? 'Added' : 'Add app'}</button></div>}</For>
        </div>
      </Show>

      <div class="conn__native-list" aria-label="Connected Windows notification sources">
        <For each={nativeConnections()}>{connection => <div class="conn__native-card">
          <ConnIcon connection={connection} />
          <div class="conn__native-meta"><strong>{connection.name}</strong><small>Windows source: {notificationSources(connection.id).join(', ') || 'No source names set'}</small>
            <label class="conn__sources-label">Match other Windows app names
              <input class="conn__sources" value={notificationSources(connection.id).join(', ')} placeholder={connection.name} aria-label={`Windows notification app names for ${connection.name}`} onInput={event => setSources(connection.id, event.currentTarget.value)} />
            </label>
          </div>
          <div class="conn__native-actions">
            <button type="button" class="conn__bell" classList={{ 'conn__bell--on': notifyOn(connection.id) }} aria-label={notifyOn(connection.id) ? `Mute ${connection.name} alerts` : `Show ${connection.name} alerts`} title={notifyOn(connection.id) ? 'Alerts on' : 'Alerts off'} onClick={() => toggleNotify(connection)}>
              <Show when={notifyOn(connection.id)} fallback={<BellOff size={15} />}><Bell size={15} /></Show>
            </button>
            <button type="button" class="text-button" disabled={!!testing() || !notifyOn(connection.id) || settings.dnd || !settings.notifications.enabled} onClick={() => void test(connection)} aria-label={`Test ${connection.name} alert routing`}>{testing() === connection.id ? 'Testing…' : 'Test notch alert'}</button>
            <button type="button" class="conn__remove" aria-label={`Remove ${connection.name}`} title={`Remove ${connection.name}`} onClick={() => removeNative(connection.id)}><Trash2 size={14} /></button>
          </div>
        </div>}</For>
      </div>

      <details class="conn__manual">
        <summary><Plus size={13} />Add a Windows app manually</summary>
        <form class="conn__custom" onSubmit={addNativeApp}>
          <label>App name<input required maxlength="80" placeholder="e.g. My desktop app" value={nativeName()} onInput={event => setNativeName(event.currentTarget.value)} aria-label="Desktop app name" /></label>
          <label>Other source names <span>(optional)</span><input maxlength="512" placeholder="Separate names with commas" value={nativeSources()} onInput={event => setNativeSources(event.currentTarget.value)} aria-label="Additional Windows notification source names" /></label>
          <button class="button button--secondary" type="submit" disabled={!nativeName().trim()}><Plus size={13} />Add app</button>
        </form>
      </details>
    </section>

    <details class="conn__shortcuts">
      <summary><ExternalLink size={13} />Website shortcuts <span>Open sites in your browser; these do not connect accounts.</span></summary>
      <p class="conn__shortcut-note">A shortcut does not sign in to Gmail, Instagram, Slack, or other services. Browser notification attribution is only available when Windows reports the browser as the source app.</p>
      <Show when={status() === 'ready'} fallback={<div class="conn__state"><Show when={status() === 'loading'} fallback={<span>Could not load website shortcuts.</span>}><Loader class="icon conn__spin" strokeWidth={1.75} aria-hidden="true" /><span>Loading shortcuts…</span></Show></div>}>
        <div class="conn__list"><For each={shortcutList()}>{entry => <div class="conn__row" classList={{ 'conn__row--on': connected(entry.id) }}>
          <ConnIcon connection={entry} />
          <div class="conn__meta"><span class="conn__name">{entry.name}</span><span class="conn__host">{connected(entry.id) ? 'Shortcut saved' : host(entry.url)}</span></div>
          <button type="button" class="conn__open" aria-label={`Open ${entry.name}`} title={`Open ${entry.name}`} onClick={() => open(entry)}><ExternalLink size={15} /></button>
          <Show when={connected(entry.id)}><button type="button" class="conn__bell" classList={{ 'conn__bell--on': notifyOn(entry.id) }} aria-label={notifyOn(entry.id) ? `Mute ${entry.name} alerts` : `Show ${entry.name} alerts`} title={notifyOn(entry.id) ? 'Matching Windows app alerts on' : 'Matching Windows app alerts off'} onClick={() => toggleNotify(entry)}><Show when={notifyOn(entry.id)} fallback={<BellOff size={15} />}><Bell size={15} /></Show></button></Show>
          <button type="button" class="set-switch" classList={{ 'set-switch--on': connected(entry.id) }} role="switch" aria-checked={connected(entry.id)} aria-label={`${connected(entry.id) ? 'Remove' : 'Save'} ${entry.name} shortcut`} onClick={() => toggleConnected(entry)}><span /></button>
        </div>}</For><Show when={shortcutList().length === 0}><p class="muted">No shortcuts are available.</p></Show></div>
      </Show>
    </details>
  </div>
}
