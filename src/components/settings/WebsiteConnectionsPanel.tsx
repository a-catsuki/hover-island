import { createSignal, For, onMount, Show } from 'solid-js'
import { ExternalLink, Link2, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-solid'
import { addWebsiteConnection, refreshWebsiteAlerts, refreshWebsiteConnections, removeWebsiteConnection, websiteAlertSites, websiteAlertsBusy, websiteAlertsError, websiteAlertsLastChecked, websiteConnections } from '../../state/erp'
import { cmd } from '../../lib/ipc'
import './WebsiteConnectionsPanel.css'

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

  return <section class="website-connections" aria-labelledby="website-connections-title">
    <header class="website-connections__header">
      <div>
        <h2 id="website-connections-title">Website alert feeds</h2>
        <p>Connect a site that publishes a read-only alert feed. Hover Island checks it in the background and shows new items in the notch.</p>
      </div>
      <span class="website-connections__capacity">{websiteConnections().length}/12</span>
    </header>

    <div class="website-connections__statusbar" aria-live="polite">
      <span>{checkedLabel(websiteAlertsLastChecked())}</span>
      <button type="button" class="website-connections__text-link" disabled={websiteAlertsBusy()} onClick={() => void refresh()}>
        <RefreshCw size={12} classList={{ 'website-connections__spin': websiteAlertsBusy() }} />
        {websiteAlertsError() ? 'Retry feed checks' : websiteAlertsBusy() ? 'Checking feeds…' : 'Check feeds now'}
      </button>
    </div>
    <Show when={websiteAlertsError()}><p class="website-connections__error" role="alert">Could not check website feeds: {websiteAlertsError()}</p></Show>

    <div class="website-connections__list" aria-label="Connected website alert feeds">
      <Show when={websiteConnections().length} fallback={<p class="website-connections__empty">No alert feeds connected. Add a website below to start checking for new alerts.</p>}>
        <For each={websiteConnections()}>{connection => {
          const site = () => websiteAlertSites().find(item => item.connection.id === connection.id)
          const feedStatus = () => site()?.error
            ? `Needs attention · ${site()?.error}`
            : site()
              ? `Feed responding · ${site()?.events.length ?? 0} recent alerts`
              : websiteAlertsLastChecked()
                ? 'Waiting for this feed to respond'
                : 'Waiting for first check'
          return <article class="website-connection">
            <div class="website-connection__identity">
              <span class="website-connection__icon"><ShieldCheck size={15} /></span>
              <span>
                <strong>{connection.displayName}</strong>
                <small classList={{ 'website-connection__status--error': !!site()?.error }}>{feedStatus()}</small>
                <small class="website-connection__url">{connection.serverUrl}</small>
              </span>
            </div>
            <div class="website-connection__actions">
              <Show when={connection.adapter === 'erp'}><button type="button" class="text-button" onClick={() => openErpSettings(connection.serverUrl)}><ExternalLink size={12} />Feed settings</button></Show>
              <button type="button" class="text-button website-connection__remove" disabled={websiteAlertsBusy()} aria-label={`Remove ${connection.displayName}`} onClick={() => void remove(connection.id)}><Trash2 size={13} />Remove</button>
            </div>
          </article>
        }}</For>
      </Show>
    </div>

    <Show when={websiteConnections().length < 12}>
      <form class="website-connections__form" onSubmit={submit}>
        <h3><Plus size={15} />Add a website feed</h3>
        <label>Website name<input required maxlength="80" autocomplete="organization" placeholder="My website" value={name()} onInput={event => setName(event.currentTarget.value)} /></label>
        <label>Website address<input type="url" required autocomplete="url" placeholder="https://example.com" value={serverUrl()} onInput={event => setServerUrl(event.currentTarget.value)} /></label>
        <details class="website-connections__advanced">
          <summary>Advanced feed settings</summary>
          <div>
            <label>Alert feed path <span class="website-connections__optional">optional when the site publishes discovery metadata</span><input autocomplete="off" placeholder="Found automatically, or enter /api/alerts" value={feedPath()} onInput={event => setFeedPath(event.currentTarget.value)} /></label>
            <label>Bearer key <span class="website-connections__optional">optional</span><input type="password" autocomplete="off" maxlength="8192" value={authToken()} onInput={event => setAuthToken(event.currentTarget.value)} /></label>
          </div>
        </details>
        <p class="website-connections__hint"><ShieldCheck size={13} />Pairing validates the feed before saving it. Keys stay encrypted on this PC. Remote feeds must use HTTPS; only the feed URL on this site is contacted, without browser cookies or sign-in sessions.</p>
        <Show when={formError()}><p class="website-connections__error" role="alert">{formError()}</p></Show>
        <button class="button" type="submit" disabled={websiteAlertsBusy()}><Link2 size={14} />{websiteAlertsBusy() ? 'Checking website…' : 'Validate and connect'}</button>
      </form>
    </Show>
  </section>
}
