import { createEffect, createSignal, For, Show } from 'solid-js'
import { ArrowLeft, ArrowRight, ExternalLink, RefreshCw, Settings2, ShieldCheck } from 'lucide-solid'
import { websiteAlertSites, websiteAlertsBusy, websiteAlertsError, refreshWebsiteAlerts } from '../../state/erp'
import { cmd } from '../../lib/ipc'
import { safeWebsiteAlertUrl } from '../../lib/erpAlerts'
import type { WebsiteAlert, WebsiteConnectionSite } from '../../lib/erpIpc'
import './ErpView.css'

const priorityLabel = (priority?: string | null) => {
  const value = (priority ?? 'normal').toLowerCase()
  return value === 'urgent' || value === 'critical' ? 'Urgent' : value === 'high' ? 'High' : value === 'low' ? 'Low' : 'Normal'
}

export interface WebsiteAlertsViewProps { onOpenConnections?: () => void }

export function WebsiteAlertsView(props: WebsiteAlertsViewProps) {
  const [selectedSiteId, setSelectedSiteId] = createSignal('all')
  const [page, setPage] = createSignal(0)
  const allSites = () => websiteAlertSites()
  const selectedSites = () => selectedSiteId() === 'all' ? allSites() : allSites().filter(site => site.connection.id === selectedSiteId())
  const allAlerts = () => selectedSites().flatMap(site => site.events.map(alert => ({ alert, site }))).sort((a, b) => {
    const rank = (priority?: string | null) => priority?.toLowerCase() === 'urgent' || priority?.toLowerCase() === 'critical' ? 3 : priority?.toLowerCase() === 'high' ? 2 : priority?.toLowerCase() === 'low' ? 0 : 1
    return rank(b.alert.priority) - rank(a.alert.priority) || b.alert.timestamp - a.alert.timestamp
  })
  const pageCount = () => Math.ceil(allAlerts().length / 2)
  const pageAlerts = () => allAlerts().slice(page() * 2, page() * 2 + 2)
  const selectSite = (value: string) => { setSelectedSiteId(value); setPage(0) }
  const hasSiteErrors = () => allSites().filter(site => site.error).length
  createEffect(() => {
    const count = pageCount()
    if (page() >= count) setPage(Math.max(0, count - 1))
    if (selectedSiteId() !== 'all' && !allSites().some(site => site.connection.id === selectedSiteId())) selectSite('all')
  })
  const openConnections = () => {
    if (props.onOpenConnections) { props.onOpenConnections(); return }
    void cmd.openSettingsWindow()
  }
  const openAlert = (alert: WebsiteAlert, site: WebsiteConnectionSite) => {
    const href = safeWebsiteAlertUrl(alert.url, site.connection.serverUrl)
    if (href) void cmd.appsOpenUrl(href)
  }

  return <section class="erp-view" aria-label="Website alerts">
    <header class="widget__head erp-view__head">
      <span class="widget__title"><ShieldCheck size={15}/>Website alerts</span>
      <span class="erp-view__actions">
        <button class="text-button" aria-label="Refresh website alerts" title="Refresh alerts" disabled={websiteAlertsBusy()} onClick={() => void refreshWebsiteAlerts()}><RefreshCw size={13}/></button>
        <button class="text-button" aria-label="Manage website connections" title="Manage connections" onClick={openConnections}><Settings2 size={13}/></button>
      </span>
    </header>
    <Show when={websiteAlertsError()}><p class="erp-view__error" role="status">{websiteAlertsError()}</p></Show>
    <Show when={allSites().length > 0} fallback={<div class="erp-view__empty-state"><p>No websites connected.</p><button type="button" class="button" onClick={openConnections}>Choose websites <Settings2 size={13}/></button></div>}>
      <div class="erp-view__controls">
        <label class="erp-view__filter"><span>Website</span><select aria-label="Filter alerts by website" value={selectedSiteId()} onChange={event => selectSite(event.currentTarget.value)}><option value="all">All websites</option><For each={allSites()}>{site => <option value={site.connection.id}>{site.connection.displayName}</option>}</For></select></label>
        <span class="erp-view__summary" title={allSites().filter(site => site.error).map(site => `${site.connection.displayName}: ${site.error}`).join('\n')}>{allSites().length} connected<Show when={hasSiteErrors()}><span> · {hasSiteErrors()} issue{hasSiteErrors() === 1 ? '' : 's'}</span></Show></span>
      </div>
      <Show when={hasSiteErrors()}><p class="erp-view__site-error" role="status">{hasSiteErrors()} website{hasSiteErrors() === 1 ? '' : 's'} need attention. See connection details in Settings.</p></Show>
      <Show when={allAlerts().length} fallback={<p class="erp-view__empty">No current website alerts.</p>}>
        <div class="erp-view__alerts" aria-label="Website alerts">
          <For each={pageAlerts()}>{item => <article class={'erp-alert erp-alert--' + priorityLabel(item.alert.priority).toLowerCase()}>
            <div class="erp-alert__top"><strong>{item.alert.title}</strong><span>{priorityLabel(item.alert.priority)}</span></div>
            <small class="erp-alert__app">{item.alert.app || item.site.connection.displayName} · {item.site.connection.displayName}</small>
            <p>{item.alert.body}</p>
            <div class="erp-alert__bottom"><time>{new Date(item.alert.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time><Show when={safeWebsiteAlertUrl(item.alert.url, item.site.connection.serverUrl)}><button type="button" class="text-button" onClick={() => openAlert(item.alert, item.site)}>Open website <ExternalLink size={11}/></button></Show></div>
          </article>}</For>
        </div>
      </Show>
      <footer class="erp-view__pager"><button type="button" class="text-button" disabled={page() === 0} onClick={() => setPage(value => Math.max(0, value - 1))}><ArrowLeft size={12}/>Previous</button><span>{pageCount() ? `${page() + 1} of ${pageCount()}` : '0 alerts'}</span><button type="button" class="text-button" disabled={page() + 1 >= pageCount()} onClick={() => setPage(value => Math.min(pageCount() - 1, value + 1))}>Next<ArrowRight size={12}/></button></footer>
    </Show>
  </section>
}

export default WebsiteAlertsView
