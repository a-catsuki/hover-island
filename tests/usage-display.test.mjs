import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/usageDisplay.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const display = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

const snapshot = (overrides = {}) => ({ provider: 'codex', label: 'Codex', status: 'ok', updatedAt: 1_000_000, ...overrides })

test('remaining quota clamps and preserves unknown or non-OK reports', () => {
  assert.equal(display.remainingPercent(snapshot({ percent: 0 })), 100)
  assert.equal(display.remainingPercent(snapshot({ percent: 0.25 })), 75)
  assert.equal(display.remainingPercent(snapshot({ percent: 1 })), 0)
  assert.equal(display.remainingPercent(snapshot({ used: 13, limit: 10 })), 0)
  assert.equal(display.remainingPercent(snapshot({ used: 2, limit: 0 })), null)
  assert.equal(display.remainingPercent(snapshot({ status: 'unknown', percent: 0.2 })), null)
  assert.equal(display.remainingPercent(snapshot({ percent: Number.NaN })), null)
})

test('window names and reset timestamps stay explicit at boundary conditions', () => {
  assert.equal(display.windowLabel('168h'), 'Weekly')
  assert.equal(display.windowLabel('5h'), '5-hour')
  assert.equal(display.windowLabel('month'), 'month')
  assert.equal(display.resetCountdown(2_000_000, 2_000_000), 'Reset due · refresh report')
  assert.equal(display.resetCountdown(2_059_000, 2_000_000), 'Resets in 1m')
  assert.equal(display.resetCountdown(null, 2_000_000), 'Reset time unavailable')
  assert.equal(display.resetTimeLabel(Number.NaN), null)
  assert.match(display.resetTimeLabel(2_000_000), /Jan|Dec/)
})

test('report age and staleness are measured from the report, not from expected reset', () => {
  assert.equal(display.reportAge(1_000_000, 1_000_000), 'Reported just now')
  assert.equal(display.reportAge(1_000_000, 1_060_000), 'Reported 1m ago')
  assert.equal(display.isReportStale(1_000_000, 1_900_001), true)
  assert.equal(display.isReportStale(1_000_000, 1_900_000), false)
  assert.equal(display.isReportStale(null, 1_000_000), true)
})
