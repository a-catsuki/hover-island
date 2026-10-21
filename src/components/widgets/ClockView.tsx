import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { ChevronLeft, ChevronRight, Plus, Search, X } from 'lucide-solid'
import './ClockView.css'
import { clockTime } from '../../lib/clockDisplay'

type ClockStyle = 'analog' | 'digital'

interface ClockViewProps {
  style?: ClockStyle
}

interface CityOption {
  id: string
  city: string
  country: string
  flag: string
  zone: string
}

/** Curated world cities across many countries and time zones. */
const CITIES: CityOption[] = [
  { id: 'new-york', city: 'New York', country: 'United States', flag: '🇺🇸', zone: 'America/New_York' },
  { id: 'los-angeles', city: 'Los Angeles', country: 'United States', flag: '🇺🇸', zone: 'America/Los_Angeles' },
  { id: 'chicago', city: 'Chicago', country: 'United States', flag: '🇺🇸', zone: 'America/Chicago' },
  { id: 'honolulu', city: 'Honolulu', country: 'United States', flag: '🇺🇸', zone: 'Pacific/Honolulu' },
  { id: 'toronto', city: 'Toronto', country: 'Canada', flag: '🇨🇦', zone: 'America/Toronto' },
  { id: 'vancouver', city: 'Vancouver', country: 'Canada', flag: '🇨🇦', zone: 'America/Vancouver' },
  { id: 'mexico-city', city: 'Mexico City', country: 'Mexico', flag: '🇲🇽', zone: 'America/Mexico_City' },
  { id: 'sao-paulo', city: 'São Paulo', country: 'Brazil', flag: '🇧🇷', zone: 'America/Sao_Paulo' },
  { id: 'buenos-aires', city: 'Buenos Aires', country: 'Argentina', flag: '🇦🇷', zone: 'America/Argentina/Buenos_Aires' },
  { id: 'bogota', city: 'Bogotá', country: 'Colombia', flag: '🇨🇴', zone: 'America/Bogota' },
  { id: 'london', city: 'London', country: 'United Kingdom', flag: '🇬🇧', zone: 'Europe/London' },
  { id: 'dublin', city: 'Dublin', country: 'Ireland', flag: '🇮🇪', zone: 'Europe/Dublin' },
  { id: 'lisbon', city: 'Lisbon', country: 'Portugal', flag: '🇵🇹', zone: 'Europe/Lisbon' },
  { id: 'paris', city: 'Paris', country: 'France', flag: '🇫🇷', zone: 'Europe/Paris' },
  { id: 'madrid', city: 'Madrid', country: 'Spain', flag: '🇪🇸', zone: 'Europe/Madrid' },
  { id: 'berlin', city: 'Berlin', country: 'Germany', flag: '🇩🇪', zone: 'Europe/Berlin' },
  { id: 'amsterdam', city: 'Amsterdam', country: 'Netherlands', flag: '🇳🇱', zone: 'Europe/Amsterdam' },
  { id: 'brussels', city: 'Brussels', country: 'Belgium', flag: '🇧🇪', zone: 'Europe/Brussels' },
  { id: 'zurich', city: 'Zürich', country: 'Switzerland', flag: '🇨🇭', zone: 'Europe/Zurich' },
  { id: 'rome', city: 'Rome', country: 'Italy', flag: '🇮🇹', zone: 'Europe/Rome' },
  { id: 'vienna', city: 'Vienna', country: 'Austria', flag: '🇦🇹', zone: 'Europe/Vienna' },
  { id: 'stockholm', city: 'Stockholm', country: 'Sweden', flag: '🇸🇪', zone: 'Europe/Stockholm' },
  { id: 'oslo', city: 'Oslo', country: 'Norway', flag: '🇳🇴', zone: 'Europe/Oslo' },
  { id: 'helsinki', city: 'Helsinki', country: 'Finland', flag: '🇫🇮', zone: 'Europe/Helsinki' },
  { id: 'warsaw', city: 'Warsaw', country: 'Poland', flag: '🇵🇱', zone: 'Europe/Warsaw' },
  { id: 'athens', city: 'Athens', country: 'Greece', flag: '🇬🇷', zone: 'Europe/Athens' },
  { id: 'istanbul', city: 'Istanbul', country: 'Türkiye', flag: '🇹🇷', zone: 'Europe/Istanbul' },
  { id: 'moscow', city: 'Moscow', country: 'Russia', flag: '🇷🇺', zone: 'Europe/Moscow' },
  { id: 'kyiv', city: 'Kyiv', country: 'Ukraine', flag: '🇺🇦', zone: 'Europe/Kyiv' },
  { id: 'cairo', city: 'Cairo', country: 'Egypt', flag: '🇪🇬', zone: 'Africa/Cairo' },
  { id: 'lagos', city: 'Lagos', country: 'Nigeria', flag: '🇳🇬', zone: 'Africa/Lagos' },
  { id: 'nairobi', city: 'Nairobi', country: 'Kenya', flag: '🇰🇪', zone: 'Africa/Nairobi' },
  { id: 'johannesburg', city: 'Johannesburg', country: 'South Africa', flag: '🇿🇦', zone: 'Africa/Johannesburg' },
  { id: 'dubai', city: 'Dubai', country: 'United Arab Emirates', flag: '🇦🇪', zone: 'Asia/Dubai' },
  { id: 'riyadh', city: 'Riyadh', country: 'Saudi Arabia', flag: '🇸🇦', zone: 'Asia/Riyadh' },
  { id: 'tel-aviv', city: 'Tel Aviv', country: 'Israel', flag: '🇮🇱', zone: 'Asia/Jerusalem' },
  { id: 'mumbai', city: 'Mumbai', country: 'India', flag: '🇮🇳', zone: 'Asia/Kolkata' },
  { id: 'delhi', city: 'Delhi', country: 'India', flag: '🇮🇳', zone: 'Asia/Kolkata' },
  { id: 'bengaluru', city: 'Bengaluru', country: 'India', flag: '🇮🇳', zone: 'Asia/Kolkata' },
  { id: 'karachi', city: 'Karachi', country: 'Pakistan', flag: '🇵🇰', zone: 'Asia/Karachi' },
  { id: 'dhaka', city: 'Dhaka', country: 'Bangladesh', flag: '🇧🇩', zone: 'Asia/Dhaka' },
  { id: 'bangkok', city: 'Bangkok', country: 'Thailand', flag: '🇹🇭', zone: 'Asia/Bangkok' },
  { id: 'singapore', city: 'Singapore', country: 'Singapore', flag: '🇸🇬', zone: 'Asia/Singapore' },
  { id: 'kuala-lumpur', city: 'Kuala Lumpur', country: 'Malaysia', flag: '🇲🇾', zone: 'Asia/Kuala_Lumpur' },
  { id: 'jakarta', city: 'Jakarta', country: 'Indonesia', flag: '🇮🇩', zone: 'Asia/Jakarta' },
  { id: 'manila', city: 'Manila', country: 'Philippines', flag: '🇵🇭', zone: 'Asia/Manila' },
  { id: 'hong-kong', city: 'Hong Kong', country: 'Hong Kong', flag: '🇭🇰', zone: 'Asia/Hong_Kong' },
  { id: 'shanghai', city: 'Shanghai', country: 'China', flag: '🇨🇳', zone: 'Asia/Shanghai' },
  { id: 'beijing', city: 'Beijing', country: 'China', flag: '🇨🇳', zone: 'Asia/Shanghai' },
  { id: 'taipei', city: 'Taipei', country: 'Taiwan', flag: '🇹🇼', zone: 'Asia/Taipei' },
  { id: 'seoul', city: 'Seoul', country: 'South Korea', flag: '🇰🇷', zone: 'Asia/Seoul' },
  { id: 'tokyo', city: 'Tokyo', country: 'Japan', flag: '🇯🇵', zone: 'Asia/Tokyo' },
  { id: 'sydney', city: 'Sydney', country: 'Australia', flag: '🇦🇺', zone: 'Australia/Sydney' },
  { id: 'melbourne', city: 'Melbourne', country: 'Australia', flag: '🇦🇺', zone: 'Australia/Melbourne' },
  { id: 'auckland', city: 'Auckland', country: 'New Zealand', flag: '🇳🇿', zone: 'Pacific/Auckland' },
]

const CITY_BY_ID = new Map(CITIES.map((city) => [city.id, city]))
const STORAGE_KEY = 'hover-island.clock.cities.v1'
const DEFAULT_IDS = ['london', 'new-york']
const MAX_CITIES = 12
const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
const LOCAL_LABEL = LOCAL_ZONE.split('/').pop()?.replace(/_/g, ' ') ?? LOCAL_ZONE

/** Robust read of the persisted city ids; falls back to the defaults on any corruption. */
function restoreCities(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_IDS
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DEFAULT_IDS
    const ids = parsed
      .filter((item): item is string => typeof item === 'string')
      .filter((id, index, all) => all.indexOf(id) === index)
      .filter((id) => CITY_BY_ID.has(id))
      .slice(0, MAX_CITIES)
    if (ids.length === 0 && parsed.length > 0) return DEFAULT_IDS
    return ids
  } catch {
    return DEFAULT_IDS
  }
}

function persistCities(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    /* storage unavailable — selection stays in-memory for the session */
  }
}

function timeAt(date: Date, zone: string) {
  return clockTime(date, zone)
}

function dateAt(date: Date, zone: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat([], { timeZone: zone, ...options }).format(date)
}

function parts(date: Date, zone: string) {
  const list = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(list.find((item) => item.type === type)?.value ?? 0)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute'), second: get('second') }
}

function dialAngles(date: Date, zone: string) {
  const { hour, minute, second } = parts(date, zone)
  return { hour: (hour % 12) * 30 + minute * 0.5, minute: minute * 6 + second * 0.1, second: second * 6 }
}

/** "Today, +3 hrs" relative to this computer's zone, in the style of the system World Clock. */
function offsetCaption(date: Date, zone: string): string {
  const here = parts(date, LOCAL_ZONE)
  const there = parts(date, zone)
  const stamp = (p: ReturnType<typeof parts>) => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  const diffMinutes = Math.round((stamp(there) - stamp(here)) / 60000)
  const dayDiff = Math.round((Date.UTC(there.year, there.month - 1, there.day) - Date.UTC(here.year, here.month - 1, here.day)) / 86400000)
  const day = dayDiff === 0 ? 'Today' : dayDiff > 0 ? 'Tomorrow' : 'Yesterday'
  const sign = diffMinutes < 0 ? '-' : '+'
  const abs = Math.abs(diffMinutes)
  const hours = Math.floor(abs / 60)
  const minutes = abs % 60
  return `${day}, ${sign}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''} hrs`
}

function isDaytime(date: Date, zone: string): boolean {
  const { hour } = parts(date, zone)
  return hour >= 6 && hour < 18
}

function Face(props: { date: Date; zone: string; label: string }) {
  const angles = () => dialAngles(props.date, props.zone)
  const day = () => isDaytime(props.date, props.zone)
  return (
    <svg class="clock-dial" classList={{ 'clock-dial--night': !day() }} viewBox="0 0 100 100" role="img" aria-label={`${props.label}, ${timeAt(props.date, props.zone)}`}>
      <circle cx="50" cy="50" r="49" class="clock-dial__face" />
      <For each={Array.from({ length: 12 }, (_, index) => index + 1)}>{(hour) => {
        const a = (hour * 30 * Math.PI) / 180
        return <text class="clock-dial__num" x={50 + Math.sin(a) * 37} y={50 - Math.cos(a) * 37 + 4} text-anchor="middle">{hour}</text>
      }}</For>
      <line class="clock-dial__hand" x1="50" y1="54" x2="50" y2="29" stroke-width="4.2" transform={`rotate(${angles().hour} 50 50)`} />
      <line class="clock-dial__hand" x1="50" y1="56" x2="50" y2="17" stroke-width="3" transform={`rotate(${angles().minute} 50 50)`} />
      <g transform={`rotate(${angles().second} 50 50)`}>
        <line class="clock-dial__second" x1="50" y1="60" x2="50" y2="14" stroke-width="1.4" />
      </g>
      <circle cx="50" cy="50" r="3.4" class="clock-dial__second-dot" />
    </svg>
  )
}

interface Entry { id: string; name: string; zone: string; local?: boolean; city?: CityOption }

export default function ClockView(props: ClockViewProps) {
  const [now, setNow] = createSignal(new Date())
  const [picked, setPicked] = createSignal<string[]>(restoreCities())
  const [pickerOpen, setPickerOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [page, setPage] = createSignal(0)
  const [box, setBox] = createSignal({ width: 342, height: 201 })
  let root: HTMLDivElement | undefined
  let searchRef: HTMLInputElement | undefined
  const analog = () => props.style === 'analog'

  onMount(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(([entry]) => setBox({ width: entry.contentRect.width, height: entry.contentRect.height }))
    if (resize && root) resize.observe(root)
    onCleanup(() => { clearInterval(timer); resize?.disconnect() })
  })
  createEffect(() => { if (pickerOpen()) queueMicrotask(() => searchRef?.focus()) })

  const entries = createMemo<Entry[]>(() => [
    { id: 'local', name: LOCAL_LABEL, zone: LOCAL_ZONE, local: true },
    ...picked().map((id) => CITY_BY_ID.get(id)).filter((city): city is CityOption => Boolean(city)).map((city) => ({ id: city.id, name: city.city, zone: city.zone, city })),
  ])
  // Grid geometry from the real tile size so nothing is ever cut off.
  const grid = createMemo(() => {
    const { width, height } = box()
    const body = Math.max(60, height - 30)
    if (analog()) {
      const maxColumns = Math.max(2, Math.min(6, Math.floor(width / 96)))
      const maxRows = Math.max(1, Math.floor(body / 128))
      const count = entries().length
      const columns = Math.max(1, Math.min(maxColumns, count))
      const rows = Math.max(1, Math.min(maxRows, Math.ceil(count / columns)))
      return { columns, rows, capacity: maxColumns * maxRows, visibleColumns: columns }
    }
    const columns = width >= 560 ? 2 : 1
    const rows = Math.max(1, Math.floor(body / 46))
    return { columns, rows, capacity: columns * rows }
  })
  const pages = () => Math.max(1, Math.ceil(entries().length / grid().capacity))
  const currentPage = () => Math.min(page(), pages() - 1)
  const visible = () => entries().slice(currentPage() * grid().capacity, (currentPage() + 1) * grid().capacity)
  const available = createMemo(() => {
    const term = query().trim().toLowerCase()
    return CITIES.filter((city) => {
      if (picked().includes(city.id)) return false
      if (!term) return true
      return city.city.toLowerCase().includes(term) || city.country.toLowerCase().includes(term) || city.zone.toLowerCase().includes(term)
    })
  })

  const commit = (next: string[]) => {
    const clean = next.filter((id) => CITY_BY_ID.has(id)).slice(0, MAX_CITIES)
    setPicked(clean)
    persistCities(clean)
  }
  const addCity = (id: string) => {
    if (picked().includes(id) || picked().length >= MAX_CITIES) return
    commit([...picked(), id])
  }
  const removeCity = (id: string) => commit(picked().filter((item) => item !== id))

  return <div ref={root} class="clock-widget" classList={{ 'clock-widget--digital': props.style !== 'analog' }}>
    <Show when={!pickerOpen()} fallback={
      <div id="clock-city-picker" class="clock-picker" aria-label="Add a city" onKeyDown={(event) => { if (event.key === 'Escape') setPickerOpen(false) }}>
        <div class="clock-picker__head">
          <label class="clock-picker__search">
            <Search size={13} aria-hidden="true" />
            <input ref={searchRef} type="text" placeholder="Search cities or countries" value={query()} aria-label="Search cities or countries" onInput={(event) => setQuery(event.currentTarget.value)} />
          </label>
          <button type="button" class="clock-link" aria-label="Close city picker" onClick={() => setPickerOpen(false)}>Done</button>
        </div>
        <div class="clock-picker__list" role="listbox" aria-label="Available cities">
          <For each={available()} fallback={<p class="clock-picker__empty">No cities match “{query()}”.</p>}>{(city) =>
            <button type="button" class="clock-picker__item" role="option" aria-selected="false" onClick={() => addCity(city.id)}>
              <span class="clock-picker__flag" aria-hidden="true">{city.flag}</span>
              <span class="clock-picker__meta"><span class="clock-picker__city">{city.city}</span><span class="clock-picker__country">{city.country}</span></span>
              <strong class="clock-picker__time">{timeAt(now(), city.zone)}</strong>
              <Plus size={13} aria-hidden="true" />
            </button>
          }</For>
        </div>
        <Show when={picked().length >= MAX_CITIES}><p class="clock-picker__note">Tracking up to {MAX_CITIES} cities.</p></Show>
      </div>
    }>
      <header class="clock-head">
        <span class="clock-head__title">World clock</span>
        <span class="clock-head__tools">
          <Show when={pages() > 1}>
            <button type="button" class="clock-icon" aria-label="Previous clock cities" disabled={currentPage() === 0} onClick={() => setPage(currentPage() - 1)}><ChevronLeft size={15} /></button>
            <span class="clock-head__page">{currentPage() + 1}/{pages()}</span>
            <button type="button" class="clock-icon" aria-label="Next clock cities" disabled={currentPage() >= pages() - 1} onClick={() => setPage(currentPage() + 1)}><ChevronRight size={15} /></button>
          </Show>
          <button type="button" class="clock-icon clock-add__btn" aria-label="Add city" title="Add city" aria-expanded={pickerOpen()} aria-controls="clock-city-picker" onClick={() => setPickerOpen(true)}><Plus size={16} strokeWidth={2.2} /></button>
        </span>
      </header>
      <div class="world-clocks" role="list" style={{ '--clock-cols': grid().columns, '--clock-rows': grid().rows }}>
        <For each={visible()}>{(entry) =>
          <div class="clock-row" classList={{ 'clock-row--local': !!entry.local }} role="listitem">
            <Show when={analog()}><Face date={now()} zone={entry.zone} label={entry.name} /></Show>
            <div class="clock-row__id">
              <span class="clock-row__name">{entry.name}<Show when={entry.city}><span class="clock-row__flag" aria-hidden="true"> {entry.city!.flag}</span></Show></span>
              <span class="clock-row__sub">{entry.local ? 'Today, local' : offsetCaption(now(), entry.zone)}</span>
            </div>
            <Show when={!analog()}><strong class="clock-row__time">{timeAt(now(), entry.zone)}</strong></Show>
            <Show when={!entry.local}>
              <button type="button" class="clock-row__remove" aria-label={`Remove ${entry.name}`} title={`Remove ${entry.name}`} onClick={() => removeCity(entry.id)}><X size={11} aria-hidden="true" /></button>
            </Show>
          </div>
        }</For>
      </div>
    </Show>
  </div>
}
