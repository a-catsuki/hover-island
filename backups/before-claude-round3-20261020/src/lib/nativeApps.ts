import type { AppConnection } from './ipc'
import { matchingConnection, sourceMatches } from './connectionSources'

/**
 * Native Windows apps Hover Island can show alerts from. Windows hands every
 * notification to the island by default, so "connecting" an app saves a named
 * rule for it: it is listed in Settings, its alerts are on, and you can turn it
 * off any time. The rule is a normal entry in `settings.connections` (id starts
 * with "native:", no url), the same shape the per-app mute list already uses.
 */
export interface NativeAppEntry {
  id: string
  name: string
  /** What Windows calls the app in its toasts. The first one is the display name. */
  sources: string[]
  hint: string
  group: 'chat' | 'mail' | 'phone' | 'ai'
}

export const NATIVE_GROUPS: readonly { id: NativeAppEntry['group']; label: string }[] = [
  { id: 'chat', label: 'Chat and meetings' },
  { id: 'mail', label: 'Mail and calendar' },
  { id: 'phone', label: 'Phone' },
  { id: 'ai', label: 'AI and terminals' },
]

export const NATIVE_APPS: readonly NativeAppEntry[] = [
  { id: 'native:discord', name: 'Discord', sources: ['Discord'], hint: 'Messages and mentions', group: 'chat' },
  { id: 'native:slack', name: 'Slack', sources: ['Slack'], hint: 'Direct messages and mentions', group: 'chat' },
  { id: 'native:teams', name: 'Microsoft Teams', sources: ['Microsoft Teams', 'Teams'], hint: 'Chats, calls and meeting reminders', group: 'chat' },
  { id: 'native:whatsapp', name: 'WhatsApp', sources: ['WhatsApp', 'WhatsApp Desktop'], hint: 'Messages from the desktop app', group: 'chat' },
  { id: 'native:telegram', name: 'Telegram', sources: ['Telegram', 'Telegram Desktop'], hint: 'Messages from the desktop app', group: 'chat' },
  { id: 'native:zoom', name: 'Zoom', sources: ['Zoom'], hint: 'Meeting and chat alerts', group: 'chat' },
  { id: 'native:outlook', name: 'Outlook', sources: ['Outlook', 'Microsoft Outlook'], hint: 'New mail and calendar reminders', group: 'mail' },
  { id: 'native:mail', name: 'Mail', sources: ['Mail', 'Mail and Calendar'], hint: 'The Windows Mail app', group: 'mail' },
  { id: 'native:calendar', name: 'Calendar', sources: ['Calendar'], hint: 'Windows Calendar reminders', group: 'mail' },
  { id: 'native:thunderbird', name: 'Thunderbird', sources: ['Thunderbird'], hint: 'New mail', group: 'mail' },
  { id: 'native:phonelink', name: 'Phone Link', sources: ['Phone Link', 'Your Phone'], hint: 'Calls, texts and app alerts from your phone', group: 'phone' },
  { id: 'native:claude', name: 'Claude', sources: ['Claude'], hint: 'The Claude desktop app', group: 'ai' },
  { id: 'native:chatgpt', name: 'ChatGPT', sources: ['ChatGPT'], hint: 'The ChatGPT desktop app', group: 'ai' },
  { id: 'native:terminal', name: 'Windows Terminal', sources: ['Windows Terminal'], hint: 'Terminal alerts, including AI command line tools', group: 'ai' },
]

export type NativeAppState = 'default' | 'connected' | 'muted'

/** Slug used to make stable ids for apps picked from the installed list. */
export function appSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'app'
}

/** The saved rule a catalog entry owns, if any: exact id first, then any rule that names one of its sources. */
export function connectionForEntry(entry: Pick<NativeAppEntry, 'id' | 'sources'>, connections: AppConnection[]): AppConnection | undefined {
  return connections.find(connection => connection.id === entry.id && !connection.url)
    ?? connections.find(connection => !connection.url && sourceMatches(connection.name, entry.sources))
    ?? entry.sources.map(source => matchingConnection(source, connections.filter(connection => !connection.url))).find(Boolean)
}

/**
 * default: no rule, so alerts still pass (Windows decides).
 * connected: a rule exists and alerts are on.
 * muted: a rule exists and alerts are off.
 */
export function nativeAppState(entry: Pick<NativeAppEntry, 'id' | 'sources'>, connections: AppConnection[]): NativeAppState {
  const rule = connectionForEntry(entry, connections)
  if (!rule) return 'default'
  return rule.notifications ? 'connected' : 'muted'
}

export function connectionFromEntry(entry: NativeAppEntry): AppConnection {
  return { id: entry.id, name: entry.name, url: '', notifications: true, notificationSources: [...entry.sources] }
}

/** Rule for an app picked from the installed list. Reuses the same id when the same app is picked again. */
export function connectionFromInstalled(app: { name: string; icon?: string | null }): AppConnection {
  const name = app.name.trim()
  return { id: `native:app-${appSlug(name)}`, name, url: '', icon: app.icon ?? null, notifications: true, notificationSources: [name] }
}

/** Rules that belong on the native apps list: saved by name, not website shortcuts. */
export function nativeRules(connections: AppConnection[]): AppConnection[] {
  return connections.filter(connection => !connection.url)
}

/** True when an installed app is already covered by a saved rule or a catalog entry the user connected. */
export function installedAppCovered(name: string, connections: AppConnection[]): boolean {
  return nativeRules(connections).some(connection => [connection.name, ...(connection.notificationSources ?? [])].some(source => source.trim().toLowerCase() === name.trim().toLowerCase()))
}
