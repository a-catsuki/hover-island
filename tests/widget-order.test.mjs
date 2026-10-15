import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/settings/widgetOrder.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const { moveWidget, moveWidgetBefore } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

const widgets = [
  { id: 'media', kind: 'media', enabled: true, order: 0 },
  { id: 'weather', kind: 'weather', enabled: false, order: 1 },
  { id: 'calendar', kind: 'calendar', enabled: true, order: 2 },
]

test('keyboard move preserves widget identity and produces contiguous order', () => {
  const moved = moveWidget(widgets, 'calendar', -1)
  assert.deepEqual(moved.map(({ id, order }) => [id, order]), [
    ['media', 0], ['calendar', 1], ['weather', 2],
  ])
  assert.deepEqual(widgets.map(({ id, order }) => [id, order]), [
    ['media', 0], ['weather', 1], ['calendar', 2],
  ])
})

test('drag move places the grabbed widget before its target and ignores invalid drops', () => {
  assert.deepEqual(moveWidgetBefore(widgets, 'calendar', 'media').map(({ id }) => id), [
    'calendar', 'media', 'weather',
  ])
  assert.deepEqual(moveWidgetBefore(widgets, 'media', 'calendar').map(({ id }) => id), [
    'weather', 'media', 'calendar',
  ])
  assert.deepEqual(moveWidgetBefore(widgets, 'missing', 'media').map(({ id }) => id), [
    'media', 'weather', 'calendar',
  ])
})
