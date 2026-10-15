import { createSignal } from 'solid-js'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { cmd, onUsageChanged, type DetectedProvider, type UsageSnapshot } from '../lib/ipc'

const [usage, setUsage] = createSignal<UsageSnapshot[]>([])
const [detected, setDetected] = createSignal<DetectedProvider[]>([])
const [detecting, setDetecting] = createSignal(false)
const [detectError, setDetectError] = createSignal<string | null>(null)

let unlisten: UnlistenFn | null = null
let started = false
let refreshInFlight: Promise<void> | null = null
let detectInFlight: Promise<void> | null = null

export function refreshUsage(): Promise<void> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = cmd.usageRefresh().then((snapshots) => {
    setUsage(snapshots)
  }).finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

export async function subscribeUsage(): Promise<() => void> {
  if (started) return () => {}
  started = true

  let receivedEvent = false
  try {
    unlisten = await onUsageChanged((snapshots) => { receivedEvent = true; setUsage(snapshots) })
    const initial = await cmd.usageGet()
    if (!receivedEvent) setUsage(initial)
  } catch {
    unlisten = null
  }

  return () => {
    unlisten?.()
    unlisten = null
    started = false
  }
}

/* --------------------------------------------------------- provider detection */

const PROVIDER_PREFS_KEY = 'hover-island.providers.v1'

function loadProviderPrefs(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROVIDER_PREFS_KEY) ?? '{}') as unknown
    if (parsed && typeof parsed === 'object') return parsed as Record<string, boolean>
  } catch {}
  return {}
}

const [providerPrefs, setProviderPrefs] = createSignal<Record<string, boolean>>(loadProviderPrefs())

/** Display preference for a detected provider without a native settings switch. */
export function providerEnabled(id: string): boolean {
  return providerPrefs()[id] ?? false
}

export function setProviderEnabled(id: string, enabled: boolean): void {
  setProviderPrefs((current) => {
    const next = { ...current, [id]: enabled }
    try { localStorage.setItem(PROVIDER_PREFS_KEY, JSON.stringify(next)) } catch {}
    return next
  })
}

/** Scan known local locations for installed AI tools. Never throws; errors surface in `detectError`. */
export function refreshDetected(): Promise<void> {
  if (detectInFlight) return detectInFlight
  setDetecting(true)
  setDetectError(null)
  detectInFlight = cmd.usageDetect()
    .then((providers) => { setDetected(Array.isArray(providers) ? providers : []) })
    .catch(() => { setDetectError('Could not scan for AI tools on this PC.') })
    .finally(() => {
      setDetecting(false)
      detectInFlight = null
    })
  return detectInFlight
}

export { usage, detected, detecting, detectError }
