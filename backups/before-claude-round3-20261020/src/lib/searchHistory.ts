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
  /** Timestamps of the latest opens (newest first). Each one decays on its own, which is what makes the score frecency. */
  recent?: number[]
}

/** Recent opens fade by half every ten days; the total count only adds a small tie-breaker. */
export const FRECENCY_HALF_LIFE_DAYS = 10
const MAX_RECENT_STAMPS = 12
/** Typed matches stay ahead of history: the boost never outweighs relevance. */
const MAX_TYPED_BOOST = 100
export type SuggestionSection = 'Suggested' | 'Apps' | 'Files' | 'Actions'
export type SuggestedResult = SearchResult & { section: SuggestionSection }

function shortText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f]/.test(value)
}

/** Only explicit app/file/link opens belong in history, never expressions or web searches. */
function safeResult(value: unknown): SearchResult | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (!['app', 'file', 'url', 'command'].includes(String(item.kind)) || !shortText(item.title, 256) || !shortText(item.target, 2048)) return null
  if (item.kind === 'command') {
    // Built-in actions only: a stored command can never carry a path, URL or script.
    if (item.action !== 'run' || !/^hover:[a-z-]{1,32}$/.test(item.target)) return null
  } else if (item.kind === 'url') {
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

/** Frecency: every recent open counts for 20 points and halves every FRECENCY_HALF_LIFE_DAYS, plus up to 32 for lifetime use. */
export function historyScore(entry: SearchHistoryEntry, now = Date.now()): number {
  const stamps = entry.recent?.length ? entry.recent : entry.lastUsed == null ? [] : [entry.lastUsed]
  let recency = 0
  for (const stamp of stamps) recency += 20 * 0.5 ** (Math.max(0, now - stamp) / (FRECENCY_HALF_LIFE_DAYS * 86400000))
  return Math.min(8, Math.log2(entry.launches + 1)) * 4 + recency
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
      const recent = Array.isArray(item.recent)
        ? item.recent.filter((stamp: unknown): stamp is number => typeof stamp === 'number' && Number.isFinite(stamp) && stamp >= 0 && stamp <= now + 60000 && now - stamp <= MAX_AGE_MS).slice(0, MAX_RECENT_STAMPS)
        : undefined
      entries.push(recent?.length ? { result, launches: item.launches, lastUsed: item.lastUsed, recent } : { result, launches: item.launches, lastUsed: item.lastUsed })
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
    { result, launches: Math.min(1000000, (existing?.launches ?? 0) + 1), lastUsed: now, recent: [now, ...(existing?.recent ?? (existing?.lastUsed == null ? [] : [existing.lastUsed]))].slice(0, MAX_RECENT_STAMPS) },
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
  const boosts = new Map(history.map(entry => [key(entry.result), Math.min(MAX_TYPED_BOOST, historyScore(entry, now))]))
  return results.map(result => ({ ...result, score: result.score + (boosts.get(key(result)) ?? 0) }))
    .sort((a, b) => b.score - a.score).slice(0, limit)
}

/**
 * The empty-query list: the best frecent picks first ("Suggested"), then apps,
 * files and built-in actions, each item shown once. Installed apps fill the gaps
 * so a fresh install is never an empty box.
 */
export function composeSuggestions(
  history: SearchHistoryEntry[],
  catalogue: SearchResult[] = [],
  actions: SearchResult[] = [],
  limit = 10,
  now = Date.now(),
): SuggestedResult[] {
  const ranked = historySuggestions(history, MAX_SEARCH_HISTORY, now)
  const shown = new Set<string>()
  const take = (list: SearchResult[], count: number, section: SuggestionSection): SuggestedResult[] => {
    const out: SuggestedResult[] = []
    for (const item of list) {
      if (out.length >= count) break
      const id = key(item)
      if (shown.has(id)) continue
      shown.add(id)
      out.push({ ...item, section })
    }
    return out
  }
  const isFile = (item: SearchResult) => item.kind === 'file' || item.kind === 'url'
  const suggested = take(ranked, 3, 'Suggested')
  const files = take(ranked.filter(isFile), 2, 'Files')
  const quick = take(actions, 2, 'Actions')
  const appRoom = Math.max(0, Math.min(ranked.length ? 4 : 6, limit - suggested.length - files.length - quick.length))
  const apps = take([...ranked.filter(item => item.kind === 'app'), ...catalogue.filter(item => item.kind === 'app')], appRoom, 'Apps')
  return [...suggested, ...apps, ...files, ...quick].slice(0, limit)
}
