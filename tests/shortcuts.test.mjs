import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/shortcuts.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { matchesShortcut } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
const key = (overrides = {}) => ({ code: 'Space', key: ' ', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, ...overrides })

test('configured shortcut replaces Ctrl+Space and requires exact modifiers', () => {
  assert.equal(matchesShortcut(key(), 'Control+Space'), true)
  assert.equal(matchesShortcut(key(), 'Alt+K'), false)
  assert.equal(matchesShortcut(key({ code: 'KeyK', key: 'k', ctrlKey: false, altKey: true }), 'Alt+K'), true)
  assert.equal(matchesShortcut(key({ shiftKey: true }), 'Control+Space'), false)
  assert.equal(matchesShortcut(key({ shiftKey: true }), 'Ctrl+Shift+Space'), true)
})

test('key aliases and digits work without accepting malformed multi-key shortcuts', () => {
  assert.equal(matchesShortcut(key({ code: 'Digit1', key: '1' }), 'Ctrl+1'), true)
  assert.equal(matchesShortcut(key({ code: 'KeyK', key: 'k' }), 'Ctrl+KeyK'), true)
  assert.equal(matchesShortcut(key(), 'Control+Space+K'), false)
  assert.equal(matchesShortcut(key(), ''), false)
})

test('physical key mapping agrees with native shortcuts on translated layouts', () => {
  assert.equal(matchesShortcut(key({ code: 'KeyA', key: 'q' }), 'Control+Q'), false)
  assert.equal(matchesShortcut(key({ code: 'KeyQ', key: 'a' }), 'Control+Q'), true)
  assert.equal(matchesShortcut(key({ code: '', key: 'q' }), 'Control+Q'), true)
})

const { normalizeShortcut, sameShortcut, shortcutFromEvent, shortcutParts, formatShortcut, checkShortcut, reservedReason } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('shortcuts normalise to one canonical saved form', () => {
  assert.equal(normalizeShortcut('ctrl+alt+k'), 'Control+Alt+K')
  assert.equal(normalizeShortcut('Alt+Control+KeyK'), 'Control+Alt+K')
  assert.equal(normalizeShortcut('Win+Shift+Space'), 'Shift+Super+Space')
  assert.equal(normalizeShortcut('Control+esc'), 'Control+Escape')
  assert.equal(normalizeShortcut('Control+Space+K'), '')
  assert.equal(normalizeShortcut(''), '')
  assert.equal(sameShortcut('Ctrl+Space', 'Control+Space'), true)
  assert.equal(sameShortcut('Alt+Space', 'Control+Space'), false)
})

test('key events become native shortcut strings with a live preview', () => {
  assert.deepEqual(shortcutFromEvent(key({ code: 'KeyK', key: 'k', altKey: true })), { combo: 'Control+Alt+K', complete: true })
  assert.deepEqual(shortcutFromEvent(key({ code: 'ControlLeft', key: 'Control', altKey: true })), { combo: 'Control+Alt', complete: false })
  assert.deepEqual(shortcutFromEvent(key({ code: 'Digit7', key: '7', ctrlKey: false, metaKey: true })), { combo: 'Super+7', complete: true })
  assert.deepEqual(shortcutFromEvent(key({ code: 'Comma', key: ',' })), { combo: 'Control+Comma', complete: true })
  const event = key({ code: 'KeyK', key: 'k', altKey: true })
  assert.equal(matchesShortcut(event, shortcutFromEvent(event).combo), true)
})

test('shortcuts show with friendly Windows names', () => {
  assert.deepEqual(shortcutParts('Control+Alt+Super+Shift+ArrowUp'), ['Ctrl', 'Alt', 'Shift', 'Win', '↑'])
  assert.equal(formatShortcut('control+k'), 'Ctrl+K')
  assert.deepEqual(shortcutParts(''), [])
})

test('recorded shortcuts are checked for modifiers, Windows, edit keys and conflicts', () => {
  const others = [{ id: 'search', label: 'Search', combo: 'Control+Space' }]
  assert.equal(checkShortcut('Control+Alt+K', others).ok, true)
  assert.equal(checkShortcut('Alt+Space', others).ok, true)
  assert.equal(checkShortcut('Control+Alt', others).ok, false)
  assert.equal(checkShortcut('Shift+K', others).ok, false)
  assert.match(checkShortcut('Alt+F4', others).message, /Windows/)
  assert.match(checkShortcut('Super+L', others).message, /Windows/)
  assert.match(checkShortcut('Control+C', others).message, /editing/)
  assert.match(checkShortcut('Ctrl+Space', others).message, /Already used for Search/)
  assert.match(checkShortcut('Control+Shift+B', others).message, /built in/)
  assert.equal(reservedReason('Alt+Space'), null)
})
