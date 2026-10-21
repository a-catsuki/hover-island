import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/transferSpeed.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const exports = {}
vm.runInNewContext(js, { exports, module: { exports }, Number, Math, Map, Set })
const { formatBytes, formatSpeed, formatRemaining, percentOf, createSpeedTracker } = exports

test('byte and speed labels are short and human', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(4823011), '4.6 MB')
  assert.equal(formatBytes(NaN), '0 B')
  assert.equal(formatSpeed(2.5 * 1048576), '2.5 MB/s')
  assert.equal(formatSpeed(300), '', 'a trickle is not worth showing')
  assert.equal(formatSpeed(undefined), '')
  assert.equal(formatRemaining(2), 'a few seconds left')
  assert.equal(formatRemaining(30), '30 sec left')
  assert.equal(formatRemaining(600), '10 min left')
  assert.equal(formatRemaining(NaN), '')
  assert.equal(percentOf(50, 200), 25)
  assert.equal(percentOf(5, 0), 0)
  assert.equal(percentOf(500, 200), 100)
})

test('the speed tracker smooths samples, ignores bursts and resets when progress restarts', () => {
  const tracker = createSpeedTracker(400)
  assert.equal(tracker.sample('a', 0, 0), 0)
  assert.equal(tracker.sample('a', 1000, 100), 0, 'too soon to measure')
  assert.equal(tracker.sample('a', 1_000_000, 1000), 1_000_000, 'first real sample is the instantaneous speed')
  const next = tracker.sample('a', 3_000_000, 2000)
  assert.ok(next > 1_000_000 && next < 2_000_000, 'speed eases toward the new rate')
  assert.equal(tracker.sample('a', 10, 3000), 0, 'a restarted transfer starts over')
  tracker.sample('b', 0, 0)
  tracker.keep(['b'])
  assert.equal(tracker.sample('a', 100, 4000), 0, 'forgotten transfers start fresh')
})
