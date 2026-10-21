import { createSignal, onCleanup, onMount } from 'solid-js'
import { cmd } from '../lib/ipc'
import { settings } from '../state/settings'
import { requestNotificationAccess } from '../state/notifications'

export default function NotificationAccessPanel() {
  const [status, setStatus] = createSignal('Checking Windows permission…')
  const [allowed, setAllowed] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [access, setAccess] = createSignal('')
  const captureEnabled = () => settings.modules.notifications && settings.notifications.enabled && settings.notifications.systemListener
  let disposed = false
  let reading = false
  async function refresh() {
    if (reading || disposed) return
    reading = true
    try {
      const state = await cmd.notificationsAccessStatus()
      if (disposed) return
      setAllowed(state.status === 'allowed')
      setAccess(state.status)
      setStatus(state.status === 'allowed' ? 'Windows permission granted' : state.status === 'denied' ? 'Access is off in Windows. Open Notification access, enable Hover Island, then return here.' : state.status === 'unpackaged' ? 'Windows requires the MSIX build for notification access. Install Hover Island.msix from the Windows download.' : 'Windows permission has not been granted yet.')
    } catch { if (!disposed) setStatus('Could not check Windows permission. Try again.') }
    finally { reading = false }
  }
  onMount(() => { void refresh(); window.addEventListener('focus', refresh); onCleanup(() => { disposed = true; window.removeEventListener('focus', refresh) }) })
  async function allow() {
    setBusy(true)
    try {
      if (access() === 'denied') {
        await cmd.openWindowsSettings('notification-access')
        return
      }
      await requestNotificationAccess()
      await refresh()
    } catch (error) { setStatus(String(error)) }
    finally { setBusy(false) }
  }
  return <div class="notification-access"><div><strong>Windows notification access</strong><p role="status">{status()}{allowed() && !captureEnabled() ? ' · Notch capture is paused.' : ''}</p><small>{allowed() ? 'Choose notification sources in Connections. Alerts arrive while those apps run in the background.' : 'Windows asks for this permission separately from the app’s own alert switch.'}</small></div><button class="button button--secondary" disabled={busy() || access() === 'unpackaged'} onClick={() => void (allowed() && captureEnabled() ? refresh() : allow())}>{busy() ? 'Waiting for Windows…' : access() === 'unpackaged' ? 'MSIX build required' : access() === 'denied' ? 'Open notification access' : allowed() ? captureEnabled() ? 'Check access' : 'Enable notch alerts' : 'Allow Windows alerts'}</button>{access() !== 'denied' && <button class="text-button" onClick={() => void cmd.openWindowsSettings('notification-access').catch(error => setStatus(String(error)))}>Open Windows notification access</button>}</div>
}
