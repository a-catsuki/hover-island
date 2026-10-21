import type { SearchResult } from './ipc'

export const SEARCH_HISTORY_KEY = 'hover-island.spotlight.history.v1'
export const MAX_SEARCH_HISTORY = 100
const MAX_STORAGE_LENGTH = 512 * 1024
const MAX_AGE_MS = 180 * 86400000

export interface SearchHistoryEntry {
  result: SearchResult
  launches: number
  /** null preserves legacy frequency counts without inventing a recent-use time. */
  lastUsed: number | null
}

function shortText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f]/.test(value)
}

/** Only explicit app/file/link opens belong in history, never expressions or web searches. */
function safeResult(value: unknown): SearchResult | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (!['app', 'file', 'url'].includes(String(item.kind)) || !shortText(item.title, 256) || !shortText(item.target, 2048)) return null
  if (item.kind === 'url') {
    if (item.action !== 'open') return null
    try { if (!['https:', 'http:'].includes(new URL(item.target).protocol)) return null } catch { return null }
  } else {
    if (item.action !== 'open' && item.action !== 'launch') return null
    // App and document launches must be paths, not script or data URL payloads.
    if (!/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(item.target)) return null
  }
  return {
    id: `${item.kind}:${item.target}`, title: item.title,
    subtitle: shortText(item.subtitle, 256) ? item.subtitle : undefined,
    kind: String(item.kind), action: String(item.action), target: item.target, score: 0,
    // Intentionally omit icons and any other payload. Icons can contain base64 images.
  }
}

function key(result: SearchResult): string {
  return `${result.kind}:${result.kind === 'url' ? result.target : result.target.toLowerCase()}`
}

export function historyScore(entry: SearchHistoryEntry, now = Date.now()): number {
  const ageDays = entry.lastUsed == null ? null : Math.max(0, now - entry.lastUsed) / 86400000
  return Math.min(8, Math.log2(entry.launches + 1)) * 8 + (ageDays == null ? 0 : 50 / (1 + ageDays / 7))
}

export function parseSearchHistory(raw: string | null, now = Date.now()): SearchHistoryEntry[] {
  if (!raw || raw.length > MAX_STORAGE_LENGTH) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const entries: SearchHistoryEntry[] = []
    const seen = new Set<string>()
    for (const item of parsed.slice(0, MAX_SEARCH_HISTORY * 2)) {
      const result = safeResult(item?.result)
      if (!result || !Number.isInteger(item.launches) || item.launches < 1 || item.launches > 1000000
        || (item.lastUsed !== null && (!Number.isFinite(item.lastUsed) || item.lastUsed < 0 || item.lastUsed > now + 60000 || now - item.lastUsed > MAX_AGE_MS))) continue
      const id = key(result)
      if (seen.has(id)) continue
      seen.add(id)
      entries.push({ result, launches: item.launches, lastUsed: item.lastUsed })
    }
    return entries.sort((a, b) => historyScore(b, now) - historyScore(a, now)).slice(0, MAX_SEARCH_HISTORY)
  } catch { return [] }
}

export function rememberSearchResult(history: SearchHistoryEntry[], value: SearchResult, now = Date.now()): SearchHistoryEntry[] {
  const result = safeResult(value)
  if (!result) return history
  const id = key(result)
  const existing = history.find(entry => key(entry.result) === id)
  return [
    { result, launches: Math.min(1000000, (existing?.launches ?? 0) + 1), lastUsed: now },
    ...history.filter(entry => key(entry.result) !== id && (entry.lastUsed == null || now - entry.lastUsed <= MAX_AGE_MS)),
  ].slice(0, MAX_SEARCH_HISTORY)
}

export function historySuggestions(history: SearchHistoryEntry[], limit = 10, now = Date.now()): SearchResult[] {
  return history.filter(entry => entry.lastUsed == null || now - entry.lastUsed <= MAX_AGE_MS)
    .map(entry => ({ ...entry.result, score: historyScore(entry, now) }))
    .sort((a, b) => b.score - a.score).slice(0, limit)
}

/** Recover old counts using the complete cached app catalogue, not its first eight apps. */
export function migrateLegacyFrecency(raw: string | null, apps: { name: string; target: string }[]): SearchHistoryEntry[] {
  if (!raw || raw.length > MAX_STORAGE_LENGTH) return []
  try {
    const counts: unknown = JSON.parse(raw)
    if (!counts || Array.isArray(counts) || typeof counts !== 'object') return []
    const entries: SearchHistoryEntry[] = []
    for (const app of apps) {
      const count = (counts as Record<string, unknown>)[`app:${app.target}`]
        ?? (counts as Record<string, unknown>)[app.target]
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) continue
      const result = safeResult({ kind: 'app', title: app.name, target: app.target, action: 'launch', subtitle: 'Frequently used' })
      if (result) entries.push({ result, launches: Math.min(count, 1000000), lastUsed: null })
    }
    return entries.sort((a, b) => b.launches - a.launches).slice(0, MAX_SEARCH_HISTORY)
  } catch { return [] }
}

export function rankWithHistory(results: SearchResult[], history: SearchHistoryEntry[], limit = 10, now = Date.now()): SearchResult[] {
  const boosts = new Map(history.map(entry => [key(entry.result), historyScore(entry, now)]))
  return results.map(result => ({ ...result, score: result.score + (boosts.get(key(result)) ?? 0) }))
    .sort((a, b) => b.score - a.score).slice(0, limit)
}
