import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/widgetPointerDrag.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const exported = {}
vm.runInNewContext(javascript, { exports: exported, module: { exports: exported } }, { filename: 'widgetPointerDrag.ts' })
const { crossedWidgetDragThreshold, widgetPointerDropTarget, widgetPointerReleaseTarget } = exported

test('widget reorder starts at five CSS pixels, and a click or small jitter stays inert', () => {
  assert.equal(crossedWidgetDragThreshold({ x: 10, y: 10 }, { x: 13, y: 13 }), false)
  assert.equal(crossedWidgetDragThreshold({ x: 10, y: 10 }, { x: 14, y: 13 }), true)
  assert.equal(crossedWidgetDragThreshold({ x: 10, y: 10 }, { x: 10, y: 15 }), true)
})

test('pointer release accepts other widgets or panel tabs only after drag starts', () => {
  const widget = widgetPointerDropTarget('calendar', null, 'weather')
  const panel = widgetPointerDropTarget(null, 'desk', 'weather')
  assert.deepEqual(JSON.parse(JSON.stringify(widget)), { kind: 'widget', id: 'calendar' })
  assert.deepEqual(JSON.parse(JSON.stringify(panel)), { kind: 'panel', id: 'desk' })
  assert.equal(widgetPointerReleaseTarget(false, widget), null)
  assert.deepEqual(JSON.parse(JSON.stringify(widgetPointerReleaseTarget(true, widget))), { kind: 'widget', id: 'calendar' })
  assert.deepEqual(JSON.parse(JSON.stringify(widgetPointerReleaseTarget(true, panel))), { kind: 'panel', id: 'desk' })
})

test('source widget, empty space, and cancelled drags never become a drop action', () => {
  assert.equal(widgetPointerDropTarget('weather', null, 'weather'), null)
  assert.equal(widgetPointerDropTarget(null, null, 'weather'), null)
  assert.equal(widgetPointerReleaseTarget(false, null), null)
})
