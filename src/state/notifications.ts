import { createMemo, createSignal } from 'solid-js'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { cmd, listen, onNotificationsChanged, type AppNotification } from '../lib/ipc'
import { reportError } from './feedback'
import { flushSettings, patchSettings, settings } from './settings'
import { ingestPopupNotification, primeNotificationBaseline } from './peek'

const [notifications, setNotifications] = createSignal<AppNotification[]>([])
const [notificationError, setNotificationError] = createSignal('')
const unreadCount = createMemo(() => notifications().length)

let unlisten: UnlistenFn | null = null
let unlistenErrors: UnlistenFn | null = null
let unlistenPopup: UnlistenFn | null = null
let started = false

/** Request the native Windows grant and persist the switches needed to start polling. */
export async function requestNotificationAccess(): Promise<boolean> {
  const state = await cmd.notificationsAccessStatus()
  // Windows never prompts again after Denied; the user must change that grant
  // in Windows Settings. Do not present an ineffective permission retry.
  const allowed = state.status === 'allowed' || (state.status !== 'denied' && await cmd.notificationsAccess())
  if (allowed) {
    patchSettings({
      modules: { ...settings.modules, notifications: true },
      notifications: { ...settings.notifications, enabled: true, systemListener: true },
    })
    await flushSettings()
    setNotificationError('')
  }
  return allowed
}

export async function subscribeNotifications(): Promise<() => void> {
  if (started) return () => {}
  started = true

  let receivedEvent = false
  try {
    unlisten = await onNotificationsChanged((items) => { receivedEvent = true; setNotifications(items) })
    unlistenErrors = await listen<string>('notifications://error', event => setNotificationError(event.payload))
    unlistenPopup = await listen<AppNotification>('notifications://popup', event => ingestPopupNotification(event.payload))
    const initial = await cmd.notificationsGet()
    if (!receivedEvent) { primeNotificationBaseline(initial); setNotifications(initial) }
  } catch (error) {
    setNotificationError(`Could not connect to Windows alerts: ${String(error)}`)
    reportError('Could not connect to alerts', error)
  }

  return () => {
    unlisten?.()
    unlisten = null
    unlistenErrors?.()
    unlistenErrors = null
    unlistenPopup?.()
    unlistenPopup = null
    started = false
  }
}

/** Best-effort: bring the app behind a notification forward by launching its Start entry. */
export async function openNotificationSource(app: string): Promise<void> {
  const name = app.trim().toLowerCase()
  if (!name) return
  try {
    const results = await cmd.spotlightSearch(app)
    const apps = results.filter(result => result.kind === 'app')
    const hit = apps.find(result => result.title.trim().toLowerCase() === name) ?? apps.find(result => result.title.trim().toLowerCase().startsWith(name))
    if (hit) await cmd.appsLaunch(hit.target)
  } catch { /* opening the source app is a convenience only */ }
}

export function dismissNotification(id: string): void {
  const previous = notifications()
  setNotifications(previous.filter(item => item.id !== id))
  void cmd.notificationsDismiss(id).catch(error => { setNotifications(previous); reportError('Could not dismiss notification', error) })
}

export function clearNotifications(): void {
  const previous = notifications()
  setNotifications([])
  void cmd.notificationsClear().catch(error => { setNotifications(previous); reportError('Could not clear notifications', error) })
}

export { notifications, unreadCount, notificationError }
