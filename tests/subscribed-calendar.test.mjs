import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import ICAL from 'ical.js'
const source=await readFile(new URL('../src/lib/subscribedCalendar.ts',import.meta.url),'utf8')
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const exported={}
vm.runInNewContext(js,{exports:exported,require:()=>({default:ICAL}),Intl,Date,performance},{filename:'subscribedCalendar.ts'})
const {subscribedCalendar}=exported
const calendar=events=>`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Hover Island//EN\r\n${events.join('\r\n')}\r\nEND:VCALENDAR`
const event=lines=>`BEGIN:VEVENT\r\n${lines.join('\r\n')}\r\nEND:VEVENT`
const now=Date.UTC(2026,9,14)

test('calendar subscriptions honor recurrence exclusions and exceptions for the matching UID only',()=>{
 const text=calendar([
  event(['UID:work','DTSTART:20261014T100000Z','DTEND:20261014T110000Z','RRULE:FREQ=DAILY;COUNT=3','EXDATE:20261015T100000Z','SUMMARY:Daily work']),
  event(['UID:work','RECURRENCE-ID:20261016T100000Z','DTSTART:20261016T120000Z','DTEND:20261016T130000Z','SUMMARY:Moved work']),
  event(['UID:other','DTSTART:20261014T100000Z','DTEND:20261014T110000Z','RRULE:FREQ=DAILY;COUNT=3','SUMMARY:Other series']),
 ])
 const {events}=subscribedCalendar(text,'personal',now)
 assert.equal(events.length,5)
 const moved=events.find(item=>item.title==='Moved work')
 assert.equal(moved.start,Date.UTC(2026,9,16,12))
 assert.equal(events.filter(item=>item.title==='Other series').length,3)
 assert.ok(events.every(item=>item.id.startsWith('ics:personal:')))
})
test('calendar subscriptions preserve IANA timezones, floating times and exclusive all-day ends',()=>{
 const {events}=subscribedCalendar(calendar([
  event(['UID:india','DTSTART;TZID=Asia/Kolkata:20261014T153000','DTEND;TZID=Asia/Kolkata:20261014T163000','SUMMARY:Afternoon']),
  event(['UID:float','DTSTART:20261014T090000','DTEND:20261014T100000','SUMMARY:Local time']),
  event(['UID:day','DTSTART;VALUE=DATE:20261014','DTEND;VALUE=DATE:20261015','SUMMARY:All day']),
 ]),'test',now)
 assert.equal(events.find(item=>item.title==='Afternoon').start,Date.UTC(2026,9,14,10))
 assert.equal(events.find(item=>item.title==='Local time').start,new Date(2026,9,14,9).getTime())
 const day=events.find(item=>item.title==='All day')
 assert.equal(day.allDay,true)
 assert.equal(day.end,new Date(2026,9,15).getTime())
})
test('cancelled occurrences and expensive recurrence rules are skipped without fabricating alerts',()=>{
 const {events,warning}=subscribedCalendar(calendar([
  event(['UID:cancel','DTSTART:20261014T100000Z','DTEND:20261014T110000Z','RRULE:FREQ=DAILY;COUNT=2','SUMMARY:Keep']),
  event(['UID:cancel','RECURRENCE-ID:20261015T100000Z','DTSTART:20261015T100000Z','DTEND:20261015T110000Z','STATUS:CANCELLED','SUMMARY:Cancelled']),
  event(['UID:expensive','DTSTART:20261014T100000Z','RRULE:FREQ=SECONDLY','SUMMARY:Expensive']),
 ]),'test',now)
 assert.equal(events.length,1)
 assert.ok(warning)
 assert.throws(()=>subscribedCalendar('x'.repeat(2*1024*1024+1),'test',now),/larger/)
})
