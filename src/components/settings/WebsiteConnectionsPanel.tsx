import { createSignal, For, onMount, Show } from 'solid-js'
import { ExternalLink, Link2, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-solid'
import { addWebsiteConnection, refreshWebsiteAlerts, refreshWebsiteConnections, removeWebsiteConnection, websiteAlertSites, websiteAlertsBusy, websiteAlertsError, websiteAlertsLastChecked, websiteConnections } from '../../state/erp'
import { cmd } from '../../lib/ipc'
import { Group } from '../../settings/controls'
import './panels.css'

function checkedLabel(timestamp: number | undefined): string {
  if (!timestamp) return 'Waiting for first check'
  return `Last checked ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(timestamp)}`
}

export default function WebsiteConnectionsPanel() {
  const [name, setName] = createSignal('')
  const [serverUrl, setServerUrl] = createSignal('')
  const [feedPath, setFeedPath] = createSignal('')
  const [authToken, setAuthToken] = createSignal('')
  const [formError, setFormError] = createSignal('')
  onMount(() => {
    void refreshWebsiteConnections().then(() => refreshWebsiteAlerts(false))
  })

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    setFormError('')
    try {
      await addWebsiteConnection({ serverUrl: serverUrl().trim(), displayName: name().trim(), adapter: 'website', feedPath: feedPath().trim() || undefined, authToken: authToken().trim() || undefined })
      setName('')
      setServerUrl('')
      setFeedPath('')
      setAuthToken('')
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    }
  }

  const refresh = async () => {
    await refreshWebsiteConnections()
    await refreshWebsiteAlerts(false)
  }
  const remove = async (id: string) => {
    try { await removeWebsiteConnection(id) } catch { /* The shared connector status reports the failure. */ }
  }
  const openErpSettings = (url: string) => {
    try { void cmd.appsOpenUrl(new URL('/settings/notifications', url).toString()) } catch { /* Invalid saved addresses are rejected by native pairing. */ }
  }

  return <Group
    title="Website alert feeds"
    description={`Connect a site that publishes a read-only alert feed. Hover Island checks it in the background and shows new items in the island. ${websiteConnections().length} of 12 connected.`}
  >
    <Show when={websiteConnections().length} fallback={<p class="slist-empty">No alert feeds connected. Add a website below to start checking for new alerts.</p>}>
      <For each={websiteConnections()}>{connection => {
        const site = () => websiteAlertSites().find(item => item.connection.id === connection.id)
        const feedStatus = () => site()?.error
          ? `Needs attention · ${site()?.error}`
          : site()
            ? `Feed responding · ${site()?.events.length ?? 0} recent alerts`
            : websiteAlertsLastChecked()
              ? 'Waiting for this feed to respond'
              : 'Waiting for first check'
        return <div class="slist-row">
          <span class="slist-row__tile" aria-hidden="true"><ShieldCheck size={15} strokeWidth={1.9} /></span>
          <span class="slist-row__text">
            <strong>{connection.displayName}</strong>
            <small classList={{ 'is-error': !!site()?.error }}>{feedStatus()}</small>
            <small>{connection.serverUrl}</small>
          </span>
          <span class="slist-row__actions">
            <Show when={connection.adapter === 'erp'}><button type="button" class="text-button" onClick={() => openErpSettings(connection.serverUrl)}><ExternalLink size={12} /> Feed settings</button></Show>
            <button type="button" class="slist-icon-btn slist-icon-btn--danger" disabled={websiteAlertsBusy()} aria-label={`Remove ${connection.displayName}`} title="Remove" onClick={() => void remove(connection.id)}><Trash2 size={14} /></button>
          </span>
        </div>
      }}</For>
    </Show>

    <div class="slist-foot">
      <span aria-live="polite">{checkedLabel(websiteAlertsLastChecked())}</span>
      <button type="button" class="text-button" disabled={websiteAlertsBusy()} onClick={() => void refresh()}>
        <RefreshCw size={12} classList={{ 'slist-spin': websiteAlertsBusy() }} />
        {websiteAlertsError() ? 'Retry feed checks' : websiteAlertsBusy() ? 'Checking feeds…' : 'Check feeds now'}
      </button>
    </div>
    <Show when={websiteAlertsError()}><p class="sform__error" style={{ padding: '0 16px 12px' }} role="alert">Could not check website feeds: {websiteAlertsError()}</p></Show>

    <Show when={websiteConnections().length < 12}>
      <form class="sform" onSubmit={submit}>
        <h3 class="sform__title"><Plus size={14} strokeWidth={2} />Add a website feed</h3>
        <div class="sform__grid">
          <label class="sform__field"><span>Website name</span><input required maxlength="80" autocomplete="organization" placeholder="My website" value={name()} onInput={event => setName(event.currentTarget.value)} /></label>
          <label class="sform__field"><span>Website address</span><input type="url" required autocomplete="url" placeholder="https://example.com" value={serverUrl()} onInput={event => setServerUrl(event.currentTarget.value)} /></label>
        </div>
        <details class="sform__details">
          <summary>Advanced feed settings</summary>
          <div>
            <label class="sform__field"><span>Alert feed path<small>optional when the site publishes discovery metadata</small></span><input autocomplete="off" placeholder="Found automatically, or enter /api/alerts" value={feedPath()} onInput={event => setFeedPath(event.currentTarget.value)} /></label>
            <label class="sform__field"><span>Bearer key<small>optional</small></span><input type="password" autocomplete="off" maxlength="8192" value={authToken()} onInput={event => setAuthToken(event.currentTarget.value)} /></label>
          </div>
        </details>
        <p class="sform__callout"><ShieldCheck size={13} />Pairing checks the feed before saving it. Keys stay encrypted on this PC. Remote feeds must use HTTPS, and only the feed address is contacted, without browser cookies or sign-in sessions.</p>
        <Show when={formError()}><p class="sform__error" role="alert">{formError()}</p></Show>
        <div class="sform__actions"><button class="button button--primary" type="submit" disabled={websiteAlertsBusy()}><Link2 size={13} />{websiteAlertsBusy() ? 'Checking website…' : 'Validate and connect'}</button></div>
      </form>
    </Show>
  </Group>
}
