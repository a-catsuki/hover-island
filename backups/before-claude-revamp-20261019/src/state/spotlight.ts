import { createSignal } from 'solid-js'
import { cmd, type SearchResult } from '../lib/ipc'
import { SEARCH_HISTORY_KEY, parseSearchHistory, rememberSearchResult, historySuggestions, rankWithHistory, migrateLegacyFrecency, type SearchHistoryEntry } from '../lib/searchHistory'
import { collapseIsland, expandIsland, expanded as islandExpanded, pinned as islandPinned } from './ui'

/**
 * Spotlight state: a self-contained overlay driven by its configurable shortcut.
 * The backend emits `spotlight://open`; App wires that event to `openSpotlight`.
 */

const [spotlightOpen, setSpotlightOpen] = createSignal(false)
const [spotlightQuery, setQuery] = createSignal('')
const [spotlightResults, setResults] = createSignal<SearchResult[]>([])
const [spotlightLoading, setLoading] = createSignal(false)
const [spotlightError, setError] = createSignal<string | null>(null)

const DEBOUNCE_MS = 75
const SLOW_MS = 120
const MAX_RESULTS = 10
let debounceTimer: number | undefined
let slowTimer: number | undefined
let searchToken = 0
let restoreIslandAfterSearch = false

function loadHistory(): SearchHistoryEntry[] {
  try { return parseSearchHistory(localStorage.getItem(SEARCH_HISTORY_KEY)) } catch { return [] }
}
let history = loadHistory()
let migration: Promise<void> | undefined
function migrateHistoryOnce(): Promise<void> {
  if (migration) return migration
  migration = (async () => {
    let raw: string | null = null
    try { raw = localStorage.getItem('hover-island.spotlight.frecency') } catch { return }
    if (!raw || history.length) return
    try {
      const migrated = migrateLegacyFrecency(raw, await cmd.appsList())
      const existing = new Set(history.map(entry => `${entry.result.kind}:${entry.result.target.toLowerCase()}`))
      history = [...history, ...migrated.filter(entry => !existing.has(`${entry.result.kind}:${entry.result.target.toLowerCase()}`))].slice(0, 100)
      if (migrated.length) {
        localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history))
        localStorage.removeItem('hover-island.spotlight.frecency')
      }
    } catch { /* Preserve legacy data if the app catalogue or storage is unavailable. */ }
  })()
  return migration
}
function remember(result: SearchResult): void {
  history = rememberSearchResult(history, result)
  try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history)) } catch { /* In-memory history still works when storage is unavailable. */ }
}
/* -------------------------------- searching ------------------------------ */

export async function runSearch(query: string = spotlightQuery()): Promise<void> {
  const token = ++searchToken
  if (slowTimer !== undefined) {
    clearTimeout(slowTimer)
    slowTimer = undefined
  }
  // Empty search is local history, independent of the backend's alphabetic app slice.
  if (!query.trim()) {
    await migrateHistoryOnce()
    if (token !== searchToken) return
    setResults(historySuggestions(history, MAX_RESULTS))
    setLoading(false)
    setError(null)
    return
  }
  // Only surface the shimmer if the backend actually takes a beat.
  slowTimer = window.setTimeout(() => {
    if (token === searchToken) setLoading(true)
  }, SLOW_MS)

  try {
    const results = await cmd.spotlightSearch(query)
    if (token !== searchToken) return
    setResults(rankWithHistory(results, history, MAX_RESULTS))
    setError(null)
  } catch (error) {
    if (token !== searchToken) return
    setResults([])
    setError(error instanceof Error ? error.message : 'Search is temporarily unavailable.')
  } finally {
    if (token === searchToken) {
      if (slowTimer !== undefined) {
        clearTimeout(slowTimer)
        slowTimer = undefined
      }
      setLoading(false)
    }
  }
}

/** Update the query immediately and debounce the backend call. */
export function setSpotlightQuery(value: string): void {
  setQuery(value)
  // Invalidate any in-flight IPC immediately so old results cannot be selected
  // while the new query waits for its debounce interval.
  searchToken++
  setLoading(true)
  setResults([])
  setError(null)
  if (debounceTimer !== undefined) clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    debounceTimer = undefined
    void runSearch(value)
  }, DEBOUNCE_MS)
}

export function openSpotlight(nativeOpenContext?: boolean | MouseEvent): void {
  if (spotlightOpen()) return
  // Spotlight can start from the collapsed hotkey or from the expanded panel.
  // Expand for the search, then restore the prior panel state when it closes.
  const wasExpanded =
    typeof nativeOpenContext === 'boolean' ? nativeOpenContext : islandExpanded()
  restoreIslandAfterSearch = wasExpanded || islandPinned()
  if (!islandExpanded()) expandIsland()
  if (debounceTimer !== undefined) {
    clearTimeout(debounceTimer)
    debounceTimer = undefined
  }
  setSpotlightOpen(true)
  setQuery('')
  setResults([])
  setError(null)
  void runSearch('')
}

export function closeSpotlight(): void {
  if (debounceTimer !== undefined) {
    clearTimeout(debounceTimer)
    debounceTimer = undefined
  }
  if (slowTimer !== undefined) {
    clearTimeout(slowTimer)
    slowTimer = undefined
  }
  searchToken++
  setLoading(false)
  setResults([])
  setError(null)
  setSpotlightOpen(false)

  if (!restoreIslandAfterSearch) collapseIsland()
  restoreIslandAfterSearch = false
}

/* --------------------------------- actions ------------------------------- */

async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}

export async function runResult(result: SearchResult): Promise<void> {
  try { switch (result.action) {
    case 'launch':
      await cmd.appsLaunch(result.target)
      break
    case 'open':
      if (result.kind === 'url' || result.kind === 'web') {
        await cmd.appsOpenUrl(result.target)
      } else {
        await cmd.appsLaunch(result.target)
      }
      break
    case 'calc':
    case 'copy':
    case 'run':
    default:
      await copyToClipboard(result.target)
      break
  }
  remember(result)
  closeSpotlight()
  } catch (error) { setError(`Could not ${result.action === 'copy' ? 'copy result' : 'open result'}: ${String(error)}`) }
}

export { spotlightOpen, spotlightQuery, spotlightResults, spotlightLoading, spotlightError }
