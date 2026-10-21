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
