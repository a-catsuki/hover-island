import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Globe2, Plus, Search, X } from 'lucide-solid'
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
  return clockTime(date,zone)
}

function dateAt(date: Date, zone: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat([], { timeZone: zone, ...options }).format(date)
}

function dialAngles(date: Date, zone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(item => item.type === type)?.value ?? 0)
  const hour = part('hour') % 12
  const minute = part('minute')
  const second = part('second')
  return {
    hour: hour * 30 + minute * 0.5,
    minute: minute * 6 + second * 0.1,
    second: second * 6,
  }
}

export default function ClockView(props: ClockViewProps) {
  const [now, setNow] = createSignal(new Date())
  const [picked, setPicked] = createSignal<string[]>(restoreCities())
  const [pickerOpen, setPickerOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [cityPage,setCityPage]=createSignal(0)
  const cityPages=()=>Math.max(1,Math.ceil(picked().length/3))
  const currentCityPage=()=>Math.min(cityPage(),cityPages()-1)

  let searchRef: HTMLInputElement | undefined

  onMount(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    if (pickerOpen()) queueMicrotask(() => searchRef?.focus())
  })

  const angles = createMemo(() => dialAngles(now(), LOCAL_ZONE))
  const pickedCities = createMemo(() => picked().map((id) => CITY_BY_ID.get(id)).filter((city): city is CityOption => Boolean(city)))
  const available = createMemo(() => {
    const term = query().trim().toLowerCase()
    return CITIES.filter((city) => {
      if (picked().includes(city.id)) return false
      if (!term) return true
      return city.city.toLowerCase().includes(term)
        || city.country.toLowerCase().includes(term)
        || city.zone.toLowerCase().includes(term)
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

  return <div class="clock-widget" classList={{ 'clock-widget--digital': props.style !== 'analog' }}>
    <header class="widget__head">
      <span class="widget__title"><Globe2 size={15} aria-hidden="true" />World clock</span>
      <span class="widget__eyebrow">Across the day</span>
    </header>
    <div class="clock-body">
      <Show when={props.style === 'analog'}>
        <div class="clock-dial-wrap">
          <div class="clock-dial" role="img" aria-label={`Local time ${timeAt(now(), LOCAL_ZONE)}`}>
            <For each={Array.from({ length: 12 }, (_, index) => index)}>{index =>
              <span class="clock-dial__marker" classList={{ 'clock-dial__marker--major': index % 3 === 0 }} style={{ '--marker-angle': `${index * 30}deg` }} aria-hidden="true" />
            }</For>
            <span class="clock-dial__hand clock-dial__hand--hour" style={{ transform: `rotate(${angles().hour}deg)` }} />
            <span class="clock-dial__hand clock-dial__hand--minute" style={{ transform: `rotate(${angles().minute}deg)` }} />
            <span class="clock-dial__hand clock-dial__hand--second" style={{ transform: `rotate(${angles().second}deg)` }} />
            <span class="clock-dial__pin" />
          </div>
          <div class="clock-local">
            <strong>{timeAt(now(), LOCAL_ZONE)}</strong>
            <span>{dateAt(now(), LOCAL_ZONE, { weekday: 'long', month: 'short', day: 'numeric' })}</span>
          </div>
        </div>
      </Show>

      <div class="world-clocks" role="list">
        <div class="clock-row clock-row--local" role="listitem">
          <div class="clock-row__id">
            <span class="clock-row__name">Local</span>
            <span class="clock-row__sub">{LOCAL_LABEL}</span>
          </div>
          <strong class="clock-row__time">{timeAt(now(), LOCAL_ZONE)}</strong>
          <span class="clock-row__slot" aria-hidden="true" />
        </div>
        <For each={pickedCities().slice(currentCityPage()*3,currentCityPage()*3+3)}>{city =>
          <div class="clock-row" role="listitem">
            <div class="clock-row__id">
              <span class="clock-row__name">{city.city} <span class="clock-row__flag" aria-hidden="true">{city.flag}</span></span>
              <span class="clock-row__sub">{city.country} · {dateAt(now(), city.zone, { weekday: 'short' })}</span>
            </div>
            <strong class="clock-row__time">{timeAt(now(), city.zone)}</strong>
            <button
              type="button"
              class="clock-row__remove"
              aria-label={`Remove ${city.city}`}
              title={`Remove ${city.city}`}
              onClick={() => removeCity(city.id)}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        }</For>
        <Show when={cityPages()>1}><nav class="widget-list-pager" aria-label="World clock cities"><button aria-label="Previous clock cities" disabled={currentCityPage()===0} onClick={()=>setCityPage(currentCityPage()-1)}>‹</button><span>{currentCityPage()+1} / {cityPages()}</span><button aria-label="Next clock cities" disabled={currentCityPage()>=cityPages()-1} onClick={()=>setCityPage(currentCityPage()+1)}>›</button></nav></Show>
      </div>

      <div class="clock-add">
        <button
          type="button"
          class="clock-add__btn"
          aria-expanded={pickerOpen()}
          aria-controls="clock-city-picker"
          onClick={() => setPickerOpen((open) => !open)}
        >
          <Plus size={13} aria-hidden="true" />
          Add city
        </button>
      </div>

      <Show when={pickerOpen()}>
        <div
          id="clock-city-picker"
          class="clock-picker"
          aria-label="Add a city"
          onKeyDown={(event) => { if (event.key === 'Escape') setPickerOpen(false) }}
        >
          <div class="clock-picker__head">
            <label class="clock-picker__search">
              <Search size={13} aria-hidden="true" />
              <input
                ref={searchRef}
                type="text"
                placeholder="Search cities or countries"
                value={query()}
                aria-label="Search cities or countries"
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <button type="button" class="clock-picker__close" aria-label="Close city picker" onClick={() => setPickerOpen(false)}>
              <X size={13} aria-hidden="true" />
            </button>
          </div>
          <div class="clock-picker__list" role="listbox" aria-label="Available cities">
            <For each={available()} fallback={<p class="clock-picker__empty">No cities match “{query()}”.</p>}>{city =>
              <button type="button" class="clock-picker__item" role="option" aria-selected="false" onClick={() => addCity(city.id)}>
                <span class="clock-picker__flag" aria-hidden="true">{city.flag}</span>
                <span class="clock-picker__meta">
                  <span class="clock-picker__city">{city.city}</span>
                  <span class="clock-picker__country">{city.country}</span>
                </span>
                <strong class="clock-picker__time">{timeAt(now(), city.zone)}</strong>
                <Plus size={13} aria-hidden="true" />
              </button>
            }</For>
          </div>
          <Show when={picked().length >= MAX_CITIES}>
            <p class="clock-picker__note">Tracking up to {MAX_CITIES} cities.</p>
          </Show>
        </div>
      </Show>
    </div>
  </div>
}
