import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

async function loadTypeScript(path, requireModule = () => { throw new Error('Unexpected import') }) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exported = {}
  vm.runInNewContext(javascript, {
    exports: exported,
    module: { exports: exported },
    require: requireModule,
    crypto: globalThis.crypto,
  }, { filename: path })
  return exported
}

const widgetPages = await loadTypeScript('../src/lib/widgetPages.ts')
const panels = await loadTypeScript('../src/lib/panels.ts', spec => {
  if (spec === './widgetPages') return widgetPages
  throw new Error(`Unexpected import ${spec}`)
})
const { createPanelLayout, fitPanelLayout, removePanelLayout, renamePanelLayout } = panels
const widgetShapes = await loadTypeScript('../src/lib/widgetShapes.ts', spec => {
  if (spec === './widgetPages') return widgetPages
  throw new Error(`Unexpected import ${spec}`)
})
const placement = await loadTypeScript('../src/lib/widgetPlacement.ts', spec => {
  if (spec === './widgetPages') return widgetPages
  if (spec === './widgetShapes') return widgetShapes
  throw new Error(`Unexpected import ${spec}`)
})

const widget = (id, kind, order, panel, enabled = true) => ({ id, kind, order, panel, enabled })

test('size presets change horizontal space without moving the vertical baseline', () => {
  const values = Object.values(panels.SIZE_PRESETS)
  assert.deepEqual(values.map(value => value.collapsed.h), [38, 38, 38])
  assert.deepEqual(values.map(value => value.expanded.h), [560, 560, 560])
  assert.deepEqual(values.map(value => value.collapsed.w), [256, 320, 384])
  assert.deepEqual(values.map(value => value.expanded.w), [640, 800, 960])
})

test('legacy panel overflow becomes ordered named panels with a single flat grid each', () => {
  const widgets = [
    widget('media', 'media', 0, 'today'),
    widget('weather', 'weather', 1, 'today'),
    widget('calendar', 'calendar', 2, 'today'),
    widget('notes', 'notes', 3, 'desk'),
    widget('dock', 'dock', 4, 'desk'),
    widget('focus', 'focus', 5, 'desk'),
    widget('alerts', 'notifications', 6, 'activity'),
  ]
  const result = fitPanelLayout(
    { today: 'Today', desk: 'Desk', activity: 'Activity' },
    ['today', 'desk', 'activity'],
    widgets,
  )
  assert.ok(result.panelOrder.length > 3, 'overflow creates ordinary panels')
  assert.deepEqual([...result.panelOrder.slice(0, 3)], ['today', 'overflow-today-2', 'desk'])
  assert.equal(result.panels['overflow-today-2'], 'Today 2')
  assert.deepEqual([...result.widgets].sort((a, b) => a.id.localeCompare(b.id)).map(item => item.id),
    ['alerts', 'calendar', 'dock', 'focus', 'media', 'notes', 'weather'])
  for (const panelId of result.panelOrder) {
    const items = result.widgets.filter(item => item.panel === panelId)
    assert.equal(widgetPages.widgetPages(items, 2).length, 1, `${panelId} has no nested page`)
  }
})

test('generated duplicate Today pages repack into the real 2x2 cells and survive another normalization', () => {
  const result = fitPanelLayout(
    { today: 'Today', 'overflow-today-2': 'Today 2', 'overflow-today-2-2': 'Today 2', 'overflow-today-2-2-2': 'Today 2' },
    ['today', 'overflow-today-2', 'overflow-today-2-2', 'overflow-today-2-2-2'],
    [
      { ...widget('media', 'media', 0, 'today'), size: 'compact' },
      { ...widget('weather', 'weather', 1, 'overflow-today-2'), size: 'wide' },
      { ...widget('focus', 'focus', 2, 'overflow-today-2-2'), size: 'compact' },
      widget('calendar', 'calendar', 3, 'overflow-today-2-2-2'),
    ],
  )
  assert.deepEqual([...result.panelOrder], ['today', 'overflow-today-2'])
  assert.deepEqual([...result.widgets.filter(item => item.id !== 'calendar').map(item => item.panel)], ['today', 'today', 'today'])
  const todaySlots = widgetPages.widgetPages(result.widgets.filter(item => item.panel === 'today'), 2)[0]
  assert.deepEqual([...todaySlots.map(slot => [slot.widget.id, slot.row, slot.column, slot.rows, slot.columns])].map(slot => [...slot]), [
    ['media', 1, 1, 1, 1], ['weather', 2, 1, 1, 2], ['focus', 1, 2, 1, 1],
  ])
  const reloaded = fitPanelLayout(result.panels, result.panelOrder, result.widgets)
  assert.deepEqual([...reloaded.panelOrder], [...result.panelOrder])
  assert.deepEqual([...reloaded.widgets.map(item => item.panel)], [...result.widgets.map(item => item.panel)])
})

test('renamed overflow and disabled widgets remain user-owned', () => {
  const result = fitPanelLayout(
    { today: 'Today', 'overflow-today-2': 'Focus tools' },
    ['today', 'overflow-today-2'],
    [widget('weather', 'weather', 0, 'today'), widget('hidden', 'focus', 1, 'overflow-today-2', false)],
  )
  assert.equal(result.panels['overflow-today-2'], 'Focus tools')
  assert.equal(result.widgets.find(item => item.id === 'hidden')?.panel, 'overflow-today-2')
})

test('custom panels and orphaned widget assignments survive layout repair', () => {
  const result = fitPanelLayout(
    { today: 'Today', 'project-work': 'Project work' },
    ['project-work', 'today'],
    [widget('custom', 'notes', 0, 'project-work'), widget('recovered', 'ai', 1, 'older-space')],
  )
  assert.deepEqual([...result.panelOrder.slice(0, 2)], ['project-work', 'today'])
  assert.equal(result.panels['project-work'], 'Project work')
  assert.equal(result.widgets.find(item => item.id === 'recovered')?.panel, 'older-space')
  assert.ok(result.panels['older-space'], 'an orphaned panel ID receives a visible label')
})

test('empty generated overflow panels disappear after widgets move away', () => {
  const initial = fitPanelLayout(
    { today: 'Today' },
    ['today'],
    [widget('one', 'notes', 0, 'today'), widget('two', 'ai', 1, 'today'), widget('three', 'system', 2, 'today'), widget('four', 'media', 3, 'today'), widget('five', 'clock', 4, 'today')],
  )
  const overflow = initial.panelOrder.find(id => id.startsWith('overflow-'))
  assert.ok(overflow, 'the overfull panel creates a visible overflow page')

  const panels = { ...initial.panels, research: 'Research' }
  const movedWidgets = initial.widgets.map(item => item.id === 'five' ? { ...item, panel: 'research' } : item)
  const normalized = fitPanelLayout(panels, [...initial.panelOrder, 'research'], movedWidgets)
  assert.equal(normalized.panelOrder.includes(overflow), false, 'the now-empty generated page is removed')
  assert.equal(normalized.widgets.find(item => item.id === 'five')?.panel, 'research')
})

test('panels can be added, renamed, and removed without losing assigned widgets', () => {
  const start = fitPanelLayout(
    { today: 'Today', desk: 'Desk' },
    ['today', 'desk'],
    [widget('calendar', 'calendar', 0, 'today'), widget('notes', 'notes', 1, 'desk')],
  )
  const added = createPanelLayout(start, 'Research')
  const id = added.panelOrder.at(-1)
  assert.equal(added.panels[id], 'Research')
  const renamed = renamePanelLayout(added, id, 'Reading list')
  assert.equal(renamed.panels[id], 'Reading list')
  const removed = removePanelLayout(renamed, id)
  assert.equal(removed.panels[id], undefined)
  assert.equal(removed.panelOrder.includes(id), false)
  assert.deepEqual(removed.widgets.map(item => item.id).sort(), ['calendar', 'notes'])
})

test('a dropped widget keeps its explicit cell while neighbours flow around it', () => {
  const widgets = [
    { ...widget('focus', 'focus', 0, 'today'), slot: { row: 2, column: 1 } },
    widget('media', 'media', 1, 'today'),
    widget('notes', 'notes', 2, 'today'),
  ]
  const slots = widgetPages.widgetPages(widgets, 2)[0]
  assert.deepEqual([...slots.map(slot => [slot.widget.id, slot.row, slot.column])], [
    ['focus', 2, 1], ['media', 1, 1], ['notes', 1, 2],
  ])
})

test('invalid or conflicting dropped cells fall back to first-fit flow', () => {
  const stray = widgetPages.widgetPages([
    { ...widget('focus', 'focus', 0, 'today'), slot: { row: 9, column: 4 } },
    widget('media', 'media', 1, 'today'),
  ], 2)[0]
  assert.deepEqual([...stray.map(slot => [slot.widget.id, slot.row, slot.column])], [
    ['focus', 1, 1], ['media', 1, 2],
  ])
  const colliding = widgetPages.widgetPages([
    { ...widget('one', 'focus', 0, 'today'), slot: { row: 1, column: 1 } },
    { ...widget('two', 'notes', 1, 'today'), slot: { row: 1, column: 1 } },
  ], 2)[0]
  assert.deepEqual([...colliding.map(slot => [slot.widget.id, slot.row, slot.column])], [
    ['one', 1, 1], ['two', 1, 2],
  ])
})

test('same-size tiles trade cells on drop and unequal tiles refuse to swap', () => {
  const members = [
    { ...widget('media', 'media', 0, 'today'), size: 'compact' },
    { ...widget('focus', 'focus', 1, 'today'), size: 'compact' },
  ]
  const swapped = placement.swapWidgetCells(members, 'media', 'focus')
  assert.deepEqual([...swapped.map(item => [item.id, item.slot.row, item.slot.column])], [
    ['media', 1, 2], ['focus', 1, 1],
  ])
  assert.equal(placement.swapWidgetCells([
    { ...widget('media', 'media', 0, 'today'), size: 'compact' },
    widget('calendar', 'calendar', 1, 'today'),
  ], 'media', 'calendar'), null)
  assert.equal(placement.swapWidgetCells(members, 'media', 'missing'), null)
})

test('unsized legacy tiles trade flow order so their full-column look survives a drop', () => {
  const members = [widget('media', 'media', 0, 'today'), widget('weather', 'weather', 1, 'today')]
  const swapped = placement.swapWidgetCells(members, 'weather', 'media')
  assert.deepEqual([...swapped.map(item => [item.id, item.order, item.slot ?? null])], [
    ['media', 1, null], ['weather', 0, null],
  ])
  const ordered = [...swapped].sort((a, b) => a.order - b.order)
  const slots = widgetPages.widgetPages(ordered, 2)[0]
  assert.deepEqual([...slots.map(slot => [slot.widget.id, slot.row, slot.column, slot.rows])], [
    ['weather', 1, 1, 2], ['media', 1, 2, 2],
  ])
})

test('panel-tab drops pin to the first free cell and stray coordinates are clamped', () => {
  const members = [
    { ...widget('focus', 'focus', 0, 'today'), size: 'compact' },
    { ...widget('notes', 'notes', 1, 'today'), size: 'compact' },
  ]
  const free = placement.firstFreeCell(members)
  assert.equal(free.row, 2)
  assert.equal(free.column, 1)
  const moved = placement.placeWidgetAtCell([widget('media', 'media', 0, 'desk')], 'media', 'today', { row: 9, column: -3 })
  assert.equal(moved[0].panel, 'today')
  assert.equal(moved[0].slot.row, 2)
  assert.equal(moved[0].slot.column, 1)
  const cleared = placement.clearWidgetSlot(moved, 'media')
  assert.equal(cleared[0].slot, undefined)
  const fallback = placement.firstFreeCell([])
  assert.equal(fallback.row, 1)
  assert.equal(fallback.column, 1)
})
