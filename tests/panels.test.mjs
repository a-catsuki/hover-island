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

const widget = (id, kind, order, panel, enabled = true) => ({ id, kind, order, panel, enabled })

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
    assert.equal(widgetPages.widgetPages(items, 1).length, 1, `${panelId} has no nested page`)
  }
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
    [widget('one', 'notes', 0, 'today'), widget('two', 'ai', 1, 'today'), widget('three', 'system', 2, 'today')],
  )
  const overflow = initial.panelOrder.find(id => id.startsWith('overflow-'))
  assert.ok(overflow, 'the overfull panel creates a visible overflow page')

  const panels = { ...initial.panels, research: 'Research' }
  const movedWidgets = initial.widgets.map(item => item.id === 'three' ? { ...item, panel: 'research' } : item)
  const normalized = fitPanelLayout(panels, [...initial.panelOrder, 'research'], movedWidgets)
  assert.equal(normalized.panelOrder.includes(overflow), false, 'the now-empty generated page is removed')
  assert.equal(normalized.widgets.find(item => item.id === 'three')?.panel, 'research')
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
