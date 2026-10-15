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
