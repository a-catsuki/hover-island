import type { WebsiteAlert, WebsiteConnection } from './erpIpc'

export function alertVersion(alert: WebsiteAlert): string {
  return `${alert.timestamp}:${alert.title}:${alert.body}:${alert.priority ?? ''}:${alert.url ?? ''}`
}

export function alertUpdateKey(connection: WebsiteConnection, alert: WebsiteAlert): string {
  return `${connection.adapter}:${connection.id}:${alert.id}:${alertVersion(alert)}`
}

export function sortWebsiteAlerts(alerts: readonly WebsiteAlert[]): WebsiteAlert[] {
  return [...alerts].sort((a, b) => b.timestamp - a.timestamp)
}

export function safeWebsiteAlertUrl(alertUrl: string | null | undefined, serverUrl: string | null): string | null {
  if (!alertUrl || !serverUrl) return null
  try {
    const target = new URL(alertUrl, serverUrl)
    const server = new URL(serverUrl)
    const localHttp = server.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(server.hostname)
    if (target.origin !== server.origin || target.username || target.password) return null
    if (target.protocol !== 'https:' && !(localHttp && target.protocol === 'http:')) return null
    return target.toString()
  } catch { return null }
}

// Legacy names retained for callers that still refer to the ERP widget.
export const erpAlertVersion = alertVersion
export const erpAlertUpdateKey = (alert: WebsiteAlert) => `erp:${alert.id}:${alertVersion(alert)}`
export const sortErpAlerts = sortWebsiteAlerts
export const safeErpAlertUrl = safeWebsiteAlertUrl
