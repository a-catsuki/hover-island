import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/components/widgets/calendarDate.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const calendar = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('month grid is Monday-first, fixed at six weeks, and month navigation handles year edges', () => {
  const days = calendar.monthGrid(new Date(2026, 9, 1))
  assert.equal(days.length, 42)
  assert.equal(days[0].getDay(), 1)
  assert.equal(calendar.dateKey(days[0]), '2026-09-28')
  assert.equal(calendar.dateKey(days[41]), '2026-11-08')
  assert.equal(calendar.dateKey(calendar.moveMonth(new Date(2026, 11, 1), 1)), '2027-01-01')
})

test('selected-day agenda includes spanning events and honors exclusive all-day ICS end dates', () => {
  const day = new Date(2026, 9, 13)
  const events = [
    { id: 'local:spans', title: 'Spans midnight', start: new Date(2026, 9, 12, 23).getTime(), end: new Date(2026, 9, 13, 1).getTime(), allDay: false },
    { id: 'ics:holiday', title: 'Holiday', start: Date.UTC(2026, 9, 13), end: Date.UTC(2026, 9, 14), allDay: true },
    { id: 'ics:next', title: 'Next day', start: Date.UTC(2026, 9, 14), end: Date.UTC(2026, 9, 15), allDay: true },
  ]
  assert.deepEqual(calendar.eventsOnDay(events, day).map(({ id }) => id), ['local:spans', 'ics:holiday'])
  assert.deepEqual(calendar.eventsOnDay(events, new Date(2026, 9, 14)).map(({ id }) => id), ['ics:next'])
})
