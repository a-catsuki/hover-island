import { createSignal } from 'solid-js'
import { cmd, type ResetWatchSnapshot } from '../lib/ipc'
import { settings } from './settings'
import { ingestNotifications } from './peek'

const KEY = 'hover-island.reset-watch.seen'
const [resetSnapshot, setResetSnapshot] = createSignal<ResetWatchSnapshot | null>(null)
const [resetPending, setResetPending] = createSignal(false)
const [resetError, setResetError] = createSignal('')
let inFlight: Promise<void> | undefined
let initialized = false
const seen = new Set<string>()
try { const ids: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null'); if (Array.isArray(ids)) { ids.filter(id => typeof id === 'string').slice(-128).forEach(id => seen.add(id)); initialized = true } } catch {}
export function refreshResetWatch(force=false): Promise<void> {
  if (inFlight) return inFlight
  setResetPending(true)
  inFlight = cmd.resetWatch(force).then(snapshot => {
    setResetSnapshot(snapshot); setResetError('')
    const newEvents = snapshot.events.filter(event => !seen.has(event.id))
    if (initialized && !snapshot.stale) for (const event of newEvents.slice(0, 3)) ingestNotifications([{
      id: 'reset-watch:' + event.id, app: 'Codex Reset Watch',
      title: event.kind === 'banked' ? 'Banked Codex grant announced' : event.upcoming ? 'Upcoming Codex reset announced' : 'Global Codex reset announced',
      body: event.title, timestamp: Date.now(),
    }])
    snapshot.events.forEach(event => seen.add(event.id))
    while (seen.size > 128) seen.delete(seen.values().next().value!)
    try { localStorage.setItem(KEY, JSON.stringify([...seen])) } catch {}
    initialized = true
  }).catch(error => { setResetError(String(error)) }).finally(() => { setResetPending(false); inFlight = undefined })
  return inFlight
}
export async function subscribeResetWatch(): Promise<() => void> {
  const tick = () => { if (settings.modules.usage && settings.usage.codex) void refreshResetWatch() }
  tick()
  const timer = setInterval(tick, 15 * 60000)
  return () => clearInterval(timer)
}
export { resetSnapshot, resetPending, resetError }
