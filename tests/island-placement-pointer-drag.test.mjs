import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/placementPointerDrag.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const exported = {}
vm.runInNewContext(javascript, { exports: exported, module: { exports: exported } }, { filename: 'placementPointerDrag.ts' })
const { canStartIslandPlacementDrag, crossedIslandPlacementThreshold } = exported

test('a five CSS pixel move starts a placement drag while a click or jitter stays a click', () => {
  assert.equal(crossedIslandPlacementThreshold({ x: 20, y: 30 }, { x: 23, y: 33 }), false)
  assert.equal(crossedIslandPlacementThreshold({ x: 20, y: 30 }, { x: 24, y: 33 }), true)
  assert.equal(crossedIslandPlacementThreshold({ x: 20, y: 30 }, { x: 20, y: 35 }), true)
})

test('only a primary left pointer on a noninteractive island surface can start a move', () => {
  const eligible = { button: 0, isPrimary: true, insideDraggableSurface: true, onInteractiveControl: false }
  assert.equal(canStartIslandPlacementDrag(eligible), true)
  assert.equal(canStartIslandPlacementDrag({ ...eligible, button: 2 }), false)
  assert.equal(canStartIslandPlacementDrag({ ...eligible, isPrimary: false }), false)
  assert.equal(canStartIslandPlacementDrag({ ...eligible, insideDraggableSurface: false }), false)
  assert.equal(canStartIslandPlacementDrag({ ...eligible, onInteractiveControl: true }), false)
})
