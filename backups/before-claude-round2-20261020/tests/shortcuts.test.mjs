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
