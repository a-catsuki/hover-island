import { createSignal, For, onMount, Show } from 'solid-js'
import { ExternalLink, Link2, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-solid'
import { addWebsiteConnection, refreshWebsiteAlerts, refreshWebsiteConnections, removeWebsiteConnection, websiteAlertSites, websiteAlertsBusy, websiteAlertsError, websiteConnections } from '../../state/erp'
import { cmd } from '../../lib/ipc'
import './WebsiteConnectionsPanel.css'

export default function WebsiteConnectionsPanel() {
  const [type, setType] = createSignal<'erp' | 'website'>('website')
  const [name, setName] = createSignal('')
  const [serverUrl, setServerUrl] = createSignal('')
  const [feedPath, setFeedPath] = createSignal('')
  const [authToken, setAuthToken] = createSignal('')
  const [formError, setFormError] = createSignal('')
  onMount(() => { void refreshWebsiteConnections() })
  const submit = async (event: SubmitEvent) => {
    event.preventDefault(); setFormError('')
    try {
      await addWebsiteConnection({ serverUrl: serverUrl().trim(), displayName: name().trim(), adapter: type(), feedPath: feedPath().trim() || undefined, authToken: authToken().trim() || undefined })
      setName(''); setServerUrl(''); setFeedPath(''); setAuthToken('')
    } catch (error) { setFormError(String(error)) }
  }
  const remove = async (id: string) => { try { await removeWebsiteConnection(id) } catch { /* Persistent connector status displays the failure. */ } }
  const openErpSettings = (url: string) => {
    try { const target = new URL('/settings/notifications', url); void cmd.appsOpenUrl(target.toString()) } catch { /* Invalid addresses are rejected by native pairing. */ }
  }

  return <section class="website-connections" aria-labelledby="website-connections-title">
    <header class="website-connections__header"><div><h2 id="website-connections-title">Website alerts</h2><p>Pair a website that provides a read-only alert feed. Pairing opts that feed into alerts here; island notifications follow your notification and Do Not Disturb settings.</p></div><span class="website-connections__capacity">{websiteConnections().length}/12</span></header>
    <Show when={websiteAlertsError()}><p class="website-connections__error" role="alert">{websiteAlertsError()}</p></Show>
    <Show when={websiteConnections().length > 0}><button type="button" class="website-connections__text-link" disabled={websiteAlertsBusy()} onClick={() => void refreshWebsiteAlerts()}><RefreshCw size={12}/>{websiteAlertsBusy() ? 'Checking feeds…' : 'Check feeds now'}</button></Show>
    <div class="website-connections__list" aria-label="Connected websites">
      <Show when={websiteConnections().length} fallback={<p class="website-connections__empty">No websites connected yet.</p>}>
        <For each={websiteConnections()}>{connection => {
          const site = () => websiteAlertSites().find(item => item.connection.id === connection.id)
          const status = () => site()?.error ? `Needs attention · ${site()?.error}` : site() ? `${connection.adapter === 'erp' ? 'ERP alert feed' : 'Website alert feed'} · Feed available` : `${connection.adapter === 'erp' ? 'ERP alert feed' : 'Website alert feed'} · Waiting for first check`
          return <article class="website-connection">
          <div class="website-connection__identity"><span class="website-connection__icon"><ShieldCheck size={15}/></span><span><strong>{connection.displayName}</strong><small classList={{'website-connection__status--error': !!site()?.error}}>{status()}</small><small class="website-connection__url">{connection.serverUrl}</small></span></div>
          <div class="website-connection__actions"><Show when={connection.adapter === 'erp'}><button type="button" class="text-button" onClick={() => openErpSettings(connection.serverUrl)}><ExternalLink size={12}/>ERP settings</button></Show><button type="button" class="text-button website-connection__remove" disabled={websiteAlertsBusy()} aria-label={`Remove ${connection.displayName}`} onClick={() => void remove(connection.id)}><Trash2 size={13}/>Remove</button></div>
        </article>
        }}</For>
      </Show>
    </div>
    <Show when={websiteConnections().length < 12}>
      <form class="website-connections__form" onSubmit={submit}>
        <h3><Plus size={15}/>Add a website</h3>
        <label>Connection type<select value={type()} onChange={event => setType(event.currentTarget.value as 'erp' | 'website')}><option value="erp">Store Inventory ERP</option><option value="website">Website with an alert feed</option></select></label>
        <label>Display name<input required maxlength="80" autocomplete="organization" placeholder={type() === 'erp' ? 'Store Inventory ERP' : 'My website'} value={name()} onInput={event => setName(event.currentTarget.value)}/></label>
        <label>Website address<input type="url" required autocomplete="url" placeholder="https://example.com" value={serverUrl()} onInput={event => setServerUrl(event.currentTarget.value)}/></label>
        <Show when={type() === 'erp'}>
          <label>ERP connection key<input type="password" required autocomplete="off" maxlength="256" value={authToken()} onInput={event => setAuthToken(event.currentTarget.value)}/></label>
          <p class="website-connections__hint"><ShieldCheck size={13}/>Create a device key in ERP Settings, then paste it here. Hover Island validates it with the alert feed and stores it encrypted on this PC.</p>
        </Show>
        <Show when={type() === 'website'}>
          <label>Alert feed path <span class="website-connections__optional">optional if discovery is enabled</span><input autocomplete="off" placeholder="/api/hover-island/events" value={feedPath()} onInput={event => setFeedPath(event.currentTarget.value)}/></label>
          <label>Bearer key <span class="website-connections__optional">optional</span><input type="password" autocomplete="off" maxlength="8192" value={authToken()} onInput={event => setAuthToken(event.currentTarget.value)}/></label>
          <p class="website-connections__hint"><ShieldCheck size={13}/>Pairing checks the feed and opts it into local website alerts. Island notifications respect your notification and Do Not Disturb settings. Only a same-origin HTTPS feed is contacted; no cookies, browser sessions, or service workers are used.</p>
        </Show>
        <Show when={formError()}><p class="website-connections__error" role="alert">{formError()}</p></Show>
        <button class="button" type="submit" disabled={websiteAlertsBusy()}><Link2 size={14}/>{websiteAlertsBusy() ? 'Checking website…' : 'Validate and connect'}</button>
      </form>
    </Show>
    <Show when={type() === 'erp' && serverUrl().trim()}><button class="website-connections__text-link" type="button" onClick={() => openErpSettings(serverUrl().trim())}>Open ERP notification settings <ExternalLink size={12}/></button></Show>
    <p class="website-connections__security">Remote websites must use HTTPS. HTTP is allowed only for localhost development. Removing a connection deletes its local key; revoke ERP keys separately in ERP Settings.</p>
  </section>
}
