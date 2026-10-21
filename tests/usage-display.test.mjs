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

test('durations, ages and token counts read naturally', () => {
  assert.equal(display.formatDuration(4200), '4.2s')
  assert.equal(display.formatDuration(95_000), '1m 35s')
  assert.equal(display.formatDuration(null), '-')
  assert.equal(display.agoLabel(1_000_000 - 5 * 60_000, 1_000_000), '5m ago')
  assert.equal(display.agoLabel(null), 'never')
  assert.equal(display.compactTokens(182_400), '182k')
  assert.equal(display.compactTokens(2_480_000), '2.5M')
})

test('providers are grouped in display order and installed-but-idle ones stay listed', () => {
  const activity = { installed: true, sessions24h: 0, sessions7d: 0, responses24h: 0, activeNow: false, activeSessions: 0, recent: [] }
  const groups = display.groupProviders([
    snapshot({ provider: 'gemini', label: 'Gemini CLI', source: 'local-logs', status: 'unknown', activity }),
    snapshot({ provider: 'codex', label: 'Codex · 5h', source: 'official-rate-limit', window: '5h', percent: 0.2 }),
    snapshot({ provider: 'claude-code', label: 'Claude Code', source: 'local-logs', activity }),
    snapshot({ provider: 'manual', label: 'Custom' }),
  ])
  assert.deepEqual(groups.map((g) => g.id), ['codex', 'claude-code', 'gemini'])
  assert.equal(groups[0].quota.length, 1)
  assert.equal(groups[2].activity.installed, true)
})

test('collapsed stats only show numbers that exist', () => {
  const withReplies = snapshot({ provider: 'claude-code', source: 'local-logs', activity: { installed: true, sessions24h: 1, sessions7d: 1, avgResponseMs: 4000, responses24h: 10, activeNow: true, activeSessions: 2, recent: [] } })
  assert.equal(display.compactStatValue('off', [withReplies]), null)
  assert.equal(display.compactStatValue('response-time', [withReplies]).value, '4.0s')
  assert.equal(display.compactStatValue('response-time', [snapshot()]), null)
  assert.equal(display.compactStatValue('active-count', [withReplies], 1).value, '2')
  assert.equal(display.compactStatValue('active-count', [], 3).value, '3')
  assert.equal(display.compactStatValue('usage-left', [snapshot({ source: 'official-rate-limit', percent: 0.3, window: '5h' })]).value, '70%')
  assert.equal(display.compactStatValue('usage-left', [withReplies]), null)
})
