import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Check, ChevronLeft, ChevronRight, Globe, Moon, Search, Sun, X } from 'lucide-solid'
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

type Region = 'americas' | 'europe' | 'africa' | 'asia' | 'oceania'
const REGIONS: { id: Region; label: string }[] = [
  { id: 'americas', label: 'Americas' },
  { id: 'europe', label: 'Europe' },
  { id: 'africa', label: 'Africa' },
  { id: 'asia', label: 'Asia' },
  { id: 'oceania', label: 'Oceania' },
]
function regionOf(city: CityOption): Region {
  if (city.id === 'honolulu') return 'americas'
  const head = city.zone.split('/')[0]
  if (head === 'America') return 'americas'
  if (head === 'Europe') return 'europe'
  if (head === 'Africa') return 'africa'
  if (head === 'Asia') return 'asia'
  return 'oceania'
}
type Filter = 'all' | 'selected' | Region
const STORAGE_KEY = 'hover-island.clock.cities.v1'
const LOCAL_KEY = 'hover-island.clock.local.v1'
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

function restoreShowLocal(): boolean {
  try { return localStorage.getItem(LOCAL_KEY) !== 'off' } catch { return true }
}
function persistShowLocal(show: boolean): void {
  try { localStorage.setItem(LOCAL_KEY, show ? 'on' : 'off') } catch { /* in-memory only */ }
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
  const [filter, setFilter] = createSignal<Filter>('all')
  const [showLocal, setShowLocal] = createSignal(restoreShowLocal())
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
    ...(showLocal() ? [{ id: 'local', name: LOCAL_LABEL, zone: LOCAL_ZONE, local: true } as Entry] : []),
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
  const regionCount = (region: Region) => picked().filter((id) => { const city = CITY_BY_ID.get(id); return city && regionOf(city) === region }).length
  const listed = createMemo(() => {
    const term = query().trim().toLowerCase()
    const mode = filter()
    const chosen = new Set(picked())
    return CITIES.filter((city) => {
      if (mode === 'selected' && !chosen.has(city.id)) return false
      if (mode !== 'all' && mode !== 'selected' && regionOf(city) !== mode) return false
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
  const toggleCity = (id: string) => (picked().includes(id) ? removeCity(id) : addCity(id))
  const toggleLocal = () => { const next = !showLocal(); setShowLocal(next); persistShowLocal(next) }
  const regionCities = (region: Region) => CITIES.filter((city) => regionOf(city) === region).map((city) => city.id)
  const selectRegion = (region: Region) => commit([...picked(), ...regionCities(region).filter((id) => !picked().includes(id))])
  const clearRegion = (region: Region) => { const ids = new Set(regionCities(region)); commit(picked().filter((id) => !ids.has(id))) }
  const activeRegion = () => { const mode = filter(); return mode === 'all' || mode === 'selected' ? null : mode }

  return <div ref={root} class="clock-widget" classList={{ 'clock-widget--digital': props.style !== 'analog' }}>
    <Show when={!pickerOpen()} fallback={
      <div id="clock-city-picker" class="clock-picker" aria-label="Choose cities" onKeyDown={(event) => { if (event.key === 'Escape') setPickerOpen(false) }}>
        <div class="clock-picker__head">
          <label class="clock-picker__search">
            <Search size={13} aria-hidden="true" />
            <input ref={searchRef} type="text" placeholder="Search cities or countries" value={query()} aria-label="Search cities or countries" onInput={(event) => setQuery(event.currentTarget.value)} />
          </label>
          <button type="button" class="clock-link" aria-label="Close city picker" onClick={() => setPickerOpen(false)}>Done</button>
        </div>
        <div class="clock-chips" role="tablist" aria-label="Regions">
          <button type="button" role="tab" class="clock-chip" aria-selected={filter() === 'all'} classList={{ 'clock-chip--on': filter() === 'all' }} onClick={() => setFilter('all')}>All</button>
          <For each={REGIONS}>{(region) =>
            <button type="button" role="tab" class="clock-chip" aria-selected={filter() === region.id} classList={{ 'clock-chip--on': filter() === region.id }} onClick={() => setFilter(region.id)}>
              {region.label}<Show when={regionCount(region.id) > 0}><b>{regionCount(region.id)}</b></Show>
            </button>
          }</For>
          <button type="button" role="tab" class="clock-chip" aria-selected={filter() === 'selected'} classList={{ 'clock-chip--on': filter() === 'selected' }} onClick={() => setFilter('selected')}>Selected<b>{picked().length}</b></button>
        </div>
        <div class="clock-picker__list" role="listbox" aria-label="Available cities" aria-multiselectable="true">
          <Show when={filter() === 'all' && !query().trim()}>
            <button type="button" class="clock-picker__item" role="option" aria-selected={showLocal()} onClick={toggleLocal}>
              <span class="clock-picker__flag" aria-hidden="true">📍</span>
              <span class="clock-picker__meta"><span class="clock-picker__city">{LOCAL_LABEL}</span><span class="clock-picker__country">This PC</span></span>
              <strong class="clock-picker__time">{timeAt(now(), LOCAL_ZONE)}</strong>
              <span class="clock-tick" classList={{ 'clock-tick--on': showLocal() }} aria-hidden="true"><Check size={11} strokeWidth={3} /></span>
            </button>
          </Show>
          <For each={listed()} fallback={<p class="clock-picker__empty">{filter() === 'selected' && !query().trim() ? 'No cities picked yet.' : `No cities match “${query()}”.`}</p>}>{(city) => {
            const on = () => picked().includes(city.id)
            return <button type="button" class="clock-picker__item" role="option" aria-selected={on()} disabled={!on() && picked().length >= MAX_CITIES} onClick={() => toggleCity(city.id)}>
              <span class="clock-picker__flag" aria-hidden="true">{city.flag}</span>
              <span class="clock-picker__meta"><span class="clock-picker__city">{city.city}</span><span class="clock-picker__country">{city.country}</span></span>
              <strong class="clock-picker__time">{timeAt(now(), city.zone)}</strong>
              <span class="clock-tick" classList={{ 'clock-tick--on': on() }} aria-hidden="true"><Check size={11} strokeWidth={3} /></span>
            </button>
          }}</For>
        </div>
        <div class="clock-picker__foot">
          <span>{picked().length}/{MAX_CITIES} cities</span>
          <Show when={activeRegion()}>{(region) => <span class="clock-picker__bulk">
            <button type="button" class="clock-link clock-link--sm" onClick={() => selectRegion(region())}>Add all</button>
            <button type="button" class="clock-link clock-link--sm clock-link--mute" disabled={regionCount(region()) === 0} onClick={() => clearRegion(region())}>Clear</button>
          </span>}</Show>
        </div>
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
          <button type="button" class="clock-pill" aria-label="Choose cities" title="Choose cities and regions" aria-expanded={pickerOpen()} aria-controls="clock-city-picker" onClick={() => setPickerOpen(true)}><Globe size={12} strokeWidth={2.2} /><span>{picked().length + (showLocal() ? 1 : 0)}</span></button>
        </span>
      </header>
      <Show when={entries().length > 0} fallback={<button type="button" class="clock-empty" onClick={() => setPickerOpen(true)}><Globe size={18} strokeWidth={1.8} /><span>Pick the cities you want to see</span></button>}>
      <div class="world-clocks" role="list" style={{ '--clock-cols': grid().columns, '--clock-rows': grid().rows }}>
        <For each={visible()}>{(entry) =>
          <div class="clock-row" classList={{ 'clock-row--local': !!entry.local }} role="listitem">
            <Show when={analog()}><Face date={now()} zone={entry.zone} label={entry.name} /></Show>
            <Show when={!analog()}><span class="clock-row__phase" classList={{ 'clock-row__phase--night': !isDaytime(now(), entry.zone) }} aria-hidden="true">{isDaytime(now(), entry.zone) ? <Sun size={13} strokeWidth={2.2} /> : <Moon size={12} strokeWidth={2.2} />}</span></Show>
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
    </Show>
  </div>
}
