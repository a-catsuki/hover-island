import { createMemo, createSignal } from 'solid-js'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { cmd, onUsageChanged, type DetectedProvider, type UsageSnapshot } from '../lib/ipc'
import { subscribeAiActivity } from './aiActivity'
import { patchSettings, settings } from './settings'

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
  const stopActivity = await subscribeAiActivity().catch(() => () => {})
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
    stopActivity()
    started = false
  }
}

/* --------------------------------------------------------- provider detection */

/** Display preference for a detected provider without a native settings switch. Shown unless hidden. */
export function providerEnabled(id: string): boolean {
  return !(settings.usage.hidden ?? []).includes(id)
}

/** Whether a provider is shown in the AI widgets: native switches first, then the local preference. */
export function providerShown(id: string): boolean {
  const flags = settings.usage
  if (id === 'codex') return flags.codex
  if (id === 'claude-code') return flags.claudeCode
  if (id === 'cursor') return flags.cursor
  return providerEnabled(id)
}

export function setProviderEnabled(id: string, enabled: boolean): void {
  const hidden = (settings.usage.hidden ?? []).filter((item) => item !== id)
  patchSettings({ usage: { ...settings.usage, hidden: enabled ? hidden : [...hidden, id] } })
}

/** Usage snapshots for tools that are switched on. Everything that shows usage reads this. */
export const visibleUsage = createMemo(() => usage().filter((snapshot) => snapshot.provider === 'manual' || providerShown(snapshot.provider)))

/** Scan known local locations for installed AI tools. Never throws; errors surface in `detectError`. */
export function refreshDetected(): Promise<void> {
  if (detectInFlight) return detectInFlight
  setDetecting(true)
  setDetectError(null)
  detectInFlight = cmd.usageDetect()
    .then((providers) => { setDetected(Array.isArray(providers) ? providers : []) })
    .catch(() => { setDetected([]); setDetectError('Could not scan for active AI tools on this PC.') })
    .finally(() => {
      setDetecting(false)
      detectInFlight = null
    })
  return detectInFlight
}

export { usage, detected, detecting, detectError }
