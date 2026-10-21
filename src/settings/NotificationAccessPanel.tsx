import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { Bell } from 'lucide-solid'
import { cmd } from '../lib/ipc'
import { settings } from '../state/settings'
import { requestNotificationAccess } from '../state/notifications'
import './NotificationsSettings.css'

type Access = 'checking' | 'allowed' | 'denied' | 'not-requested' | 'unpackaged' | 'error'

export default function NotificationAccessPanel() {
  const [access, setAccess] = createSignal<Access>('checking')
  const [busy, setBusy] = createSignal(false)
  const [message, setMessage] = createSignal('')
  const captureEnabled = () => settings.modules.notifications && settings.notifications.enabled && settings.notifications.systemListener
  let disposed = false
  let reading = false

  async function refresh() {
    if (reading || disposed) return
    reading = true
    try {
      const state = await cmd.notificationsAccessStatus()
      if (!disposed) setAccess(state.status)
    } catch { if (!disposed) setAccess('error') }
    finally { reading = false }
  }
  onMount(() => {
    void refresh()
    window.addEventListener('focus', refresh)
    onCleanup(() => { disposed = true; window.removeEventListener('focus', refresh) })
  })

  const openWindowsSettings = () => cmd.openWindowsSettings('notification-access').catch(error => setMessage(String(error)))
  async function act() {
    setBusy(true)
    setMessage('')
    try {
      if (access() === 'denied') await openWindowsSettings()
      else if (access() === 'error') await refresh()
      else await requestNotificationAccess()
      if (access() !== 'denied') await refresh()
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const allowed = () => access() === 'allowed'
  const label = () => allowed() ? 'Allowed' : access() === 'checking' ? 'Checking…' : access() === 'unpackaged' ? 'Not available' : access() === 'error' ? 'Could not check' : 'Not allowed'
  const detail = () => {
    switch (access()) {
      case 'allowed': return captureEnabled() ? 'Alerts from your apps appear in the notch.' : 'Allowed in Windows, but app alerts are turned off here.'
      case 'denied': return 'Turn on notification access for Hover Island in Windows settings.'
      case 'not-requested': return 'Allow Hover Island to read your Windows notifications.'
      case 'unpackaged': return 'Windows only shares notifications with the installed Hover Island app.'
      case 'error': return 'Windows did not answer. Try again.'
      default: return 'Asking Windows…'
    }
  }
  const primary = () => {
    if (allowed()) return captureEnabled() ? '' : 'Turn on'
    switch (access()) {
      case 'denied': return 'Open Windows settings'
      case 'not-requested': return 'Allow'
      case 'error': return 'Try again'
      default: return ''
    }
  }

  return <div class="nacc" role="group" aria-label="Windows notification access">
    <span class="nacc__icon" classList={{ 'nacc__icon--ok': allowed() }} aria-hidden="true"><Bell size={18} strokeWidth={1.75} /></span>
    <div class="nacc__copy">
      <strong class="nacc__state" role="status"><span class="nacc__dot" classList={{ 'nacc__dot--ok': allowed(), 'nacc__dot--off': !allowed() && access() !== 'checking' }} />{label()}</strong>
      <p>{message() || detail()}</p>
    </div>
    <Show when={primary()} fallback={<Show when={allowed()}><button type="button" class="text-button" onClick={() => void openWindowsSettings()}>Open Windows settings</button></Show>}>
      <button type="button" class="button" disabled={busy()} onClick={() => void act()}>{busy() ? 'Waiting…' : primary()}</button>
    </Show>
  </div>
}
