import { createSignal } from 'solid-js'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { cmd, onAiActivity, type AiActivityEvent, type AiActivityKind } from '../lib/ipc'
import { settings } from './settings'
import { showAiToast } from './peek'

/** A session the agent is working on right now, built from `ai://activity` events. */
export interface LiveSession {
  key: string
  provider: string
  title: string
  detail: string
  phase: 'working' | 'waiting'
  percent: number | null
  startedAt: number
  updatedAt: number
}

const KINDS: AiActivityKind[] = ['started', 'progress', 'question', 'completed', 'failed']
const STALE_MS = 20 * 60_000
const MAX_FEED = 30

const [live, setLive] = createSignal<LiveSession[]>([])
const [feed, setFeed] = createSignal<AiActivityEvent[]>([])
const lastToastPercent = new Map<string, number>()

/** Sessions that are working or waiting for you. Stale ones (no event for 20 minutes) are ignored. */
export function liveSessions(now = Date.now()): LiveSession[] {
  return live().filter((session) => now - session.updatedAt < STALE_MS)
}
export function liveActiveCount(now = Date.now()): number {
  return liveSessions(now).length
}
export function waitingCount(now = Date.now()): number {
  return liveSessions(now).filter((session) => session.phase === 'waiting').length
}

export function toastAllowed(provider: string): boolean {
  if (!settings.aiToastsEnabled) return false
  const only = settings.aiToastProviders
  return !only || only.length === 0 || only.includes(provider)
}

function normalize(raw: AiActivityEvent): AiActivityEvent | null {
  if (!raw || typeof raw !== 'object' || !KINDS.includes(raw.kind) || typeof raw.provider !== 'string' || !raw.provider) return null
  const text = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max) : '')
  const percent = typeof raw.percent === 'number' && Number.isFinite(raw.percent) ? Math.max(0, Math.min(100, raw.percent)) : null
  const duration = typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) && raw.durationMs >= 0 ? raw.durationMs : null
  return {
    kind: raw.kind,
    provider: raw.provider.slice(0, 32),
    title: text(raw.title, 120),
    detail: text(raw.detail, 160),
    percent,
    durationMs: duration,
    ts: typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : Date.now(),
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId.slice(0, 64) : null,
    source: raw.source,
  }
}

const keyOf = (event: AiActivityEvent) => `${event.provider}:${event.sessionId ?? 'default'}`

function track(event: AiActivityEvent): void {
  const key = keyOf(event)
  const now = Date.now()
  setLive((current) => {
    const rest = current.filter((session) => session.key !== key && now - session.updatedAt < STALE_MS)
    if (event.kind === 'completed' || event.kind === 'failed') return rest
    const previous = current.find((session) => session.key === key)
    const next: LiveSession = {
      key,
      provider: event.provider,
      title: event.title || previous?.title || '',
      detail: event.detail || previous?.detail || '',
      phase: event.kind === 'question' ? 'waiting' : 'working',
      percent: event.percent ?? previous?.percent ?? null,
      startedAt: previous?.startedAt ?? now,
      updatedAt: now,
    }
    return [...rest, next]
  })
  setFeed((current) => [event, ...current].slice(0, MAX_FEED))
}

/** Progress without a known percentage never needs a toast; the collapsed stat already shows it. */
function worthAToast(event: AiActivityEvent): boolean {
  if (event.kind !== 'progress') return true
  if (event.percent == null) return false
  const key = keyOf(event)
  const shown = lastToastPercent.get(key)
  if (shown != null && Math.abs(event.percent - shown) < 10 && event.percent < 100) return false
  lastToastPercent.set(key, event.percent)
  return true
}

export function ingestAiActivity(raw: AiActivityEvent): void {
  const event = normalize(raw)
  if (!event || !toastAllowed(event.provider)) return
  track(event)
  if (event.kind === 'completed' || event.kind === 'failed') lastToastPercent.delete(keyOf(event))
  if (worthAToast(event)) showAiToast(event)
}

export { live, feed }

let unlisten: UnlistenFn | null = null
let started = false

/** Listen for `ai://activity`. Safe to call more than once. */
export async function subscribeAiActivity(): Promise<() => void> {
  if (started) return () => {}
  started = true
  try {
    unlisten = await onAiActivity(ingestAiActivity)
  } catch {
    unlisten = null
  }
  // Events that arrived before this window was ready (for example a session that just started).
  try {
    const recent = await cmd.agentEventsRecent()
    const cutoff = Date.now() - 60_000
    for (const event of recent) if (event.ts >= cutoff && (event.kind === 'started' || event.kind === 'question')) track(normalize(event) ?? event)
  } catch { /* Older builds have no recent-events command. */ }
  return () => {
    unlisten?.()
    unlisten = null
    started = false
  }
}
