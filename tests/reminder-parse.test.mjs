import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

async function importTs(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
}

const { parseReminder, nextOccurrence, formatDue, describeRecur, hasTimePattern } = await importTs('../src/lib/reminderParse.ts')

// Tuesday 20 October 2026, 3:00 PM local time. Built from local fields so the test holds in any time zone.
const NOW = new Date(2026, 9, 20, 15, 0, 0, 0).getTime()
const at = (day, hour, minute = 0, month = 9) => new Date(2026, month, day, hour, minute, 0, 0).getTime()
const parse = (text) => parseReminder(text, NOW)

test('relative phrases count from now and keep the rest as the title', () => {
  const a = parse('in 20 min call mom')
  assert.equal(a.title, 'Call mom')
  assert.equal(a.due, NOW + 20 * 60_000)
  assert.equal(parse('call mom in 2 hours').due, NOW + 2 * 3_600_000)
  assert.equal(parse('in an hour stretch').due, NOW + 3_600_000)
  assert.equal(parse('in half an hour tea').due, NOW + 30 * 60_000)
  assert.equal(parse('remind me to submit report in 3 days').title, 'Submit report')
  assert.equal(parse('in 5m check oven').due, NOW + 5 * 60_000)
})

test('tomorrow and weekday names resolve to the right day and time', () => {
  const t = parse('tomorrow 9am standup')
  assert.equal(t.title, 'Standup')
  assert.equal(t.due, at(21, 9))
  assert.equal(parse('tomorrow at 6:30pm dinner').due, at(21, 18, 30))
  assert.equal(parse('friday 2pm dentist').due, at(23, 14))
  assert.equal(parse('next monday 8:15 am review').due, at(26, 8, 15))
  assert.equal(parse('call bank tomorrow morning').due, at(21, 9))
  assert.equal(parse('day after tomorrow noon lunch').due, at(22, 12))
  assert.equal(parse('tonight take out the bins').due, at(20, 20))
})

test('a plain clock time lands on the next time it happens', () => {
  assert.equal(parse('at 6pm gym').due, at(20, 18))
  assert.equal(parse('at 6pm gym').title, 'Gym')
  assert.equal(parse('at 2pm call').due, at(21, 14)) // 2 PM already passed today
  assert.equal(parse('18:45 train').due, at(20, 18, 45))
  assert.equal(parse('at 5 water plants').due, at(20, 17)) // 5 AM is gone, 5 PM is next
  assert.equal(parse('at 7 coffee').due, at(20, 19)) // 7 PM is the next 7 o'clock
  assert.equal(parse('midnight backup').due, at(21, 0))
})

test('dates by month name work and roll to next year when past', () => {
  assert.equal(parse('oct 25 7pm party').due, at(25, 19))
  assert.equal(parse('on 3 nov 10:00 flight').due, at(3, 10, 0, 10))
  const rolled = parse('oct 1 9am renew')
  assert.equal(new Date(rolled.due).getFullYear(), 2027)
})

test('repeats: daily, weekdays and weekly', () => {
  const w = parse('every weekday 10:00 stretch')
  assert.equal(w.title, 'Stretch')
  assert.deepEqual(w.recur, { kind: 'weekdays', hour: 10, minute: 0 })
  assert.equal(w.due, at(21, 10))
  const d = parse('every day at 8pm journal')
  assert.deepEqual(d.recur, { kind: 'daily', hour: 20, minute: 0 })
  assert.equal(d.due, at(20, 20))
  const m = parse('every monday 9am planning')
  assert.deepEqual(m.recur, { kind: 'weekly', hour: 9, minute: 0, weekday: 1 })
  assert.equal(m.due, at(26, 9))
  assert.equal(parse('daily vitamins').recur.hour, 9)
  assert.equal(parse('weekdays 7:30 run').recur.kind, 'weekdays')
})

test('important markers are stripped from the title', () => {
  const p = parse('in 10 min submit form !')
  assert.equal(p.important, true)
  assert.equal(p.title, 'Submit form')
  assert.equal(parse('urgent: tomorrow 8am pay rent').important, true)
  assert.equal(parse('tomorrow 8am pay rent').important, false)
})

test('text without a time is not a reminder', () => {
  assert.equal(parse('buy milk'), null)
  assert.equal(parse('   '), null)
  assert.equal(parse('finish 3 chapters'), null)
  assert.equal(hasTimePattern('remind me to call dad at 5pm', NOW), true)
  assert.equal(hasTimePattern('read chapter 4', NOW), false)
})

test('a fixed day that has passed is flagged instead of silently moved', () => {
  const p = parse('today 9am email')
  assert.equal(p.past, true)
})

test('nextOccurrence skips weekends and honours the weekday', () => {
  const friday = at(23, 15)
  assert.equal(nextOccurrence({ kind: 'weekdays', hour: 10, minute: 0 }, friday), at(26, 10))
  assert.equal(nextOccurrence({ kind: 'weekly', hour: 9, minute: 30, weekday: 5 }, NOW), at(23, 9, 30))
  assert.equal(nextOccurrence({ kind: 'daily', hour: 15, minute: 0 }, NOW), at(21, 15))
})

test('relative labels read naturally', () => {
  assert.equal(formatDue(NOW + 18 * 60_000, NOW), 'in 18 min')
  assert.equal(formatDue(NOW + 130 * 60_000, NOW), 'in 2h 10m')
  assert.match(formatDue(at(21, 9), NOW), /^Tomorrow /)
  assert.match(formatDue(at(20, 22), NOW), /^Today /)
  assert.match(formatDue(at(23, 9), NOW), /^Fri /)
  assert.equal(formatDue(NOW - 5 * 60_000, NOW), '5 min late')
  assert.equal(formatDue(NOW + 10_000, NOW), 'Now')
  assert.match(describeRecur({ kind: 'weekdays', hour: 10, minute: 0 }), /^Weekdays /)
  assert.match(describeRecur({ kind: 'weekly', hour: 9, minute: 0, weekday: 1 }), /^Every Monday /)
})
