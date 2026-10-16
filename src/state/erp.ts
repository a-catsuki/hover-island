import { createSignal } from 'solid-js'
import { websiteAlertsIpc, type WebsiteAlert, type WebsiteConnection, type WebsiteConnectionSite } from '../lib/erpIpc'
import { alertUpdateKey, alertVersion, sortWebsiteAlerts } from '../lib/erpAlerts'

const POLL_MS = 45_000
export type WebsiteAlertCategory = 'erp' | 'website'
export type WebsiteAlertListener = (alert: WebsiteAlert, connection: WebsiteConnection, updateKey: string, category: WebsiteAlertCategory) => void

const [websiteConnections, setWebsiteConnections] = createSignal<WebsiteConnection[]>([])
const [websiteAlertSites, setWebsiteAlertSites] = createSignal<WebsiteConnectionSite[]>([])
const [websiteAlertsBusy, setWebsiteAlertsBusy] = createSignal(false)
const [websiteAlertsError, setWebsiteAlertsError] = createSignal('')
const [websiteAlertsLastChecked, setWebsiteAlertsLastChecked] = createSignal<number>()
const listeners = new Set<WebsiteAlertListener>()
const knownVersions = new Map<string, string>()
const baselinedConnections = new Set<string>()
let pollTimer: ReturnType<typeof setInterval> | undefined
let refreshInFlight: Promise<void> | undefined
let generation = 0

export function subscribeWebsiteAlerts(listener: WebsiteAlertListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Kept as an ERP-named integration point for the existing notification shell.
// Its callback receives ERP events only; generic sites use subscribeWebsiteAlerts.
export function subscribeErp(listener: (alert: WebsiteAlert, connection: WebsiteConnection, updateKey: string) => void): () => void {
  return subscribeWebsiteAlerts((alert, connection, updateKey, category) => { if (category === 'erp') listener(alert, connection, updateKey) })
}

export async function refreshWebsiteConnections(): Promise<void> {
  const currentGeneration = generation
  try {
    const list = await websiteAlertsIpc.connectionsGet()
    if (currentGeneration !== generation) return
    const currentIds = new Set(list.map(item => item.id))
    for (const id of knownVersions.keys()) if (!Array.from(currentIds).some(connectionId => id.startsWith(`${connectionId}:`))) knownVersions.delete(id)
    for (const id of baselinedConnections) if (!currentIds.has(id)) baselinedConnections.delete(id)
    setWebsiteConnections(list)
    setWebsiteAlertSites(sites => sites.filter(site => currentIds.has(site.connection.id)))
    setWebsiteAlertsError('')
  } catch (error) { setWebsiteAlertsError(String(error)) }
}

export async function refreshWebsiteAlerts(announce = true): Promise<void> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    const currentGeneration = generation
    setWebsiteAlertsBusy(true)
    try {
      const result = await websiteAlertsIpc.alertsGet()
      if (currentGeneration !== generation) return
      const normalizedSites = result.sites.map(site => ({ ...site, events: sortWebsiteAlerts(site.events) }))
      for (const site of normalizedSites) {
        const id = site.connection.id
        const alreadyBaselined = baselinedConnections.has(id)
        for (const alert of site.events) {
          const key = `${id}:${alert.id}`
          const version = alertVersion(alert)
          const previous = knownVersions.get(key)
          if (alreadyBaselined && announce && previous !== undefined && previous !== version) {
            const updateKey = alertUpdateKey(site.connection, alert)
            const category = site.connection.adapter === 'erp' ? 'erp' : 'website'
            for (const listener of listeners) {
              try { listener(alert, site.connection, updateKey, category) } catch { /* A notification consumer must not stop polling. */ }
            }
          } else if (alreadyBaselined && announce && previous === undefined) {
            const updateKey = alertUpdateKey(site.connection, alert)
            const category = site.connection.adapter === 'erp' ? 'erp' : 'website'
            for (const listener of listeners) {
              try { listener(alert, site.connection, updateKey, category) } catch { /* A notification consumer must not stop polling. */ }
            }
          }
          knownVersions.set(key, version)
        }
        while (knownVersions.size > 2000) {
          const oldest = knownVersions.keys().next().value
          if (oldest === undefined) break
          knownVersions.delete(oldest)
        }
        if (site.baselineComplete) baselinedConnections.add(id)
      }
      setWebsiteConnections(result.connections)
      setWebsiteAlertSites(normalizedSites)
      setWebsiteAlertsLastChecked(Date.now())
      setWebsiteAlertsError('')
    } catch (error) { if (currentGeneration === generation) setWebsiteAlertsError(String(error)) }
    finally { setWebsiteAlertsBusy(false) }
  })().finally(() => { refreshInFlight = undefined })
  return refreshInFlight
}

async function refreshAfterPending(announce: boolean): Promise<void> {
  // A generation change makes an in-flight response stale. Wait for its finally
  // handler to release the shared slot, then issue a fresh poll in this generation.
  while (refreshInFlight) {
    const pending = refreshInFlight
    await pending
    if (refreshInFlight === pending) await Promise.resolve()
  }
  await refreshWebsiteAlerts(announce)
}

export async function addWebsiteConnection(input: { serverUrl: string; displayName: string; adapter: 'erp' | 'website'; feedPath?: string; authToken?: string }): Promise<void> {
  setWebsiteAlertsBusy(true)
  setWebsiteAlertsError('')
  try {
    await websiteAlertsIpc.add(input.serverUrl, input.displayName, input.adapter, input.feedPath, input.authToken)
    generation++
    await refreshWebsiteConnections()
    await refreshAfterPending(false)
  } catch (error) { setWebsiteAlertsError(String(error)); throw error }
  finally { setWebsiteAlertsBusy(false) }
}

export async function removeWebsiteConnection(id: string): Promise<void> {
  setWebsiteAlertsBusy(true)
  setWebsiteAlertsError('')
  try {
    const list = await websiteAlertsIpc.remove(id)
    generation++
    for (const key of knownVersions.keys()) if (key.startsWith(`${id}:`)) knownVersions.delete(key)
    baselinedConnections.delete(id)
    setWebsiteConnections(list)
    setWebsiteAlertSites(sites => sites.filter(site => site.connection.id !== id))
    await refreshAfterPending(false)
  } catch (error) { setWebsiteAlertsError(String(error)); throw error }
  finally { setWebsiteAlertsBusy(false) }
}

export function startWebsiteAlertsPolling(): () => void {
  if (pollTimer) return () => {}
  void refreshWebsiteConnections().then(() => refreshWebsiteAlerts(false))
  pollTimer = setInterval(() => { void refreshWebsiteConnections().then(() => refreshWebsiteAlerts()) }, POLL_MS)
  return () => { if (pollTimer) clearInterval(pollTimer); pollTimer = undefined }
}

export const refreshErpConnection = refreshWebsiteConnections
export const refreshErpAlerts = refreshWebsiteAlerts
export const erpAlerts = () => websiteAlertSites().filter(site => site.connection.adapter === 'erp').flatMap(site => site.events.map(event => ({ ...event, app: event.app ?? site.connection.displayName, connectionId: site.connection.id, serverUrl: site.connection.serverUrl })))
export const erpBusy = websiteAlertsBusy
export const erpError = websiteAlertsError
export { websiteConnections, websiteAlertSites, websiteAlertsBusy, websiteAlertsError, websiteAlertsLastChecked }
