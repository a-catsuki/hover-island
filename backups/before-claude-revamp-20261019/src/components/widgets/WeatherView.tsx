import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { CloudOff, Droplets, Gauge, RefreshCw, Wind } from 'lucide-solid'
import { canLoadWeather, weatherLayout, type WeatherLayout } from '../../lib/weatherLayout'
import { cmd, type WeatherLocation, type WeatherSnapshot } from '../../lib/ipc'
import { flushSettings, patchSettings, settings } from '../../state/settings'
import { requestWidgetDetail } from '../../state/panel'
import { open as islandOpen } from '../../state/ui'
import './widgets.css'
import './WeatherView.css'

type ConditionGroup = 'clear' | 'partly' | 'cloud' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'thunder'
type ForecastView = 'now' | 'hourly' | 'week'
type WeatherUnits = 'metric' | 'imperial'
const UNIT_KEY = 'hover-island.weather-units'

function celsius(value: number, units: WeatherUnits): number {
  return units === 'imperial' ? value * 9 / 5 + 32 : value
}

function windSpeed(value: number, units: WeatherUnits): number {
  return units === 'imperial' ? value * 0.621371 : value
}

function temperature(value: number, units: WeatherUnits): string {
  return `${Math.round(celsius(value, units))}°${units === 'imperial' ? 'F' : 'C'}`
}

function unitLabel(units: WeatherUnits): string {
  return units === 'imperial' ? 'mph' : 'km/h'
}

function forecastTime(value: string): string {
  const match = /T(\d{2}):(\d{2})/.exec(value)
  if (!match) return '—'
  const date = new Date(2000, 0, 1, Number(match[1]), Number(match[2]))
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(date)
}

function forecastDay(value: string, index: number): string {
  if (index === 0) return 'Today'
  if (index === 1) return 'Tomorrow'
  const date = new Date(`${value}T12:00:00`)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date)
}

function compass(degrees?: number | null): string {
  if (degrees == null || !Number.isFinite(degrees)) return '—'
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((degrees % 360) + 360) % 360) / 45) % 8]
}

function readWeatherUnits(): WeatherUnits {
  try { return localStorage.getItem(UNIT_KEY) === 'imperial' ? 'imperial' : 'metric' } catch { return 'metric' }
}

function conditionGroup(code: number): ConditionGroup {
  if (code === 0) return 'clear'
  if (code <= 2) return 'partly'
  if (code === 3) return 'cloud'
  if (code <= 48) return 'fog'
  if (code <= 57) return 'drizzle'
  if (code <= 67 || (code >= 80 && code <= 82)) return 'rain'
  if (code <= 77 || (code >= 85 && code <= 86)) return 'snow'
  return 'thunder'
}

function conditionLabel(code: number): string {
  if (code === 0) return 'Clear'
  if (code === 1) return 'Mostly clear'
  if (code === 2) return 'Partly cloudy'
  if (code === 3) return 'Cloudy'
  if (code === 45 || code === 48) return 'Fog'
  if (code >= 51 && code <= 57) return 'Drizzle'
  if (code >= 61 && code <= 67 || code >= 80 && code <= 82) return 'Rain'
  if (code >= 71 && code <= 77 || code >= 85 && code <= 86) return 'Snow'
  if (code >= 95 && code <= 99) return 'Thunderstorms'
  return 'Weather'
}

function relativeTime(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  return `${Math.round(hours / 24)} d ago`
}

function aqiPercent(aqi: number): number {
  return Math.max(4, Math.min(100, (aqi / 300) * 100))
}

function aqiColor(aqi: number): string {
  if (aqi <= 50) return '#4ade80'
  if (aqi <= 100) return '#fbbf24'
  if (aqi <= 150) return '#fb923c'
  if (aqi <= 200) return '#f87171'
  if (aqi <= 300) return '#a78bfa'
  return '#ef4444'
}

function localNight(latitude: number | null | undefined, longitude: number | null | undefined, now: number): boolean {
  if (latitude == null || longitude == null || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    const hour = new Date(now).getHours()
    return hour < 6 || hour >= 19
  }
  const date = new Date(now)
  const n = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000)
  const declination = (hour: number) => {
    const mean = 0.9856 * (n + (hour - longitude / 15) / 24) - 3.289
    const longitudeSun = mean + 1.916 * Math.sin(mean * Math.PI / 180) + 0.02 * Math.sin(2 * mean * Math.PI / 180) + 282.634
    const rightAscension = ((Math.atan(0.91764 * Math.tan(longitudeSun * Math.PI / 180)) * 180 / Math.PI + 360) % 360)
    const quadrant = Math.floor(longitudeSun / 90) * 90
    const raQuadrant = Math.floor(rightAscension / 90) * 90
    const ra = (rightAscension + quadrant - raQuadrant) / 15
    const sinDec = 0.39782 * Math.sin(longitudeSun * Math.PI / 180)
    const cosDec = Math.cos(Math.asin(sinDec))
    const cosHourAngle = (Math.cos(90.833 * Math.PI / 180) - sinDec * Math.sin(latitude * Math.PI / 180)) / (cosDec * Math.cos(latitude * Math.PI / 180))
    return { ra, sinDec, cosDec, cosHourAngle }
  }
  const utcHour = (angle: number, hour: number) => {
    const values = declination(hour)
    const t = n + (hour - longitude / 15) / 24
    const mean = 0.9856 * t - 3.289
    const localMean = angle / 15 + values.ra - 0.06571 * t - 6.622
    return (localMean - longitude / 15 + 24) % 24
  }
  const values = declination(6)
  if (values.cosHourAngle < -1) return false
  if (values.cosHourAngle > 1) return true
  const sunrise = utcHour(360 - Math.acos(values.cosHourAngle) * 180 / Math.PI, 6)
  const sunset = utcHour(Math.acos(values.cosHourAngle) * 180 / Math.PI, 18)
  const current = date.getUTCHours() + date.getUTCMinutes() / 60
  return sunrise <= sunset ? current < sunrise || current >= sunset : current >= sunset && current < sunrise
}

function WeatherIcon(props: { code: number; night: boolean }) {
  const group = () => conditionGroup(props.code)
  const isNight = () => props.night
  const clear = () => group() === 'clear'
  const showSunOrMoon = () => clear() || group() === 'partly'
  const showCloud = () => group() !== 'clear' && group() !== 'fog'
  const showDrops = () => group() === 'drizzle' || group() === 'rain'
  const showFlakes = () => group() === 'snow'
  const showHaze = () => group() === 'fog'
  const showBolt = () => group() === 'thunder'
  const sunCx = () => (clear() ? 24 : 16)
  const sunCy = () => (clear() ? 24 : 15)
  const sunR = () => (clear() ? 8 : 6)
  const rayLines = () => {
    const cx = sunCx()
    const cy = sunCy()
    const inner = sunR() + 3.2
    const outer = sunR() + 6.4
    return [0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
      const angle = (deg * Math.PI) / 180
      return {
        x1: +(cx + Math.cos(angle) * inner).toFixed(2),
        y1: +(cy + Math.sin(angle) * inner).toFixed(2),
        x2: +(cx + Math.cos(angle) * outer).toFixed(2),
        y2: +(cy + Math.sin(angle) * outer).toFixed(2),
      }
    })
  }
  return (
    <svg
      class={`weather-icon weather-icon--${group()}`}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="weather-glow-grad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#ffd98a" stop-opacity="0.55" />
          <stop offset="100%" stop-color="#ffd98a" stop-opacity="0" />
        </radialGradient>
      </defs>

      <Show when={showSunOrMoon()}>
        <Show
          when={!isNight()}
          fallback={
            <g class="wi-moon">
              <circle class="wi-moon-disc" cx={sunCx()} cy={sunCy()} r={sunR()} />
              <circle
                class="wi-moon-bite"
                cx={sunCx() + sunR() * 0.62}
                cy={sunCy() - sunR() * 0.42}
                r={sunR() * 0.9}
              />
            </g>
          }
        >
          <g class="wi-sun">
            <circle class="wi-glow" cx={sunCx()} cy={sunCy()} r={sunR() + 10} />
            <g class="wi-rays">
              <For each={rayLines()}>
                {(line) => <line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />}
              </For>
            </g>
            <circle class="wi-disc" cx={sunCx()} cy={sunCy()} r={sunR()} />
          </g>
        </Show>
      </Show>

      <Show when={isNight() && clear()}>
        <g class="wi-stars">
          <circle cx="36" cy="12" r="1" />
          <circle cx="40.5" cy="21" r="0.8" />
          <circle cx="33" cy="33" r="0.9" />
        </g>
      </Show>

      <Show when={showCloud()}>
        <g class="wi-cloud">
          <circle cx="17" cy="29" r="7" />
          <circle cx="25" cy="25.5" r="8.5" />
          <circle cx="32" cy="29.5" r="6" />
          <rect x="10" y="29" width="28" height="8" rx="4" />
        </g>
      </Show>

      <Show when={showDrops()}>
        <g class="wi-drops">
          <line class="wi-drop" x1="18" y1="38" x2="18" y2="43" />
          <line class="wi-drop" x1="24" y1="38" x2="24" y2="43" />
          <line class="wi-drop" x1="30" y1="38" x2="30" y2="43" />
        </g>
      </Show>

      <Show when={showFlakes()}>
        <g class="wi-flakes">
          <circle class="wi-flake" cx="18" cy="40" r="1.7" />
          <circle class="wi-flake" cx="24" cy="39" r="1.7" />
          <circle class="wi-flake" cx="30" cy="40" r="1.7" />
        </g>
      </Show>

      <Show when={showHaze()}>
        <g class="wi-haze-lines">
          <line class="wi-haze" x1="12" y1="20" x2="36" y2="20" />
          <line class="wi-haze" x1="15" y1="27" x2="33" y2="27" />
          <line class="wi-haze" x1="12" y1="34" x2="36" y2="34" />
          <line class="wi-haze" x1="16" y1="41" x2="32" y2="41" />
        </g>
      </Show>

      <Show when={showBolt()}>
        <path class="wi-bolt" d="M25.5 31 L19 40.5 h4.6 l-2.7 7.5 9.2 -10.2 h-4.6 l3.8 -6.8 z" />
      </Show>
    </svg>
  )
}

export default function WeatherView() {
  const [weather, setWeather] = createSignal<WeatherSnapshot | null>(null)
  const [failed, setFailed] = createSignal(false)
  const [editingLocation, setEditingLocation] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [locations, setLocations] = createSignal<WeatherLocation[]>([])
  const [searching, setSearching] = createSignal(false)
  const [locationError, setLocationError] = createSignal('')
  const [savingLocation, setSavingLocation] = createSignal(false)
  const [refreshing, setRefreshing] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  const [sceneActive, setSceneActive] = createSignal(false)
  const [forecastView, setForecastView] = createSignal<ForecastView>('now')
  const [units, setUnits] = createSignal<WeatherUnits>('metric')
  const [layout, setLayout] = createSignal<WeatherLayout>('compact')
  let cardElement: HTMLElement | undefined
  let searchRequest = 0
  let weatherRequest = 0
  let active = true

  const hasLocation = () => canLoadWeather(settings)
  const group = createMemo<ConditionGroup>(() => {
    const snapshot = weather()
    return snapshot?.ok ? conditionGroup(snapshot.code) : 'clear'
  })
  const night = createMemo(() => weather()?.isDay == null
    ? localNight(settings.weatherLat, settings.weatherLon, now())
    : !weather()!.isDay)
  const weekBounds = createMemo(() => {
    const days = weather()?.daily ?? []
    const low = days.map((day) => day.lowC).filter(Number.isFinite)
    const high = days.map((day) => day.highC).filter(Number.isFinite)
    return { min: low.length ? Math.min(...low) : 0, max: high.length ? Math.max(...high) : 1 }
  })
  const daylightProgress = createMemo(() => {
    const snapshot = weather()
    const today = snapshot?.daily?.[0]
    if (!snapshot || !today?.sunrise || !today.sunset || !snapshot.isDay) return 0
    const minute = (value: string) => {
      const match = /T(\d{2}):(\d{2})/.exec(value)
      return match ? Number(match[1]) * 60 + Number(match[2]) : null
    }
    const sunrise = minute(today.sunrise)
    const sunset = minute(today.sunset)
    if (sunrise == null || sunset == null || sunset <= sunrise) return 0.5
    let current: number | null = null
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: snapshot.timezone || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now()))
      current = Number(parts.find((part) => part.type === 'hour')?.value) * 60 + Number(parts.find((part) => part.type === 'minute')?.value)
    } catch { current = null }
    return current == null ? 0.5 : Math.max(0, Math.min(1, (current - sunrise) / (sunset - sunrise)))
  })
  const setWeatherUnits = (value: WeatherUnits) => {
    setUnits(value)
    try { localStorage.setItem(UNIT_KEY, value) } catch { /* Keep this display preference for the current session. */ }
  }
  const selectForecastView = (value: ForecastView) => {
    setForecastView(value)
    if (value !== 'now') requestWidgetDetail('weather')
  }

  const load = async () => {
    if (!hasLocation()) { setWeather(null); return }
    const current = ++weatherRequest
    setRefreshing(true)
    try {
      const snapshot = await cmd.weatherGet()
      if (!active || current !== weatherRequest) return
      setWeather(snapshot)
      setFailed(!snapshot?.ok)
    } catch {
      if (active && current === weatherRequest) setFailed(true)
    } finally {
      if (active && current === weatherRequest) setRefreshing(false)
    }
  }

  const search = async (event: SubmitEvent) => {
    event.preventDefault()
    const value = query().trim()
    const current = ++searchRequest
    setLocationError('')
    setLocations([])
    if (value.length < 2) {
      setLocationError('Enter at least two letters.')
      return
    }
    setSearching(true)
    try {
      const found = await cmd.weatherSearch(value)
      if (current !== searchRequest || !active) return
      setLocations(found ?? [])
      if (!found?.length) setLocationError('No matching cities found.')
    } catch {
      if (current === searchRequest && active) setLocationError('City search is unavailable right now.')
    } finally {
      if (current === searchRequest && active) setSearching(false)
    }
  }

  const persistLocation = async (lat: number | null, lon: number | null, city: string | null, deviceLocation = false) => {
    setSavingLocation(true)
    setLocationError('')
    try {
      patchSettings({ weatherLat: lat, weatherLon: lon, weatherCity: city, weatherAutoLocation: deviceLocation })
      await flushSettings()
      if (!active) return
      setEditingLocation(false)
      setLocations([])
      setQuery('')
      setWeather(null)
      await load()
    } catch {
      if (active) setLocationError('Could not save this location. Try again.')
    } finally {
      if (active) setSavingLocation(false)
    }
  }

  const choose = (location: WeatherLocation) =>
    void persistLocation(location.latitude, location.longitude, location.name)

  const useDeviceLocation = async () => {
    setSavingLocation(true)
    setLocationError('')
    try {
      const location = await cmd.weatherDetectLocation()
      if (active) await persistLocation(location.latitude, location.longitude, location.name, true)
    } catch (error) {
      if (active) setLocationError(String(error))
    } finally {
      if (active) setSavingLocation(false)
    }
  }
  const clearLocation = async () => {
    setSavingLocation(true)
    setLocationError('')
    try {
      patchSettings({ weatherAutoLocation: false, weatherLat: null, weatherLon: null, weatherCity: null })
      weatherRequest++
      setWeather(null)
      await flushSettings()
    } catch {
      if (active) setLocationError('Could not save your location preference. Try again.')
    } finally {
      if (active) setSavingLocation(false)
    }
  }

  onMount(() => {
    setUnits(readWeatherUnits())
    void load()
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(([entry]) => {
      setLayout(weatherLayout(entry.contentRect.width, entry.contentRect.height))
    })
    if (resize && cardElement) resize.observe(cardElement)
    let intersecting = true
    const syncVisibility = () => setSceneActive(document.visibilityState === 'visible' && intersecting)
    syncVisibility()
    document.addEventListener('visibilitychange', syncVisibility)
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting
      syncVisibility()
    }, { threshold: 0.05 })
    if (observer && cardElement) observer.observe(cardElement)
    else if (document.visibilityState === 'visible') setSceneActive(true)
    onCleanup(() => {
      active = false
      weatherRequest++
      searchRequest++
      document.removeEventListener('visibilitychange', syncVisibility)
      observer?.disconnect()
      resize?.disconnect()
    })
  })

  createEffect(() => {
    if (!sceneActive() || !islandOpen() || !hasLocation()) return
    const refresh = window.setInterval(() => void load(), 10 * 60 * 1000)
    const tick = window.setInterval(() => setNow(Date.now()), 30 * 1000)
    onCleanup(() => { clearInterval(refresh); clearInterval(tick) })
  })

  const sourceLabel = () => `Open-Meteo · ${weather()?.locationSource === 'device'
    ? 'device location'
    : weather()?.locationSource === 'manual' ? 'selected city' : 'nearby forecast'}`

  createEffect(() => {
    if (layout() === 'compact') setForecastView('now')
  })

  createEffect(() => {
    if (!hasLocation()) {
      weatherRequest++
      setWeather(null)
      setRefreshing(false)
    }
  })

  return (
    <section
      class="weather-card"
      classList={{
        [`weather-card--${group()}`]: true,
        'weather-card--night': night(),
        'weather-card--animated': sceneActive() && islandOpen(),
        [`weather-card--${layout()}`]: true,
      }}
      aria-label="Local weather"
      ref={cardElement}
    >
      <div class="weather__atmos" aria-hidden="true" />

      <header class="widget__head">
        <span class="widget__title">
          Weather
        </span>
        <span class="widget__eyebrow" title={sourceLabel()}>
          {weather()?.city || (refreshing() ? 'Loading…' : '')}
          <Show when={weather()?.stale}><span class="weather__cached"> · Cached</span></Show>
        </span>
        <button
          type="button"
          class="weather__change"
          disabled={savingLocation()}
          onClick={() => {
            if (!editingLocation()) requestWidgetDetail('weather')
            setEditingLocation((value) => !value)
            setLocationError('')
            setLocations([])
            searchRequest++
            setSearching(false)
          }}
        >
          {editingLocation() ? 'Done' : 'Location'}
        </button>
      </header>

      <Show when={editingLocation()}>
        <form class="weather__search" onSubmit={search}>
          <input
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search for a city"
            aria-label="Search for a weather location"
            autocomplete="off"
            maxlength={80}
          />
          <button type="submit" disabled={searching() || savingLocation()}>
            {searching() ? 'Searching…' : 'Search'}
          </button>
        </form>
        <div class="weather__location-actions">
          <button
            type="button"
            disabled={savingLocation()}
            onClick={() => void useDeviceLocation()}
          >
            {savingLocation() ? 'Please wait…' : 'Use device location'}
          </button>
          <Show when={hasLocation()}><button type="button" disabled={savingLocation()} onClick={() => void clearLocation()}>Clear saved location</button></Show>
          <p class="weather__privacy">Windows checks your location permission when you choose this action. Only an approximate area is saved on this device, with no background tracking or Hover Island server. Forecasts send that area's coordinates to Open-Meteo. Clear the saved location here to stop those requests, or search for a city instead.</p>
        </div>
        <Show when={locationError()}><p class="weather__error" role="status">{locationError()}</p></Show>
        <div class="weather__locations">
          <For each={locations()}>
            {(location) => (
              <button type="button" disabled={savingLocation()} onClick={() => choose(location)}>
                <span>{location.name}</span>
                <small>{[location.admin1, location.country].filter(Boolean).join(', ')}</small>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={!editingLocation()}>
      <Show when={weather()?.ok ? weather() : undefined} fallback={
        <div class="weather-empty" role="status">
          <span class="weather-empty__glyph" aria-hidden="true">
            <CloudOff size={26} strokeWidth={1.5} />
          </span>
          <div class="weather-empty__message"><strong class="weather-empty__title">
            {!hasLocation() ? 'Choose your weather location' : weather()?.label || (failed() ? 'Weather unavailable' : 'Loading weather')}
          </strong><p class="weather-empty__copy">{!hasLocation() ? 'Choose a city or use device location.' : failed() ? 'Your forecast will retry when this panel is open.' : 'Getting your forecast.'}</p></div>
          <button type="button" class="weather-empty__action" onClick={() => { requestWidgetDetail('weather'); setEditingLocation(true) }}>
            {weather()?.city ? 'Change city' : 'Set up'}
          </button>
        </div>
      }>
        {(snapshot) => (
          <div class="weather">
            <div class="weather__toolbar">
              <Show when={layout() !== 'compact'} fallback={<button type="button" class="weather__details-action" onClick={() => setForecastView(value => value === 'now' ? 'hourly' : 'now')}>{forecastView() === 'now' ? 'Hourly forecast' : 'Current weather'}</button>}>
              <div class="weather__views" role="group" aria-label="Weather forecast view">
                <For each={[['now', 'Now'], ['hourly', 'Hourly'], ['week', '7-day']] as const}>{([id, label]) => <button type="button" aria-pressed={forecastView() === id} onClick={() => selectForecastView(id)}>{label}</button>}</For>
              </div>
              </Show>
              <div class="weather__unit-toggle" role="group" aria-label="Temperature units">
                <button type="button" aria-label="Metric units, Celsius and kilometers per hour" aria-pressed={units() === 'metric'} onClick={() => setWeatherUnits('metric')}>°C</button>
                <button type="button" aria-label="Imperial units, Fahrenheit and miles per hour" aria-pressed={units() === 'imperial'} onClick={() => setWeatherUnits('imperial')}>°F</button>
              </div>
              <button type="button" class="weather__refresh" aria-label="Refresh weather" title="Refresh forecast" disabled={refreshing()} onClick={() => void load()}><RefreshCw size={13} class={refreshing() ? 'weather__refresh-icon--spinning' : ''} /></button>
            </div>

            <Show when={forecastView() === 'now'}>
              <div class="weather__now">
                <span class="weather__temp">{temperature(snapshot().tempC, units())}</span>
                <WeatherIcon code={snapshot().code} night={night()} />
              </div>
              <div class="weather__summary-line">
                <span class="weather__desc">{snapshot().label}</span>
                <Show when={snapshot().feelsLikeC != null}><span>Feels {temperature(snapshot().feelsLikeC!, units())}</span></Show>
              </div>
              <div class="weather__range"><span class="weather__range-label">Today</span><span><em>H</em> {temperature(snapshot().hiC, units())}</span><span><em>L</em> {temperature(snapshot().loC, units())}</span><Show when={snapshot().precipitationMm != null && snapshot().precipitationMm! > 0}><span><Droplets size={11} /> {snapshot().precipitationMm!.toFixed(1)} mm</span></Show></div>

              <Show when={layout() !== 'compact'}><div class="weather__metrics" aria-label="Current weather details">
                <div><span>Humidity</span><strong>{snapshot().humidityPct == null ? '—' : `${snapshot().humidityPct}%`}</strong></div>
                <div><span>Wind</span><strong><Wind size={11} style={{ transform: `rotate(${snapshot().windDirectionDeg ?? 0}deg)` }} /> {snapshot().windSpeedKmh == null ? '—' : `${Math.round(windSpeed(snapshot().windSpeedKmh ?? 0, units()))} ${unitLabel(units())}`} <small>{compass(snapshot().windDirectionDeg)}</small></strong></div>
                <Show when={layout() === 'full'}><div><span>Pressure</span><strong><Gauge size={11} /> {snapshot().pressureHpa == null ? '—' : `${Math.round(snapshot().pressureHpa ?? 0)} hPa`}</strong></div>
                <div><span>Cloud cover</span><strong>{snapshot().cloudCoverPct == null ? '—' : `${snapshot().cloudCoverPct}%`}</strong></div></Show>
              </div></Show>

              <Show when={layout() === 'full' && (snapshot().hourly?.length ?? 0) > 0}>
                <div class="weather__mini-title"><span>Next hours</span><span>Precipitation chance</span></div>
                <div class="weather__mini-hours" aria-label="Upcoming hourly forecast">
                  <For each={snapshot().hourly?.slice(0, 5) ?? []}>{(hour, index) => <div class="weather__mini-hour"><span>{index() === 0 ? 'Now' : forecastTime(hour.time)}</span><strong>{temperature(hour.temperatureC, units())}</strong><small>{hour.precipitationProbability == null ? '—' : `${hour.precipitationProbability}%`}</small></div>}</For>
                </div>
              </Show>

              <Show when={layout() === 'full' && snapshot().daily?.[0]?.sunrise && snapshot().daily?.[0]?.sunset}>
                <div class="weather__sunline" aria-label={`Daylight from ${forecastTime(snapshot().daily![0].sunrise!)} to ${forecastTime(snapshot().daily![0].sunset!)}`}>
                  <span>{forecastTime(snapshot().daily![0].sunrise!)}</span><div class="weather__sun-arc"><i style={{ left: `${daylightProgress() * 100}%` }} /></div><span>{forecastTime(snapshot().daily![0].sunset!)}</span>
                </div>
              </Show>

              <Show when={layout() === 'full' && (snapshot().aqi != null || snapshot().pm25 != null || snapshot().pm10 != null)}>
                <div class="weather__air">
                  <div class="weather__air-head"><span>Air quality</span><strong>{snapshot().aqi == null ? '—' : snapshot().aqi}<small>{snapshot().aqiLabel || 'US AQI'}</small></strong></div>
                  <Show when={snapshot().aqi != null}><div class="weather__aqi-track" role="meter" aria-valuenow={snapshot().aqi ?? 0} aria-valuemin={0} aria-valuemax={300} aria-label="Air quality index"><span class="weather__aqi-fill" style={{ width: `${aqiPercent(snapshot().aqi ?? 0)}%`, background: aqiColor(snapshot().aqi ?? 0) }} /></div></Show>
                  <div class="weather__particles-values"><Show when={snapshot().pm25 != null}><span>PM2.5 <strong>{snapshot().pm25!.toFixed(1)} μg/m³</strong></span></Show><Show when={snapshot().pm10 != null}><span>PM10 <strong>{snapshot().pm10!.toFixed(1)} μg/m³</strong></span></Show></div>
                </div>
              </Show>
            </Show>

            <Show when={forecastView() === 'hourly'}>
              <div class="weather__forecast-heading"><strong>Next 24 hours</strong><span>{snapshot().timezone || 'Local time'} · model forecast</span></div>
              <div class="weather__hours" role="region" aria-label="24-hour weather forecast" tabindex="0">
                <For each={snapshot().hourly?.slice(0, 24) ?? []}>{(hour, index) => <article class="weather__hour" classList={{ 'weather__hour--current': index() === 0 }} aria-label={`${index() === 0 ? 'Now' : forecastTime(hour.time)}, ${temperature(hour.temperatureC, units())}, ${hour.precipitationProbability ?? 0}% chance of precipitation`}>
                  <span>{index() === 0 ? 'Now' : forecastTime(hour.time)}</span><WeatherIcon code={hour.code} night={index() > 0 && Number(/T(\d{2})/.exec(hour.time)?.[1] ?? 12) < 6} /><strong>{temperature(hour.temperatureC, units())}</strong><small><Droplets size={10} />{hour.precipitationProbability == null ? '—' : `${hour.precipitationProbability}%`}</small>
                </article>}</For>
              </div>
              <p class="weather__forecast-note">Scroll sideways to see all 24 hours.</p>
            </Show>

            <Show when={forecastView() === 'week'}>
              <div class="weather__forecast-heading"><strong>7-day forecast</strong><span>High · low · rain chance</span></div>
              <div class="weather__days" role="region" aria-label="7-day weather forecast">
                <For each={snapshot().daily?.slice(0, 7) ?? []}>{(day, index) => {
                  const bounds = weekBounds()
                  const span = Math.max(1, bounds.max - bounds.min)
                  const start = Math.max(0, (day.lowC - bounds.min) / span * 100)
                  const width = Math.max(4, (day.highC - day.lowC) / span * 100)
                  return <article class="weather__day" aria-label={`${forecastDay(day.date, index())}, ${conditionLabel(day.code)}, high ${temperature(day.highC, units())}, low ${temperature(day.lowC, units())}`}>
                    <span class="weather__day-name">{forecastDay(day.date, index())}</span><span class="weather__day-condition">{conditionLabel(day.code)}</span><div class="weather__day-range"><strong>{temperature(day.lowC, units())}</strong><span><i style={{ left: `${start}%`, width: `${width}%` }} /></span><strong>{temperature(day.highC, units())}</strong></div><span class="weather__day-rain"><Show when={day.precipitationProbability != null}><Droplets size={10} />{day.precipitationProbability}%</Show></span>
                  </article>
                }}</For>
              </div>
              <div class="weather__day-extra"><Show when={snapshot().daily?.[0]?.uvIndexMax != null}><span>UV max <strong>{snapshot().daily![0].uvIndexMax}</strong></span></Show><Show when={snapshot().daily?.[0]?.windSpeedMaxKmh != null}><span>Peak wind <strong>{Math.round(windSpeed(snapshot().daily![0].windSpeedMaxKmh!, units()))} {unitLabel(units())}</strong></span></Show><Show when={snapshot().daily?.[0]?.sunrise && snapshot().daily?.[0]?.sunset}><span>Sunrise <strong>{forecastTime(snapshot().daily![0].sunrise!)}</strong> · Sunset <strong>{forecastTime(snapshot().daily![0].sunset!)}</strong></span></Show></div>
            </Show>

            <footer class="weather__foot"><span>Updated <strong>{relativeTime(snapshot().updatedAt, now())}</strong> · Open-Meteo model{snapshot().stale ? ' · Cached' : ''}</span><Show when={forecastView() !== 'now'}><span class="weather__forecast-disclaimer">Forecasts are estimates.</span></Show></footer>
          </div>
        )}
      </Show>
      </Show>
    </section>
  )
}
