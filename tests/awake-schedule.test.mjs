import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

async function importTs(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
}

const s = await importTs('../src/lib/awakeSchedule.ts')

/** Deterministic generator (mulberry32). */
function seeded(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NOW = new Date(2026, 9, 20, 23, 30, 0, 0).getTime()

test('delays stay inside each intensity range and hit both ends with extreme rng values', () => {
  for (const info of s.INTENSITIES) {
    const rng = seeded(11)
    for (let i = 0; i < 300; i++) {
      const ms = s.nextDelayMs(info.id, rng)
      assert.ok(ms >= info.minMinutes * 60_000 && ms <= info.maxMinutes * 60_000, `${info.id} ${ms}`)
      assert.equal(ms % 1000, 0)
    }
    assert.equal(s.nextDelayMs(info.id, () => 0), info.minMinutes * 60_000)
    assert.equal(s.nextDelayMs(info.id, () => 0.999999999), info.maxMinutes * 60_000)
  }
})

test('the same seed gives the same alarm plan and stronger intensity gives more alarms', () => {
  const end = NOW + 3 * 3_600_000
  const a = s.planAlarms(NOW, end, 'medium', seeded(5))
  const b = s.planAlarms(NOW, end, 'medium', seeded(5))
  assert.deepEqual(a, b)
  assert.ok(a.every((time, i) => time > (a[i - 1] ?? NOW)))
  assert.ok(a.at(-1) <= end - s.FINAL_GUARD_MS)
  const gentle = s.planAlarms(NOW, end, 'gentle', seeded(5)).length
  const relentless = s.planAlarms(NOW, end, 'relentless', seeded(5)).length
  assert.ok(gentle < a.length && a.length < relentless, `${gentle} ${a.length} ${relentless}`)
})

test('no alarm is planned right before the end', () => {
  assert.equal(s.planNextAlarm(NOW, NOW + 30_000, 'relentless', () => 0), null)
  assert.notEqual(s.planNextAlarm(NOW, NOW + 3_600_000, 'gentle', () => 0), null)
})

test('escalation gets louder in steps and caps at full volume', () => {
  assert.equal(s.escalationLevel(0, 40), 0)
  assert.equal(s.escalationLevel(39_000, 40), 0)
  assert.equal(s.escalationLevel(41_000, 40), 1)
  assert.equal(s.escalationLevel(10 * 60_000, 40), s.MAX_LEVEL)
  assert.ok(s.escalatedVolume(0.4, 2) > s.escalatedVolume(0.4, 1))
  assert.equal(s.escalatedVolume(0.9, 4), 1)
})

test('end time chips pick the next matching clock time', () => {
  // 23:30: "until 2 AM" is the next day, "+1h" is exactly an hour out.
  assert.equal(s.chipEnd('until-2', NOW), new Date(2026, 9, 21, 2, 0).getTime())
  assert.equal(s.chipEnd('until-4', NOW), new Date(2026, 9, 21, 4, 0).getTime())
  assert.equal(s.chipEnd('sunrise', NOW), new Date(2026, 9, 21, 6, 0).getTime())
  assert.equal(s.chipEnd('sunrise', NOW, { hour: 5, minute: 41 }), new Date(2026, 9, 21, 5, 41).getTime())
  assert.equal(s.chipEnd('plus-1h', NOW), NOW + 3_600_000)
  assert.equal(s.chipEnd('plus-2h', NOW), NOW + 7_200_000)
  // At 01:00 "until 2 AM" is the same night.
  const late = new Date(2026, 9, 21, 1, 0).getTime()
  assert.equal(s.chipEnd('until-2', late), new Date(2026, 9, 21, 2, 0).getTime())
})

test('time input parsing and validation', () => {
  assert.deepEqual(s.parseTimeInput('02:05'), { hour: 2, minute: 5 })
  assert.equal(s.parseTimeInput('25:00'), null)
  assert.equal(s.parseTimeInput('nope'), null)
  assert.equal(s.validateEnd(NOW + 30_000, NOW) !== null, true)
  assert.equal(s.validateEnd(NOW + 3_600_000, NOW), null)
  assert.equal(s.validateEnd(NOW + 20 * 3_600_000, NOW) !== null, true)
})

test('urgency rises towards the end and the glyph morphs from coffee to lightning to sun', () => {
  const start = NOW
  const end = NOW + 6 * 3_600_000
  assert.ok(s.urgency(start, start, end) < s.urgency(start + 3 * 3_600_000, start, end))
  assert.ok(s.urgency(end - 60_000, start, end) > 0.9)
  assert.equal(s.glyphFor(start, start, end), 'coffee')
  assert.equal(s.glyphFor(start + 4 * 3_600_000, start, end), 'zap')
  assert.equal(s.glyphFor(end - 5 * 60_000, start, end), 'sun')
})

test('formatting', () => {
  assert.equal(s.formatRemaining(3_725_000), '1:02:05')
  assert.equal(s.formatRemaining(65_000), '1:05')
  assert.equal(s.formatLeft(95 * 60_000), '1h 35m left')
  assert.equal(s.formatLeft(10_000), 'Under a minute')
})

test('session state machine: alarm, escalate, confirm, snooze, finish', () => {
  const rng = () => 0 // shortest gaps
  const end = NOW + 60 * 60_000
  const session = s.createSession(NOW, end, 'medium', rng)
  assert.equal(session.nextAlarm, NOW + 2 * 60_000)
  assert.equal(s.stepSession(session, NOW + 60_000), null)
  const first = s.stepSession(session, NOW + 2 * 60_000)
  assert.deepEqual(first, { type: 'alarm', seq: 1, level: 0, volumeScale: 1 })
  assert.equal(session.pendingSince, NOW + 2 * 60_000)
  // Unanswered: repeats louder after the confirm window (40 s for medium).
  assert.equal(s.stepSession(session, NOW + 2 * 60_000 + 39_000), null)
  const second = s.stepSession(session, NOW + 2 * 60_000 + 40_000)
  assert.equal(second.level, 1)
  assert.ok(second.volumeScale > 1)
  // Confirming schedules the next random alarm.
  s.confirmSession(session, NOW + 3 * 60_000, 0, rng)
  assert.equal(session.pendingSince, null)
  assert.equal(session.nextAlarm, NOW + 5 * 60_000)
  // Snooze pushes it out.
  s.confirmSession(session, NOW + 3 * 60_000, 10, rng)
  assert.equal(session.nextAlarm, NOW + 13 * 60_000)
  // Snooze past the end drops the alarm; the finish still comes.
  s.confirmSession(session, end - 60_000, 10, rng)
  assert.equal(session.nextAlarm, null)
  assert.deepEqual(s.stepSession(session, end), { type: 'finish' })
})
