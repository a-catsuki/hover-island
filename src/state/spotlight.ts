import { createSignal } from 'solid-js'
import { cmd, type SearchResult } from '../lib/ipc'
import { collapseIsland, expandIsland, expanded as islandExpanded, pinned as islandPinned } from './ui'

/**
 * Spotlight state: a self-contained overlay driven by the global Ctrl+Space shortcut.
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
const FRECENCY_KEY = 'hover-island.spotlight.frecency'

let debounceTimer: number | undefined
let slowTimer: number | undefined
let searchToken = 0
let restoreIslandAfterSearch = false

/* -------------------------------- frecency ------------------------------- */

type FrecencyMap = Record<string, number>

function loadFrecency(): FrecencyMap {
  try {
    const raw = localStorage.getItem(FRECENCY_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as FrecencyMap
  } catch {
    /* malformed or unavailable storage */
  }
  return {}
}

let frecency = loadFrecency()

function persistFrecency(): void {
  try {
    localStorage.setItem(FRECENCY_KEY, JSON.stringify(frecency))
  } catch {
    /* ignore */
  }
}

function frecencyKey(result: SearchResult): string {
  return result.id || result.target
}

function bumpFrecency(result: SearchResult): void {
  const key = frecencyKey(result)
  if (!key) return
  frecency[key] = (frecency[key] ?? 0) + 1
  persistFrecency()
}

/** Apps you launch often drift upward; capped so exact matches still win. */
function frecencyBoost(result: SearchResult): number {
  if (result.kind !== 'app') return 0
  return Math.min(frecency[frecencyKey(result)] ?? 0, 8) * 20
}

function applyRanking(results: SearchResult[]): SearchResult[] {
  return results
    .map((result) => {
      const boost = frecencyBoost(result)
      return boost > 0 ? { ...result, score: result.score + boost } : result
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
}

/* -------------------------------- searching ------------------------------ */

export async function runSearch(query: string = spotlightQuery()): Promise<void> {
  const token = ++searchToken
  if (slowTimer !== undefined) {
    clearTimeout(slowTimer)
    slowTimer = undefined
  }
  // Only surface the shimmer if the backend actually takes a beat.
  slowTimer = window.setTimeout(() => {
    if (token === searchToken) setLoading(true)
  }, SLOW_MS)

  try {
    const results = await cmd.spotlightSearch(query)
    if (token !== searchToken) return
    setResults(applyRanking(results))
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
  if (result.kind === 'app') bumpFrecency(result)
  closeSpotlight()
  } catch (error) { setError(`Could not ${result.action === 'copy' ? 'copy result' : 'open result'}: ${String(error)}`) }
}

export { spotlightOpen, spotlightQuery, spotlightResults, spotlightLoading, spotlightError }
