import { createSignal, onCleanup, onMount } from 'solid-js'
import { cmd } from '../lib/ipc'
import { flushSettings, patchSettings, settings } from '../state/settings'

export default function NotificationAccessPanel() {
  const [status, setStatus] = createSignal('Checking Windows permission…')
  const [allowed, setAllowed] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  let disposed = false
  let reading = false
  async function refresh() {
    if (reading || disposed) return
    reading = true
    try {
      const state = await cmd.notificationsAccessStatus()
      if (disposed) return
      setAllowed(state.status === 'allowed')
      setStatus(state.status === 'allowed' ? 'Windows permission granted' : state.status === 'denied' ? 'Access is off in Windows. Enable Hover Island in Notification access, then retry.' : state.status === 'unpackaged' ? 'Install the packaged build to receive Windows alerts.' : 'Windows permission has not been granted yet.')
    } catch { if (!disposed) setStatus('Could not check Windows permission. Try again.') }
    finally { reading = false }
  }
  onMount(() => { void refresh(); const timer = setInterval(refresh, 15000); window.addEventListener('focus', refresh); onCleanup(() => { disposed = true; clearInterval(timer); window.removeEventListener('focus', refresh) }) })
  async function allow() {
    setBusy(true)
    try {
      if (await cmd.notificationsAccess()) {
        patchSettings({ modules: { ...settings.modules, notifications: true }, notifications: { ...settings.notifications, enabled: true, systemListener: true } })
        await flushSettings()
      }
      await refresh()
    } catch (error) { setStatus(String(error)) }
    finally { setBusy(false) }
  }
  return <div class="notification-access"><div><strong>Windows notification access</strong><p role="status">{status()}</p><small>{allowed() ? 'Choose notification sources in Connections. Alerts arrive while those apps run in the background.' : 'Windows asks for this permission separately from the app’s own alert switch.'}</small></div><button class="button button--secondary" disabled={busy()} onClick={() => void (allowed() ? refresh() : allow())}>{busy() ? 'Waiting for Windows…' : allowed() ? 'Check access' : 'Allow Windows alerts'}</button></div>
}
