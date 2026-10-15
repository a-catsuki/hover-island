import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/fileDropTargets.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const exported = {}
vm.runInNewContext(javascript, { exports: exported, module: { exports: exported } }, { filename: 'fileDropTargets.ts' })
const {
  canExpandOnHover,
  fileDropActionAtRelease,
  fileDropDestinationAt,
  physicalDragPositionToCss,
  updateFileDropPreview,
} = exported

test('native physical positions map to CSS pixels at high DPI', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(physicalDragPositionToCss({ x: 480, y: 220 }, 2))), { x: 240, y: 110 })
  assert.deepEqual(JSON.parse(JSON.stringify(physicalDragPositionToCss({ x: 300, y: 150 }, 1.25))), { x: 240, y: 120 })
  assert.deepEqual(JSON.parse(JSON.stringify(physicalDragPositionToCss({ x: 18, y: 12 }, 0))), { x: 18, y: 12 })
})

test('both explicit destination hit rectangles work regardless of notch edge', () => {
  const rects = {
    recycle: { left: 40, top: 30, right: 145, bottom: 90 },
    beam: { left: 255, top: 30, right: 360, bottom: 90 },
  }
  for (const point of [{ x: 40, y: 30 }, { x: 100, y: 60 }, { x: 145, y: 90 }]) {
    assert.equal(fileDropDestinationAt(point, rects), 'recycle')
  }
  for (const point of [{ x: 255, y: 30 }, { x: 300, y: 60 }, { x: 360, y: 90 }]) {
    assert.equal(fileDropDestinationAt(point, rects), 'beam')
  }
})

test('the center gap and points outside the toast have no destination', () => {
  const rects = {
    recycle: { left: 40, top: 30, right: 145, bottom: 90 },
    beam: { left: 255, top: 30, right: 360, bottom: 90 },
  }
  assert.equal(fileDropDestinationAt({ x: 200, y: 60 }, rects), null)
  assert.equal(fileDropDestinationAt({ x: 100, y: 120 }, rects), null)
  assert.equal(fileDropActionAtRelease(null, ['C:/sample.txt']), null)
})

test('preview highlights while dragging, leave cancels, and release selects one explicit action', () => {
  const initial = updateFileDropPreview(null, { type: 'enter', paths: ['C:/sample.txt'] }, 'recycle')
  assert.equal(initial.target, 'recycle')
  assert.equal(initial.count, 1)
  const over = updateFileDropPreview(initial, { type: 'over' }, 'beam')
  assert.equal(over.target, 'beam')
  assert.deepEqual(over.paths, ['C:/sample.txt'])
  assert.equal(updateFileDropPreview(over, { type: 'leave' }, null), null)

  assert.equal(fileDropActionAtRelease('recycle', ['C:/sample.txt']), 'recycle')
  assert.equal(fileDropActionAtRelease('beam', ['C:/sample.txt']), 'beam')
  assert.equal(fileDropActionAtRelease('recycle', []), null)
})

test('drag feedback prevents hover from opening the full dashboard', () => {
  assert.equal(canExpandOnHover({ enabled: true, alreadyOpen: false, placementDragging: false, fileDragging: true }), false)
  assert.equal(canExpandOnHover({ enabled: true, alreadyOpen: false, placementDragging: false, fileDragging: false }), true)
})
