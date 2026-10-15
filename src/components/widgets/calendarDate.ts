import type { CalendarEvent } from '../../lib/ipc'

export function dateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function parseDateKey(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

export function monthGrid(month: Date, weekStartsOn: 0 | 1 = 1): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const offset = (first.getDay() - weekStartsOn + 7) % 7
  const start = new Date(first)
  start.setDate(first.getDate() - offset)
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start)
    day.setDate(start.getDate() + index)
    return day
  })
}

export function eventsOnDay(events: CalendarEvent[], day: Date): CalendarEvent[] {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime()
  const selectedKey = dateKey(day)
  return events
    .filter((event) => {
      if (event.allDay) {
        // Imported iCalendar DTEND dates are exclusive; equal endpoints still
        // represent a single-day event in imperfect source calendars. Compare
        // UTC date components because ICS DATE values are parsed as UTC midnight.
        const utcDateKey = (value: number) => {
          const date = new Date(value)
          return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
        }
        const startKey = utcDateKey(event.start)
        const endKey = utcDateKey(event.end)
        return startKey <= selectedKey && (endKey <= startKey ? selectedKey === startKey : selectedKey < endKey)
      }
      return event.start < dayEnd && event.end >= dayStart
    })
    .sort((a, b) => a.start - b.start)
}

export function moveMonth(month: Date, delta: number): Date {
  return new Date(month.getFullYear(), month.getMonth() + delta, 1)
}
