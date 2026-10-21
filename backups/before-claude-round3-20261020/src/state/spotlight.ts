import { createSignal } from 'solid-js'
import { cmd, type InstalledApp, type SearchResult } from '../lib/ipc'
import { SEARCH_HISTORY_KEY, parseSearchHistory, rememberSearchResult, composeSuggestions, rankWithHistory, migrateLegacyFrecency, type SearchHistoryEntry, type SuggestedResult } from '../lib/searchHistory'
import { collapseIsland, expandIsland, expanded as islandExpanded, pinned as islandPinned } from './ui'

/**
 * Spotlight state: a self-contained overlay driven by its configurable shortcut.
 * The backend emits `spotlight://open`; App wires that event to `openSpotlight`.
 */

const [spotlightOpen, setSpotlightOpen] = createSignal(false)
const [spotlightQuery, setQuery] = createSignal('')
/** Empty-query rows carry a `section` (Suggested, Apps, Files, Actions); typed results do not. */
export type SpotlightResult = SearchResult & { section?: SuggestedResult['section'] }
const [spotlightResults, setResults] = createSignal<SpotlightResult[]>([])
const [spotlightLoading, setLoading] = createSignal(false)
const [spotlightError, setError] = createSignal<string | null>(null)
/** True between a keystroke and the matching results: visible results are stale and must not run. */
const [spotlightPending, setPending] = createSignal(false)

const DEBOUNCE_MS = 75
const SLOW_MS = 120
const MAX_RESULTS = 10
let debounceTimer: number | undefined
let slowTimer: number | undefined
let searchToken = 0
let restoreIslandAfterSearch = false
/** Native shortcut and DOM key listener can both report one press; a second toggle this soon is the same press. */
const TOGGLE_GUARD_MS = 220
let lastToggleAt = 0

/** Built-in actions: offered as suggestions, and found by typing their name. */
const QUICK_ACTIONS: { result: SearchResult; words: string }[] = [
  { result: { id: 'command:beam', kind: 'command', title: 'Beam files to your phone', subtitle: 'Open Beam', action: 'run', target: 'hover:beam', score: 0 }, words: 'beam send share files phone airdrop localsend' },
  { result: { id: 'command:settings', kind: 'command', title: 'Hover Island settings', subtitle: 'Open settings', action: 'run', target: 'hover:settings', score: 0 }, words: 'settings preferences options configure' },
  { result: { id: 'command:shortcuts', kind: 'command', title: 'Keyboard shortcuts', subtitle: 'Open settings', action: 'run', target: 'hover:shortcuts', score: 0 }, words: 'shortcuts hotkey keyboard keys' },
]
const quickActions = (): SearchResult[] => QUICK_ACTIONS.map(item => item.result)
function matchingActions(query: string): SearchResult[] {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return []
  return QUICK_ACTIONS.filter(item => item.result.title.toLowerCase().includes(q) || item.words.split(' ').some(word => word.startsWith(q)))
    .map(item => ({ ...item.result, score: 45 }))
}

/** Installed apps with their icons, fetched at most once a minute. */
let catalogue: { at: number; apps: Promise<InstalledApp[]> } | undefined
function installedApps(): Promise<InstalledApp[]> {
  if (catalogue && Date.now() - catalogue.at < 60000) return catalogue.apps
  const apps = Promise.resolve().then(() => cmd.appsList()).catch(() => [] as InstalledApp[])
  catalogue = { at: Date.now(), apps }
  return apps
}
const appResult = (app: InstalledApp): SearchResult => ({ id: `app:${app.target}`, kind: 'app', title: app.name, subtitle: 'Application', icon: app.icon, action: 'launch', target: app.target, score: 0 })

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
      const migrated = migrateLegacyFrecency(raw, await installedApps())
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
  // Empty search is local frecency, independent of the backend's alphabetic app slice.
  if (!query.trim()) {
    await migrateHistoryOnce()
    if (token !== searchToken) return
    const apps = await installedApps()
    if (token !== searchToken) return
    const icons = new Map(apps.filter(app => app.icon).map(app => [app.target.toLowerCase(), app.icon!]))
    let suggestions: SpotlightResult[] = composeSuggestions(history, apps.map(appResult), quickActions(), MAX_RESULTS)
      .map(item => item.kind === 'app' && !item.icon && icons.has(item.target.toLowerCase()) ? { ...item, icon: icons.get(item.target.toLowerCase()) } : item)
    // No catalogue and nothing opened yet: ask the backend for its default apps instead of showing an empty box.
    if (!apps.length && !history.length) {
      try {
        const defaults = (await cmd.spotlightSearch('')).filter(item => item.kind === 'app').slice(0, MAX_RESULTS)
        if (token !== searchToken) return
        suggestions = composeSuggestions([], defaults, quickActions(), MAX_RESULTS)
      } catch { suggestions = composeSuggestions([], [], quickActions(), MAX_RESULTS) }
    }
    setResults(suggestions)
    setLoading(false)
    setPending(false)
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
    setResults(rankWithHistory([...results, ...matchingActions(query)], history, MAX_RESULTS))
    setError(null)
  } catch (error) {
    if (token !== searchToken) return
    setResults([])
    setError(error instanceof Error ? error.message : 'Search is temporarily unavailable.')
  } finally {
    if (token === searchToken) {
      setPending(false)
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
  // while the new query waits for its debounce interval. The old rows stay on
  // screen (dimmed by the view) so the list does not flash empty on every key.
  searchToken++
  setPending(true)
  setError(null)
  if (debounceTimer !== undefined) clearTimeout(debounceTimer)
  if (!value.trim()) {
    debounceTimer = undefined
    void runSearch('')
    return
  }
  debounceTimer = window.setTimeout(() => {
    debounceTimer = undefined
    void runSearch(value)
  }, DEBOUNCE_MS)
}

/**
 * The search shortcut, the toolbar button and the native hotkey all land here.
 * Pressing the shortcut again closes the search, like any other toggle.
 */
export function openSpotlight(nativeOpenContext?: boolean | MouseEvent): void {
  const now = Date.now()
  if (spotlightOpen()) {
    if (now - lastToggleAt < TOGGLE_GUARD_MS) return
    lastToggleAt = now
    closeSpotlight()
    return
  }
  lastToggleAt = now
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
  lastToggleAt = Date.now()
  setLoading(false)
  setPending(false)
  setQuery('')
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

/** Built-in actions keep the island open so the page they point at is visible. */
async function runCommand(target: string): Promise<void> {
  if (target === 'hover:settings') await cmd.openSettings()
  else if (target === 'hover:shortcuts') await cmd.openSettings('shortcuts')
  else if (target === 'hover:beam') {
    const { showFileBucket } = await import('./panel')
    restoreIslandAfterSearch = true
    closeSpotlight()
    showFileBucket()
    return
  } else throw new Error('That action is not available.')
  closeSpotlight()
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
    case 'run':
      if (result.kind === 'command') {
        await runCommand(result.target)
        remember(result)
        return
      }
      await copyToClipboard(result.target)
      break
    case 'calc':
    case 'copy':
    default:
      await copyToClipboard(result.target)
      break
  }
  remember(result)
  closeSpotlight()
  } catch (error) { setError(`Could not ${result.action === 'copy' ? 'copy that' : 'open that'}. ${error instanceof Error ? error.message : String(error)}`) }
}

export { spotlightOpen, spotlightPending, spotlightQuery, spotlightResults, spotlightLoading, spotlightError }
