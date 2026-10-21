import type { UsageSnapshot } from './ipc'
export function usedRatio(value: UsageSnapshot): number | null {
  if (value.status !== 'ok') return null
  if (typeof value.percent === 'number' && Number.isFinite(value.percent)) return Math.max(0, Math.min(1, value.percent))
  if (typeof value.used === 'number' && typeof value.limit === 'number' && value.limit > 0) return Math.max(0, Math.min(1, value.used / value.limit))
  return null
}
export function windowLabel(value?: string | null): string {
  if (!value) return 'Recent activity'
  if (/^(168h|10080m|7d|weekly)$/i.test(value.trim())) return 'Weekly'
  if (/^(5h|300m)$/i.test(value.trim())) return '5-hour'
  return value.replace(/168h/gi, 'Weekly')
}
export function remainingPercent(value: UsageSnapshot): number | null { const used = usedRatio(value); return used === null ? null : Math.round((1 - used) * 100) }
export function resetCountdown(resetAt: number | null | undefined, now = Date.now()): string {
  if (!resetAt || !Number.isFinite(resetAt)) return 'Reset time unavailable'
  const minutes = Math.ceil((resetAt - now) / 60000)
  if (minutes <= 0) return 'Reset due · refresh report'
  if (minutes < 60) return `Resets in ${minutes}m`
  if (minutes < 1440) return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `Resets in ${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`
}

export function resetTimeLabel(resetAt: number | null | undefined): string | null {
  if (resetAt == null || !Number.isFinite(resetAt) || resetAt <= 0) return null
  const date = new Date(resetAt)
  if (!Number.isFinite(date.getTime())) return null
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function reportAge(updatedAt: number | null | undefined, now = Date.now()): string {
  if (updatedAt == null || !Number.isFinite(updatedAt) || updatedAt <= 0) return 'Report time unavailable'
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60_000))
  if (minutes < 1) return 'Reported just now'
  if (minutes < 60) return `Reported ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Reported ${hours}h ago`
  return `Reported ${Math.floor(hours / 24)}d ago`
}

/** Provider quota reports are snapshots; do not infer a reset from elapsed time. */
export function isReportStale(updatedAt: number | null | undefined, now = Date.now()): boolean {
  return updatedAt == null || !Number.isFinite(updatedAt) || updatedAt <= 0 || now - updatedAt > 15 * 60_000
}

/* ------------------------------------------------------------ providers and activity */

export interface ProviderMeta { label: string; brand: string; color: string; letter: string }
/** Display order is the key order. Unknown ids fall back to a neutral entry. */
export const PROVIDER_META: Record<string, ProviderMeta> = {
  codex: { label: 'Codex', brand: 'codex', color: '#FFFFFF', letter: 'C' },
  'claude-code': { label: 'Claude Code', brand: 'claude', color: '#D97757', letter: 'C' },
  gemini: { label: 'Gemini CLI', brand: 'gemini', color: '#6EA8FE', letter: 'G' },
  cursor: { label: 'Cursor', brand: 'cursor', color: '#E8E8E8', letter: 'C' },
  opencode: { label: 'OpenCode', brand: 'opencode', color: '#BDBDBD', letter: 'O' },
  'github-copilot': { label: 'GitHub Copilot', brand: 'github-copilot', color: '#BF5AF2', letter: 'C' },
  aider: { label: 'Aider', brand: 'aider', color: '#30D158', letter: 'A' },
  manual: { label: 'Custom', brand: 'custom', color: '#8E8E93', letter: '#' },
}
export function providerMeta(id: string): ProviderMeta {
  return PROVIDER_META[id] ?? { label: id.replace(/-/g, ' '), brand: id, color: '#8E8E93', letter: (id[0] ?? '?').toUpperCase() }
}
export function providerOrder(id: string): number {
  const index = Object.keys(PROVIDER_META).indexOf(id)
  return index < 0 ? 99 : index
}

/** 4200 -> "4.2s", 95000 -> "1m 35s". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '-'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function agoLabel(at: number | null | undefined, now = Date.now()): string {
  if (at == null || !Number.isFinite(at) || at <= 0) return 'never'
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function compactTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
  return String(Math.round(value))
}

export interface ProviderSummary { id: string; label: string; snapshots: UsageSnapshot[]; quota: UsageSnapshot[]; local?: UsageSnapshot; activity?: NonNullable<UsageSnapshot['activity']> }

/** Group raw snapshots by provider, in display order. Providers with no activity record still appear. */
export function groupProviders(all: UsageSnapshot[]): ProviderSummary[] {
  const map = new Map<string, UsageSnapshot[]>()
  for (const snapshot of all) {
    if (snapshot.provider === 'manual') continue
    map.set(snapshot.provider, [...(map.get(snapshot.provider) ?? []), snapshot])
  }
  return [...map.entries()].map(([id, snapshots]) => {
    const quota = snapshots.filter((s) => s.source === 'official-rate-limit' && s.status === 'ok')
      .sort((a, b) => (windowLabel(a.window) === '5-hour' ? 0 : 1) - (windowLabel(b.window) === '5-hour' ? 0 : 1))
    const local = snapshots.find((s) => s.source === 'local-logs')
    const activity = snapshots.map((s) => s.activity).find((a) => !!a) ?? undefined
    return { id, label: providerMeta(id).label, snapshots, quota, local, activity: activity ?? undefined }
  }).sort((a, b) => providerOrder(a.id) - providerOrder(b.id))
}

export type CompactAiStat = 'off' | 'usage-left' | 'response-time' | 'active-count'

/** The text for the collapsed notch stat, or null when there is nothing honest to show. */
export function compactStatValue(stat: CompactAiStat, all: UsageSnapshot[], liveActive = 0): { value: string; label: string; title: string } | null {
  if (stat === 'off') return null
  const groups = groupProviders(all)
  if (stat === 'usage-left') {
    let best: { left: number; label: string } | null = null
    for (const snapshot of all) {
      const left = remainingPercent(snapshot)
      if (snapshot.status === 'ok' && left != null && (snapshot.source === 'official-rate-limit' || snapshot.limit != null)) {
        if (!best || left < best.left) best = { left, label: `${snapshot.label} ${windowLabel(snapshot.window)}` }
      }
    }
    return best ? { value: `${best.left}%`, label: 'left', title: `${best.label}: ${best.left}% left` } : null
  }
  if (stat === 'response-time') {
    let total = 0
    let weight = 0
    for (const group of groups) {
      const activity = group.activity
      if (activity?.avgResponseMs != null && activity.responses24h > 0) { total += activity.avgResponseMs * activity.responses24h; weight += activity.responses24h }
    }
    return weight > 0 ? { value: formatDuration(total / weight), label: 'reply', title: `Average reply time over ${weight} replies in the last 24 hours` } : null
  }
  const logged = groups.reduce((sum, group) => sum + (group.activity?.activeSessions ?? 0), 0)
  const count = Math.max(logged, liveActive)
  return { value: String(count), label: count === 1 ? 'agent' : 'agents', title: count === 0 ? 'No AI agents working right now' : `${count} AI ${count === 1 ? 'agent is' : 'agents are'} working` }
}
