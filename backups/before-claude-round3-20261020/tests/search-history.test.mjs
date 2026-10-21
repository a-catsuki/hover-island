import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

async function load(path, mocks = {}, globals = {}) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  vm.runInNewContext(js, { exports, module: { exports }, require: name => {
    assert.ok(Object.hasOwn(mocks, name), `Unexpected import ${name}`)
    return mocks[name]
  }, URL, Date, setTimeout, clearTimeout, ...globals })
  return exports
}
const helpers = await load('src/lib/searchHistory.ts')
const now = Date.now()
const app = (name, extra = {}) => ({ id: `app:${name}`, kind: 'app', title: name, target: `C:\\Apps\\${name}.exe`, action: 'launch', score: 10, ...extra })

test('default suggestions include a frequent app outside the backend alphabetic eight', () => {
  let history = []
  for (let i = 0; i < 20; i++) history = helpers.rememberSearchResult(history, app('Zed'), now - 1000)
  history = helpers.rememberSearchResult(history, app('Alpha'), now)
  const suggestions = helpers.historySuggestions(history, 10, now)
  assert.equal(suggestions[0].title, 'Zed')
  assert.equal(suggestions[1].title, 'Alpha')
})

test('legacy counts recover apps from the full catalogue without inventing recent-use times', () => {
  const catalogue = Array.from({ length: 24 }, (_, index) => ({ name: `App ${index}`, target: `C:\\Apps\\app-${index}.exe` }))
  const migrated = helpers.migrateLegacyFrecency(JSON.stringify({ [`app:${catalogue[23].target}`]: 42, [`app:${catalogue[0].target}`]: 2, missing: 500 }), catalogue)
  assert.equal(migrated.length, 2)
  assert.equal(migrated[0].result.title, 'App 23')
  assert.equal(migrated[0].lastUsed, null)
  assert.equal(migrated[0].result.subtitle, 'Frequently used')
  assert.equal(helpers.parseSearchHistory(JSON.stringify(migrated), now)[0].launches, 42)
})

test('history validates and bounds storage while omitting icon/base64 payloads', () => {
  let history = helpers.rememberSearchResult([], app('Editor', { icon: `data:image/png;base64,${'x'.repeat(100000)}` }), now)
  assert.equal(history[0].result.icon, undefined)
  assert.ok(JSON.stringify(history).length < 1000)
  assert.equal(helpers.parseSearchHistory('{').length, 0)
  assert.equal(helpers.parseSearchHistory('x'.repeat(600000)).length, 0)
  assert.equal(helpers.parseSearchHistory(JSON.stringify([{ result: app('Bad'), launches: -1, lastUsed: now }])).length, 0)
  assert.equal(helpers.parseSearchHistory(JSON.stringify([{ result: app('Bad', { target: 'javascript:alert(1)' }), launches: 1, lastUsed: now }])).length, 0)
  assert.equal(helpers.parseSearchHistory(JSON.stringify([{ result: app('Old'), launches: 1, lastUsed: now - 181 * 86400000 }]), now).length, 0)
  for (let i = 0; i < 200; i++) history = helpers.rememberSearchResult(history, app(`App ${i}`), now)
  assert.equal(history.length, helpers.MAX_SEARCH_HISTORY)
  assert.equal(helpers.rememberSearchResult(history, app('Calculator', { kind: 'calc', action: 'copy' }), now).length, history.length)
  assert.equal(helpers.rememberSearchResult([], app('Web search', { kind: 'web', action: 'open', target: 'https://google.com?q=private' }), now).length, 0)
})

test('links and documents join recents, duplicate paths update frequency, exact typed matches remain ahead', () => {
  let history = helpers.rememberSearchResult([], app('Editor'), now)
  history = helpers.rememberSearchResult(history, app('Editor', { target: 'c:\\apps\\editor.exe' }), now)
  assert.equal(history.length, 1)
  assert.equal(history[0].launches, 2)
  history = helpers.rememberSearchResult(history, app('Document', { kind: 'file', action: 'open', target: 'C:\\Docs\\report.pdf' }), now)
  history = helpers.rememberSearchResult(history, app('Docs site', { kind: 'url', action: 'open', target: 'https://example.com/docs' }), now)
  assert.equal(history.length, 3)
  const ranked = helpers.rankWithHistory([app('Exact', { score: 1000 }), app('Editor', { score: 700 })], history, 10, now)
  assert.equal(ranked[0].title, 'Exact')
})

test('Spotlight records only successful opens, uses local recents before backend defaults', async () => {
  const storage = new Map()
  let fail = true
  let backendSearches = 0
  const signal = initial => { let value = initial; return [() => value, next => { value = typeof next === 'function' ? next(value) : next }] }
  const state = await load('src/state/spotlight.ts', {
    'solid-js': { createSignal: signal },
    '../lib/searchHistory': helpers,
    '../lib/ipc': { cmd: { appsLaunch: async () => { if (fail) throw new Error('Gone') }, spotlightSearch: async () => { backendSearches++; return [app('Alpha')] } } },
    './ui': { collapseIsland() {}, expandIsland() {}, expanded: () => false, pinned: () => false },
  }, { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, window: { setTimeout } })
  await state.runResult(app('Zed'))
  assert.equal(storage.size, 0)
  fail = false
  await state.runResult(app('Zed'))
  assert.equal(helpers.parseSearchHistory(storage.get(helpers.SEARCH_HISTORY_KEY)).length, 1)
  await state.runSearch('')
  assert.equal(backendSearches, 0)
  assert.equal(state.spotlightResults()[0].title, 'Zed')
})

test('Spotlight migrates legacy defaults once using all installed apps', async () => {
  const frequent = app('Zed')
  const storage = new Map([['hover-island.spotlight.frecency', JSON.stringify({ [`app:${frequent.target}`]: 90 })]])
  let appReads = 0
  const signal = initial => { let value = initial; return [() => value, next => { value = typeof next === 'function' ? next(value) : next }] }
  const state = await load('src/state/spotlight.ts', {
    'solid-js': { createSignal: signal }, '../lib/searchHistory': helpers,
    '../lib/ipc': { cmd: { appsList: async () => { appReads++; return [...Array.from({ length: 8 }, (_, i) => ({ name: `A${i}`, target: app(`A${i}`).target })), { name: frequent.title, target: frequent.target }] } } },
    './ui': { collapseIsland() {}, expandIsland() {}, expanded: () => false, pinned: () => false },
  }, { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, window: { setTimeout } })
  await state.runSearch('')
  await state.runSearch('')
  assert.equal(appReads, 1)
  assert.equal(state.spotlightResults()[0].title, 'Zed')
  assert.equal(helpers.parseSearchHistory(storage.get(helpers.SEARCH_HISTORY_KEY))[0].lastUsed, null)
  assert.equal(storage.has('hover-island.spotlight.frecency'), false)
})

test('frecency: a recent habit outranks an old favourite, and old opens fade by half every ten days', () => {
  const day = 86400000
  let history = []
  for (let i = 0; i < 12; i++) history = helpers.rememberSearchResult(history, app('Old favourite'), now - 60 * day)
  for (let i = 0; i < 3; i++) history = helpers.rememberSearchResult(history, app('This week'), now - day)
  const ranked = helpers.historySuggestions(history, 10, now)
  assert.equal(ranked[0].title, 'This week')
  const entry = helpers.rememberSearchResult([], app('Solo'), now - 10 * day)[0]
  const fresh = helpers.rememberSearchResult([], app('Solo'), now)[0]
  const decayed = helpers.historyScore(entry, now) - Math.min(8, Math.log2(2)) * 4
  const full = helpers.historyScore(fresh, now) - Math.min(8, Math.log2(2)) * 4
  assert.ok(Math.abs(decayed / full - 0.5) < 0.01)
  // History never outweighs a strong typed match.
  const typed = helpers.rankWithHistory([app('Exact', { score: 400 }), app('Habit', { score: 100 })], helpers.rememberSearchResult(helpers.rememberSearchResult([], app('Habit'), now), app('Habit'), now), 10, now)
  assert.equal(typed[0].title, 'Exact')
})

test('empty-query suggestions are sectioned, de-duplicated and filled from the installed apps', () => {
  let history = []
  for (let i = 0; i < 5; i++) history = helpers.rememberSearchResult(history, app('Zed'), now)
  history = helpers.rememberSearchResult(history, app('Report', { kind: 'file', action: 'open', target: 'C:\\Docs\\report.pdf' }), now)
  const beam = { id: 'command:beam', kind: 'command', title: 'Beam files', action: 'run', target: 'hover:beam', score: 0 }
  const catalogue = Array.from({ length: 12 }, (_, i) => app(`App ${i}`))
  const rows = helpers.composeSuggestions(history, [app('Zed'), ...catalogue], [beam], 10, now)
  assert.ok(rows.length <= 10)
  assert.equal(rows[0].section, 'Suggested')
  assert.equal(rows[0].title, 'Zed')
  assert.equal(new Set(rows.map(row => row.id + row.target)).size, rows.length)
  assert.deepEqual([...new Set(rows.map(row => row.section))], ['Suggested', 'Apps', 'Actions'])
  assert.equal(rows.filter(row => row.title === 'Zed').length, 1)
  const fresh = helpers.composeSuggestions([], catalogue, [beam], 10, now)
  assert.equal(fresh[0].section, 'Apps')
  assert.equal(fresh.at(-1).section, 'Actions')
})

test('built-in actions can be remembered, but only as hover: commands', () => {
  const action = { id: 'command:beam', kind: 'command', title: 'Beam files', action: 'run', target: 'hover:beam', score: 0 }
  assert.equal(helpers.rememberSearchResult([], action, now).length, 1)
  assert.equal(helpers.rememberSearchResult([], { ...action, target: 'C:\\evil.exe' }, now).length, 0)
  assert.equal(helpers.rememberSearchResult([], { ...action, action: 'copy' }, now).length, 0)
})

async function loadSpotlight({ expandedNow = false, apps = [] } = {}) {
  const calls = { collapsed: 0, expanded: 0, settings: 0 }
  let isExpanded = expandedNow
  const signal = initial => { let value = initial; return [() => value, next => { value = typeof next === 'function' ? next(value) : next }] }
  const state = await load('src/state/spotlight.ts', {
    'solid-js': { createSignal: signal },
    '../lib/searchHistory': helpers,
    '../lib/ipc': { cmd: { appsList: async () => apps, appsLaunch: async () => {}, spotlightSearch: async () => [], openSettings: async () => { calls.settings++ } } },
    './ui': { collapseIsland() { calls.collapsed++; isExpanded = false }, expandIsland() { calls.expanded++; isExpanded = true }, expanded: () => isExpanded, pinned: () => false },
    './panel': { showFileBucket() { calls.beam = (calls.beam ?? 0) + 1 } },
  }, { localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, window: { setTimeout, clearTimeout } })
  return { state, calls }
}

test('the search shortcut toggles: a second press dismisses and clears the query', async () => {
  const { state, calls } = await loadSpotlight()
  state.openSpotlight(false)
  assert.equal(state.spotlightOpen(), true)
  assert.equal(calls.expanded, 1)
  state.setSpotlightQuery('zed')
  assert.equal(state.spotlightQuery(), 'zed')
  // The native hotkey and the DOM listener can report one press twice; that must not open-then-close.
  state.openSpotlight(true)
  assert.equal(state.spotlightOpen(), true)
  await new Promise(resolve => setTimeout(resolve, 260))
  state.openSpotlight(true)
  assert.equal(state.spotlightOpen(), false)
  assert.equal(state.spotlightQuery(), '')
  assert.equal(state.spotlightResults().length, 0)
  assert.equal(calls.collapsed, 1, 'opened from a collapsed island, so closing collapses it again')
})

test('Escape-style closing keeps an island that was already open, and drops stale results', async () => {
  const { state, calls } = await loadSpotlight({ expandedNow: true })
  state.openSpotlight(true)
  state.setSpotlightQuery('a')
  state.closeSpotlight()
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(state.spotlightOpen(), false)
  assert.equal(state.spotlightQuery(), '')
  assert.equal(state.spotlightResults().length, 0, 'a search that finishes after closing must not repopulate results')
  assert.equal(calls.collapsed, 0)
})

test('empty-query suggestions include sections and built-in actions run without the clipboard', async () => {
  const { state, calls } = await loadSpotlight({ expandedNow: true, apps: [{ name: 'Notes', target: 'C:\\Apps\\Notes.exe', icon: 'data:image/png;base64,AA' }] })
  state.openSpotlight(true)
  await new Promise(resolve => setTimeout(resolve, 20))
  const rows = state.spotlightResults()
  assert.equal(rows[0].section, 'Apps')
  assert.equal(rows[0].icon, 'data:image/png;base64,AA')
  const beam = rows.find(row => row.target === 'hover:beam')
  assert.ok(beam)
  await state.runResult(beam)
  assert.equal(calls.beam, 1)
  assert.equal(state.spotlightOpen(), false)
  assert.equal(calls.collapsed, 0, 'Beam opens inside the island, so it must stay open')
})
