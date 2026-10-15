import { invoke, isTauri } from '@tauri-apps/api/core'

export interface WebsiteConnection {
  id: string
  displayName: string
  serverUrl: string
  adapter: 'erp' | 'website'
  pairedAt: string
}

export interface WebsiteAlert {
  id: string
  app?: string | null
  title: string
  body: string
  priority?: 'urgent' | 'high' | 'normal' | 'low' | string | null
  timestamp: number
  url?: string | null
}

export interface WebsiteConnectionSite {
  connection: WebsiteConnection
  events: WebsiteAlert[]
  baselineComplete: boolean
  error?: string | null
}

export interface WebsiteAlertsSnapshot {
  connections: WebsiteConnection[]
  sites: WebsiteConnectionSite[]
}

const unavailable = (): never => { throw new Error('Website alert connections are available in the Windows desktop app.') }

export const websiteAlertsIpc = {
  connectionsGet: () => isTauri() ? invoke<WebsiteConnection[]>('website_connections_get') : Promise.resolve([]),
  add: (serverUrl: string, displayName: string, adapter: 'erp' | 'website', feedPath?: string, authToken?: string) => isTauri()
    ? invoke<WebsiteConnection>('website_connection_add', { serverUrl, displayName, adapter, feedPath: feedPath || null, authToken: authToken || null })
    : Promise.reject(unavailable()),
  remove: (id: string) => isTauri() ? invoke<WebsiteConnection[]>('website_connection_remove', { id }) : Promise.reject(unavailable()),
  alertsGet: () => isTauri() ? invoke<WebsiteAlertsSnapshot>('website_alerts_get') : Promise.resolve({ connections: [], sites: [] }),
}
