import { createSignal, For, onMount, onCleanup, Show } from 'solid-js'
import { Bell, BellOff, ExternalLink, Loader, Plus } from 'lucide-solid'
import { cmd, listen, type AppConnection, type AppNotification } from '../lib/ipc'
import { settings, patchSettings } from '../state/settings'
import { reportError } from '../state/feedback'
import BrandIcon from '../components/BrandIcon'

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function ConnIcon(props: { connection: AppConnection }) {
  return (
    <span class="conn__icon" aria-hidden="true">
      <Show
        when={props.connection.icon}
        fallback={
          <BrandIcon name={props.connection.id || props.connection.name} size={20} />
        }
      >
        {(src) => <img src={src()!} alt="" draggable={false} />}
      </Show>
    </span>
  )
}

export default function ConnectionsPanel() {
  const [catalog, setCatalog] = createSignal<AppConnection[]>([])
  const [status, setStatus] = createSignal<'loading' | 'ready' | 'error'>('loading')
  const [nativeName, setNativeName] = createSignal('')
  const [nativeSources, setNativeSources] = createSignal('')
  const [observedApps,setObservedApps]=createSignal<string[]>([])
  let disposed=false,stopListening:(()=>void)|undefined
  const observe=(items:AppNotification[])=>setObservedApps(previous=>[...new Set([...previous,...items.map(item=>item.app).filter(Boolean)])].sort().slice(0,100))

  onMount(() => {
    void cmd.notificationsGet().then(observe).catch(()=>{})
    void listen<AppNotification[]>('notifications://changed',event=>observe(event.payload)).then(fn=>disposed?fn():stopListening=fn)
    cmd
      .connectionsList()
      .then((list) => {
        setCatalog(list ?? [])
        setStatus('ready')
      })
      .catch(() => setStatus('error'))
  })
  onCleanup(()=>{disposed=true;stopListening?.()})

  const connected = (id: string) => settings.connections.some((connection) => connection.id === id)
  const notifyOn = (id: string) => settings.connections.find((connection) => connection.id === id)?.notifications ?? false
  const notificationSources = (id: string) => settings.connections.find((connection) => connection.id === id)?.notificationSources ?? []

  const toggleConnected = (entry: AppConnection) => {
    if (connected(entry.id)) {
      patchSettings({ connections: settings.connections.filter((connection) => connection.id !== entry.id) })
    } else {
      patchSettings({
        connections: [...settings.connections, { ...entry, notifications: entry.notifications ?? true }],
      })
    }
  }

  const toggleNotify = (entry: AppConnection) => {
    patchSettings({
      connections: settings.connections.map((connection) =>
        connection.id === entry.id ? { ...connection, notifications: !connection.notifications } : connection,
      ),
    })
  }

  const setSources = (entry: AppConnection, value: string) => {
    const sources = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))].slice(0, 16)
    patchSettings({
      connections: settings.connections.map((connection) =>
        connection.id === entry.id ? { ...connection, notificationSources: sources } : connection,
      ),
    })
  }

  const open = (entry: AppConnection) => {
    if (!entry.url) return
    void cmd.appsOpenWebApp(entry.url).catch((error) => reportError(`Could not open ${entry.name}`, error))
  }

  const addNativeApp = () => {
    const name = nativeName().trim()
    if (!name) return
    const sources = [...new Set(nativeSources().split(',').map((item) => item.trim()).filter(Boolean))].slice(0, 16)
    const id = `native:${crypto.randomUUID()}`
    patchSettings({
      connections: [...settings.connections, { id, name, url: '', notifications: true, notificationSources: sources.length ? sources : [name] }],
    })
    setNativeName('')
    setNativeSources('')
  }

  const list = () => {
    const base = catalog()
    const extra = settings.connections.filter((connection) => !base.some((item) => item.id === connection.id))
    return [...base, ...extra]
  }

  return (
    <div class="conn">
      <p class="conn__lead">Desktop alerts use the notifications Windows already receives. Enable “Capture Windows notifications” in Alerts and grant access, then choose an app below.</p>
      <Show when={observedApps().length}><div class="conn__observed"><label>Choose an app Windows has notified you about<select aria-label="Choose a Windows notification app" value="" onChange={event=>{const name=event.currentTarget.value;if(!name)return;setNativeName(name);setNativeSources(name)}}><option value="">Select an app…</option><For each={observedApps()}>{name=><option value={name}>{name}</option>}</For></select></label></div></Show>
      <p class="conn__lead conn__lead--muted">Website alerts above keep syncing while their pages are closed. The shortcuts below only open websites; they do not connect to Gmail, Instagram or other accounts. Browser alerts can be enabled by choosing the browser as a Windows app.</p>
      <Show
        when={status() === 'ready'}
        fallback={
          <div class="conn__state">
            <Show when={status() === 'loading'} fallback={<span>Could not load the app catalog.</span>}>
              <Loader class="icon conn__spin" strokeWidth={1.75} aria-hidden="true" />
              <span>Loading catalog…</span>
            </Show>
          </div>
        }
      >
        <div class="conn__list">
          <For each={list()}>
            {(entry) => (
              <>
              <div class="conn__row" classList={{ 'conn__row--on': connected(entry.id) }}>
                <ConnIcon connection={entry} />
                <div class="conn__meta">
                  <span class="conn__name">{entry.name}</span>
                  <span class="conn__host">{entry.url ? (connected(entry.id) ? 'Shortcut saved' : host(entry.url)) : 'Desktop app alerts'}</span>
                </div>
                <Show when={entry.url}>
                  <button
                    type="button"
                    class="conn__open"
                    aria-label={`Open ${entry.name}`}
                    title={`Open ${entry.name}`}
                    onClick={() => open(entry)}
                  >
                    <ExternalLink size={15} />
                  </button>
                </Show>
                <Show when={connected(entry.id)}>
                  <button
                    type="button"
                    class="conn__bell"
                    classList={{ 'conn__bell--on': notifyOn(entry.id) }}
                    aria-label={notifyOn(entry.id) ? `Mute ${entry.name} alerts` : `Show ${entry.name} alerts`}
                    title={notifyOn(entry.id) ? 'Matching Windows app alerts on' : 'Matching Windows app alerts off'}
                    onClick={() => toggleNotify(entry)}
                  >
                    <Show when={notifyOn(entry.id)} fallback={<BellOff size={15} />}>
                      <Bell size={15} />
                    </Show>
                  </button>
                </Show>
                <button
                  type="button"
                  class="set-switch"
                  classList={{ 'set-switch--on': connected(entry.id) }}
                  role="switch"
                  aria-checked={connected(entry.id)}
                  aria-label={`${connected(entry.id) ? 'Remove' : 'Save'} ${entry.name} shortcut`}
                  onClick={() => toggleConnected(entry)}
                >
                  <span />
                </button>
              </div>
              <Show when={connected(entry.id)}>
                <label class="conn__sources-label">
                  Windows app names for alerts
                  <input
                    class="conn__sources"
                    value={notificationSources(entry.id).join(', ')}
                    placeholder={`${entry.name}, ${entry.name} Desktop`}
                    aria-label={`Windows notification app names for ${entry.name}`}
                    onInput={(event) => setSources(entry, event.currentTarget.value)}
                  />
                </label>
              </Show>
              </>
            )}
          </For>
          <Show when={list().length === 0}>
            <p class="muted">No apps available to connect.</p>
          </Show>
        </div>
      </Show>
      <form class="conn__custom" onSubmit={(event) => { event.preventDefault(); addNativeApp() }}>
        <div class="conn__custom-head">
          <strong>Connect a desktop app</strong>
          <small>Any app that raises Windows notifications can surface in the notch. Add the names Windows uses for its alerts.</small>
        </div>
        <input required maxlength="80" placeholder="App name (e.g. My ERP)" value={nativeName()} onInput={(event) => setNativeName(event.currentTarget.value)} aria-label="Desktop app name" />
        <input maxlength="512" placeholder="Notification source names, comma separated (optional)" value={nativeSources()} onInput={(event) => setNativeSources(event.currentTarget.value)} aria-label="Notification source names" />
        <button class="button button--secondary" type="submit" disabled={!nativeName().trim()}><Plus size={13} /> Add desktop app</button>
      </form>
    </div>
  )
}
