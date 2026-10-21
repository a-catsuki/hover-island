import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/onboardingConfig.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const tour = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('plan skips steps the layout cannot show', () => {
  const full = tour.planTour({ widgetKinds: ['media', 'weather'], tabCount: 3 }).map(s => s.id)
  assert.equal(full.length, tour.FIRST_RUN_STEP_COUNT)
  const bare = tour.planTour({ widgetKinds: [], tabCount: 1 }).map(s => s.id)
  assert.ok(!bare.includes('media') && !bare.includes('pages') && !bare.includes('widgets'))
  assert.equal(bare[0], 'pill')
})

test('shortcut text and keycaps', () => {
  assert.equal(tour.tourText('Press {open}', { open: 'Alt+Space', search: 'x' }), 'Press Alt+Space')
  assert.deepEqual(tour.shortcutKeys('Control+Shift+K'), ['Ctrl', 'Shift', 'K'])
})

test('caption sits below a collapsed pill and avoids the target', () => {
  const base = { viewport: { w: 960, h: 560 }, card: { w: 336, h: 150 } }
  const pill = tour.placeCaption({ ...base, island: { x: 320, y: 0, w: 320, h: 38 }, target: null, collapsed: true })
  assert.equal(pill.y, 52)
  const island = { x: 80, y: 0, w: 800, h: 560 }
  const left = tour.placeCaption({ ...base, island, target: { x: 96, y: 64, w: 380, h: 480 }, collapsed: false })
  assert.ok(left.x > 400)
})

test('spring converges', () => {
  let p = 0, v = 0
  for (let i = 0; i < 600; i++) [p, v] = tour.springStep(p, v, 100, 1 / 240, 150, tour.dampingFor(150, 0.8))
  assert.ok(Math.abs(p - 100) < 0.5)
})
