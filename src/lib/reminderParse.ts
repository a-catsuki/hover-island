/**
 * Natural-phrase parsing for reminders: "in 20 min call mom", "tomorrow 9am standup",
 * "at 6pm gym", "every weekday 10:00 stretch". Pure functions of (text, now) so they test
 * deterministically. `nextOccurrence` mirrors src-tauri/src/reminder_core.rs.
 */

export type RecurKind = 'daily' | 'weekdays' | 'weekly'

export interface Recur {
  kind: RecurKind
  hour: number
  minute: number
  /** 0 (Sunday) to 6, weekly only */
  weekday?: number
}

export interface ParsedReminder {
  title: string
  /** epoch ms of the first time it is due */
  due: number
  recur?: Recur
  important: boolean
  /** the time words that were understood, for echoing back to the user */
  matched: string
  /** the asked-for time was earlier than now (a fixed day was given) */
  past: boolean
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAY_PATTERN = '(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)'
const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

function weekdayIndex(word: string): number {
  const key = word.slice(0, 3).toLowerCase()
  return DAY_NAMES.findIndex((name) => name.startsWith(key))
}

/** The first local `hour:minute` after `after` that matches the pattern. DST-safe: built from local dates. */
export function nextOccurrence(recur: Recur, after: number): number {
  const base = new Date(after)
  for (let step = 0; step <= 14; step++) {
    const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + step, recur.hour, recur.minute, 0, 0)
    const dow = date.getDay()
    const fits = recur.kind === 'daily' || (recur.kind === 'weekdays' && dow >= 1 && dow <= 5) || (recur.kind === 'weekly' && dow === (recur.weekday ?? 1))
    if (fits && date.getTime() > after) return date.getTime()
  }
  return after + DAY
}

function startOfDay(time: number, plusDays = 0): Date {
  const date = new Date(time)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + plusDays, 0, 0, 0, 0)
}

interface Clock { hour: number; minute: number; explicitMeridiem: boolean; bare: boolean }

function cleanTitle(text: string): string {
  let out = text.replace(/\s+/g, ' ').trim()
  for (let i = 0; i < 3; i++) {
    out = out
      .replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '')
      .replace(/^(?:to|at|on|in|for|about|that|and|then)\s+/i, '')
      .replace(/\s+(?:at|on|in|by|for|to|and|then|every|from|this|next)$/i, '')
      .trim()
  }
  return out.charAt(0).toUpperCase() + out.slice(1)
}

/** Take the first match of `pattern` out of `text`; returns the match and the remaining text. */
function take(text: string, pattern: RegExp): { match: RegExpExecArray | null; rest: string } {
  const match = pattern.exec(text)
  if (!match) return { match: null, rest: text }
  return { match, rest: `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}` }
}

function unitMs(unit: string): number {
  const u = unit.toLowerCase()
  if (u.startsWith('s')) return 1000
  if (u.startsWith('h')) return HOUR
  if (u.startsWith('d')) return DAY
  if (u.startsWith('w')) return 7 * DAY
  return MINUTE
}

export function parseReminder(input: string, now: number = Date.now()): ParsedReminder | null {
  let text = ` ${input.replace(/\s+/g, ' ').trim()} `
  if (!text.trim()) return null
  const matched: string[] = []

  // Lead-ins like "remind me to".
  text = text.replace(/^\s*(?:please\s+)?(?:remind\s+me(?:\s+(?:to|about|that|of))?|reminder\s*(?::|to|-)?|set\s+(?:a\s+)?reminder\s+(?:to|for)?)\s+/i, ' ')

  let important = false
  if (/(^|\s)!+(\s|$)|!\s*$|\b(?:important|urgent)\b/i.test(text)) {
    important = true
    text = text.replace(/(^|\s)!+(?=\s|$)|!+\s*$|\b(?:important|urgent)\b:?/gi, ' ')
  }

  // "in 20 min", "after 2 hours", "in an hour", "in half an hour".
  const relative = take(text, /\b(?:in|after|within)\s+(\d+(?:\.\d+)?|an?|half\s+an?|one|two|three|four|five)\s*(seconds?|secs?|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\b/i)
  if (relative.match) {
    const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 }
    const raw = relative.match[1].toLowerCase().replace(/\s+/g, ' ')
    const amount = raw.startsWith('half') ? 0.5 : words[raw] ?? Number(raw)
    const ms = Math.round(amount * unitMs(relative.match[2]))
    if (Number.isFinite(ms) && ms > 0 && ms <= 400 * DAY) {
      return {
        title: cleanTitle(relative.rest) || 'Reminder',
        due: Math.round((now + ms) / 1000) * 1000,
        important,
        matched: relative.match[0].trim(),
        past: false,
      }
    }
  }

  // Repeats.
  let recur: Recur | undefined
  let recurKind: RecurKind | undefined
  let recurWeekday: number | undefined
  const every = take(text, new RegExp(`\\b(?:on\\s+)?(?:every\\s+(day|weekday|weekdays|week|${DAY_PATTERN})s?|daily|weekdays|weekly)\\b`, 'i'))
  if (every.match) {
    const whole = every.match[0].toLowerCase()
    const named = every.match[1]?.toLowerCase()
    if (named && named !== 'day' && named !== 'weekday' && named !== 'weekdays' && named !== 'week') {
      recurKind = 'weekly'
      recurWeekday = weekdayIndex(named)
    } else if (named === 'weekday' || named === 'weekdays' || whole.includes('weekdays')) recurKind = 'weekdays'
    else if (named === 'week' || whole.includes('weekly')) recurKind = 'weekly'
    else recurKind = 'daily'
    text = every.rest
    matched.push(every.match[0].trim())
  }

  // Time of day.
  let clock: Clock | null = null
  const hhmm = take(text, /\b(?:at\s+|@\s*)?(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?(?![\d:])/i)
  const hourOnly = hhmm.match ? { match: null, rest: text } : take(text, /\b(?:at\s+|@\s*)?(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/i)
  const bareAt = hhmm.match || hourOnly.match ? { match: null, rest: text } : take(text, /\b(?:at|@)\s*(\d{1,2})(?![\d:])(?!\s*(?:st|nd|rd|th)\b)/i)
  if (hhmm.match) {
    const meridiem = hhmm.match[3]?.toLowerCase().replace(/\./g, '')
    clock = { hour: Number(hhmm.match[1]), minute: Number(hhmm.match[2]), explicitMeridiem: !!meridiem, bare: !meridiem }
    if (meridiem) clock.hour = to24(clock.hour, meridiem)
    text = hhmm.rest
    matched.push(hhmm.match[0].trim())
  } else if (hourOnly.match) {
    const meridiem = hourOnly.match[2].toLowerCase().replace(/\./g, '')
    clock = { hour: to24(Number(hourOnly.match[1]), meridiem), minute: 0, explicitMeridiem: true, bare: false }
    text = hourOnly.rest
    matched.push(hourOnly.match[0].trim())
  } else if (bareAt.match) {
    clock = { hour: Number(bareAt.match[1]), minute: 0, explicitMeridiem: false, bare: true }
    text = bareAt.rest
    matched.push(bareAt.match[0].trim())
  } else {
    const word = take(text, /\b(noon|midday|midnight)\b/i)
    if (word.match) {
      clock = { hour: /midnight/i.test(word.match[1]) ? 0 : 12, minute: 0, explicitMeridiem: true, bare: false }
      text = word.rest
      matched.push(word.match[0].trim())
    }
  }
  if (clock && (clock.hour > 23 || clock.minute > 59)) return null

  // Day words.
  let dayOffset: number | null = null
  let weekdayTarget: number | null = null
  let dateTarget: Date | null = null
  let dayWordGivesTime: Clock | null = null
  if (!recurKind) {
    const rel = take(text, /\b(day after tomorrow|tomorrow|tmrw|tmr|today|tonight)\b/i)
    if (rel.match) {
      const word = rel.match[1].toLowerCase()
      dayOffset = word === 'day after tomorrow' ? 2 : word.startsWith('t') && word !== 'today' && word !== 'tonight' ? 1 : 0
      if (word === 'tonight') dayWordGivesTime = { hour: 20, minute: 0, explicitMeridiem: true, bare: false }
      text = rel.rest
      matched.push(rel.match[0].trim())
    } else {
      const named = take(text, new RegExp(`\\b(?:on\\s+|next\\s+|this\\s+)?${DAY_PATTERN}\\b`, 'i'))
      if (named.match) {
        weekdayTarget = weekdayIndex(named.match[1])
        text = named.rest
        matched.push(named.match[0].trim())
      } else {
        const monthPattern = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
        const md = take(text, new RegExp(`\\b(?:on\\s+)?${monthPattern}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'))
        const dm = md.match ? { match: null as RegExpExecArray | null, rest: text } : take(text, new RegExp(`\\b(?:on\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${monthPattern}\\b`, 'i'))
        const found = md.match ?? dm.match
        if (found) {
          const month = MONTHS.indexOf((md.match ? found[1] : found[2]).slice(0, 3).toLowerCase())
          const day = Number(md.match ? found[2] : found[1])
          const year = new Date(now).getFullYear()
          let date = new Date(year, month, day)
          if (date.getMonth() !== month) return null
          if (startOfDay(date.getTime()).getTime() < startOfDay(now).getTime()) date = new Date(year + 1, month, day)
          dateTarget = date
          text = md.match ? md.rest : dm.rest
          matched.push(found[0].trim())
        }
      }
    }
  }

  // Part-of-day words only help when no clock time was given.
  if (!clock && !dayWordGivesTime) {
    const part = take(text, /\b(?:this\s+)?(morning|afternoon|evening)\b/i)
    if (part.match) {
      const hours: Record<string, number> = { morning: 9, afternoon: 15, evening: 18 }
      dayWordGivesTime = { hour: hours[part.match[1].toLowerCase()], minute: 0, explicitMeridiem: true, bare: false }
      text = part.rest
      matched.push(part.match[0].trim())
    }
  }

  const hasDay = dayOffset !== null || weekdayTarget !== null || dateTarget !== null
  if (!clock && !dayWordGivesTime && !hasDay && !recurKind) return null

  const title = cleanTitle(text) || 'Reminder'
  const today = startOfDay(now)

  if (recurKind) {
    const chosen = clock ?? dayWordGivesTime ?? { hour: 9, minute: 0, explicitMeridiem: true, bare: false }
    const hour = chosen.bare ? guessHour(chosen.hour, true) : chosen.hour
    recur = { kind: recurKind, hour, minute: chosen.minute }
    if (recurKind === 'weekly') recur.weekday = recurWeekday ?? new Date(now).getDay()
    return { title, due: nextOccurrence(recur, now), recur, important, matched: matched.join(' '), past: false }
  }

  const chosen = clock ?? dayWordGivesTime ?? { hour: 9, minute: 0, explicitMeridiem: true, bare: false }
  let day: Date
  if (dayOffset !== null) day = startOfDay(now, dayOffset)
  else if (dateTarget) day = dateTarget
  else if (weekdayTarget !== null) {
    let delta = (weekdayTarget - today.getDay() + 7) % 7
    if (delta === 0) delta = 7
    day = startOfDay(now, delta)
  } else day = today

  const at = (hour: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, chosen.minute, 0, 0).getTime()
  let due: number
  if (chosen.bare) {
    if (hasDay) due = at(guessHour(chosen.hour, true))
    else {
      // "at 6" with no day: whichever of 6 AM / 6 PM comes next.
      const options = chosen.hour >= 13 || chosen.hour === 0 ? [chosen.hour] : [chosen.hour % 12, (chosen.hour % 12) + 12]
      const future = options.map(at).filter((time) => time > now)
      due = future.length ? Math.min(...future) : at(options[0]) + DAY
    }
  } else {
    due = at(chosen.hour)
  }
  let past = false
  if (due <= now) {
    if (!hasDay) {
      const tomorrow = new Date(due)
      tomorrow.setDate(tomorrow.getDate() + 1)
      due = tomorrow.getTime()
    } else past = true
  }
  return { title, due, important, matched: matched.join(' '), past }
}

function to24(hour: number, meridiem: string): number {
  const pm = meridiem.startsWith('p')
  if (hour === 12) return pm ? 12 : 0
  return pm ? hour + 12 : hour
}

/** A bare hour with a named day: 1 to 6 reads as the afternoon, 7 to 11 as the morning, 12 as noon. */
function guessHour(hour: number, withDay: boolean): number {
  if (hour >= 13 || hour === 0) return hour
  if (hour === 12) return 12
  return withDay && hour <= 6 ? hour + 12 : hour
}

/** True when the text holds something that can become a reminder (a time, a day or a repeat). */
export function hasTimePattern(text: string, now: number = Date.now()): boolean {
  return parseReminder(text, now) !== null
}

/** Notes worth offering as reminders: lines that say "remind me ..." or contain a time. */
export function isReminderCandidate(text: string, now: number = Date.now()): boolean {
  if (/\bremind(?:er)?\b/i.test(text)) return parseReminder(text, now) !== null
  return parseReminder(text, now) !== null
}

/* ---------------------------------------------------------------- display */

function sameDay(a: number, b: number): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime()
}

export function timeLabel(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** "in 18 min", "in 2h 10m", "Today 6:00 PM", "Tomorrow 9:00 AM", "Fri 9:00 AM", "Oct 25, 9:00 AM". */
export function formatDue(due: number, now: number = Date.now()): string {
  const diff = due - now
  if (diff <= -MINUTE) {
    const late = Math.round(-diff / MINUTE)
    if (late < 60) return `${late} min late`
    if (late < 24 * 60) return `${Math.floor(late / 60)}h late`
    return `${Math.floor(late / 1440)}d late`
  }
  if (diff < MINUTE) return 'Now'
  const minutes = Math.round(diff / MINUTE)
  if (minutes < 60) return `in ${minutes} min`
  if (diff < 6 * HOUR) {
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return m ? `in ${h}h ${m}m` : `in ${h}h`
  }
  if (sameDay(due, now)) return `Today ${timeLabel(due)}`
  if (sameDay(due, now + DAY)) return `Tomorrow ${timeLabel(due)}`
  if (due - now < 6 * DAY) return `${DAY_SHORT[new Date(due).getDay()]} ${timeLabel(due)}`
  const date = new Date(due)
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${timeLabel(due)}`
}

export function describeRecur(recur: Recur): string {
  const time = timeLabel(new Date(2000, 0, 1, recur.hour, recur.minute).getTime())
  if (recur.kind === 'daily') return `Every day ${time}`
  if (recur.kind === 'weekdays') return `Weekdays ${time}`
  const name = DAY_NAMES[recur.weekday ?? 1]
  return `Every ${name.charAt(0).toUpperCase()}${name.slice(1)} ${time}`
}
