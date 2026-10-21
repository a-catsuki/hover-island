import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Check, Droplets, Ellipsis, LocateFixed, MapPin, Navigation, RefreshCw, Sun, Wind, Gauge, CloudOff } from 'lucide-solid'
import { canLoadWeather, movedFar, normalizeUnits, shouldRecheckDeviceLocation, weatherHourCount, weatherLayout, weatherSplit, weatherVerticalHourCount, type WeatherLayout } from '../../lib/weatherLayout'
import { cmd, type WeatherDay, type WeatherHour, type WeatherSnapshot } from '../../lib/ipc'
import { patchSettings, settings } from '../../state/settings'
import { open as islandOpen } from '../../state/ui'
import WeatherGlyph, { weatherKind } from './WeatherGlyph'
import './WeatherView.css'

type WeatherUnits = 'metric' | 'imperial'
const UNIT_KEY = 'hover-island.weather-units'
const DEVICE_CHECK_KEY = 'hover-island.weather-device-check'
const REFRESH_MS = 10 * 60 * 1000

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

function forecastWeekday(value: string): string {
  const date = new Date(`${value}T12:00:00`)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date)
}

function compass(degrees?: number | null): string {
  if (degrees == null || !Number.isFinite(degrees)) return '—'
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((degrees % 360) + 360) % 360) / 45) % 8]
}

/** Older builds kept the unit in this window's storage; carry it over once. */
function legacyUnits(): WeatherUnits | null {
  try { return localStorage.getItem(UNIT_KEY) === 'imperial' ? 'imperial' : null } catch { return null }
}

function readDeviceCheck(): number | null {
  try { const value = Number(localStorage.getItem(DEVICE_CHECK_KEY)); return Number.isFinite(value) && value > 0 ? value : null } catch { return null }
}

function writeDeviceCheck(at: number) {
  try { localStorage.setItem(DEVICE_CHECK_KEY, String(at)) } catch { /* A missed write only means one extra check later. */ }
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

type ForecastKind = ReturnType<typeof weatherKind>

const TEMP_STOPS: Array<[number, [number, number, number]]> = [
  [0, [100, 210, 255]], [14, [48, 209, 88]], [24, [255, 214, 10]], [33, [255, 159, 10]], [42, [255, 69, 58]],
]

function tempColor(celsiusValue: number): string {
  const value = Math.max(TEMP_STOPS[0][0], Math.min(TEMP_STOPS[TEMP_STOPS.length - 1][0], celsiusValue))
  for (let index = 1; index < TEMP_STOPS.length; index++) {
    const [stop, color] = TEMP_STOPS[index]
    const [previousStop, previous] = TEMP_STOPS[index - 1]
    if (value <= stop) {
      const t = (value - previousStop) / (stop - previousStop || 1)
      return `rgb(${previous.map((channel, i) => Math.round(channel + (color[i] - channel) * t)).join(',')})`
    }
  }
  return 'rgb(255,69,58)'
}

function degrees(value: number, units: WeatherUnits): string {
  return `${Math.round(celsius(value, units))}°`
}

function hourOf(value?: string | null, fallback = 12): number {
  const match = /T(\d{2})/.exec(value ?? '')
  return match ? Number(match[1]) : fallback
}

function hourIsNight(time: string, today?: WeatherDay): boolean {
  const hour = hourOf(time)
  return hour < hourOf(today?.sunrise, 6) || hour >= hourOf(today?.sunset, 19)
}

function uvLabel(value: number): string {
  if (value < 3) return 'Low'
  if (value < 6) return 'Moderate'
  if (value < 8) return 'High'
  if (value < 11) return 'Very high'
  return 'Extreme'
}

function aqiWord(label?: string | null): string {
  if (!label) return ''
  const parts = label.split('·').map((part) => part.trim()).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 1] : parts[0] === 'US AQI' ? '' : parts[0] ?? ''
}

function skyFor(kind: ForecastKind, night: boolean): string {
  return `${kind}-${night ? 'night' : 'day'}`
}

function HourlyStrip(props: { hours: WeatherHour[]; today?: WeatherDay; units: WeatherUnits }) {
  return (
    <ul class="wx__hours" style={{ '--wx-n': props.hours.length }} aria-label="Upcoming hourly forecast">
      <For each={props.hours}>{(hour, index) => {
        const chance = () => hour.precipitationProbability ?? 0
        return (
          <li class="wx__hour" aria-label={`${index() === 0 ? 'Now' : forecastTime(hour.time)}, ${degrees(hour.temperatureC, props.units)}, ${chance()}% chance of precipitation`}>
            <span class="wx__hour-time">{index() === 0 ? 'Now' : forecastTime(hour.time)}</span>
            <span class="wx__hour-glyph"><WeatherGlyph code={hour.code} night={hourIsNight(hour.time, props.today)} /><Show when={chance() >= 20}><small>{chance()}%</small></Show></span>
            <span class="wx__hour-temp">{degrees(hour.temperatureC, props.units)}</span>
          </li>
        )
      }}</For>
    </ul>
  )
}

function HourlyList(props: { hours: WeatherHour[]; today?: WeatherDay; units: WeatherUnits }) {
  const bounds = () => {
    const values = props.hours.map((hour) => hour.temperatureC)
    return { min: Math.min(...values), max: Math.max(...values) }
  }
  const pos = (value: number) => {
    const { min, max } = bounds()
    return max === min ? 50 : 14 + (value - min) / (max - min) * 86
  }
  return (
    <ul class="wx__vhours" aria-label="Upcoming hourly forecast">
      <For each={props.hours}>{(hour, index) => {
        const chance = () => hour.precipitationProbability ?? 0
        return (
          <li class="wx__vhour" aria-label={`${index() === 0 ? 'Now' : forecastTime(hour.time)}, ${degrees(hour.temperatureC, props.units)}, ${chance()}% chance of precipitation`}>
            <span class="wx__hour-time">{index() === 0 ? 'Now' : forecastTime(hour.time)}</span>
            <span class="wx__vhour-glyph"><WeatherGlyph code={hour.code} night={hourIsNight(hour.time, props.today)} /><Show when={chance() >= 20}><small>{chance()}%</small></Show></span>
            <span class="wx__vhour-bar"><i style={{ width: `${pos(hour.temperatureC)}%`, background: `linear-gradient(90deg, ${tempColor(bounds().min)}, ${tempColor(hour.temperatureC)})` }} /></span>
            <span class="wx__hour-temp">{degrees(hour.temperatureC, props.units)}</span>
          </li>
        )
      }}</For>
    </ul>
  )
}

function DayStrip(props: { days: WeatherDay[]; units: WeatherUnits }) {
  return (
    <ul class="wx__daystrip" style={{ '--wx-n': props.days.length }} aria-label="Upcoming days">
      <For each={props.days}>{(day, index) => (
        <li aria-label={`${forecastDay(day.date, index())}, ${conditionLabel(day.code)}, high ${degrees(day.highC, props.units)}, low ${degrees(day.lowC, props.units)}`}>
          <span class="wx__hour-time">{index() === 0 ? 'Today' : forecastDay(day.date, index())}</span>
          <WeatherGlyph code={day.code} />
          <span class="wx__daystrip-range"><b>{degrees(day.highC, props.units)}</b><span>{degrees(day.lowC, props.units)}</span></span>
        </li>
      )}</For>
    </ul>
  )
}

function DayList(props: { days: WeatherDay[]; units: WeatherUnits; bounds: { min: number; max: number }; currentC: number }) {
  const span = () => Math.max(1, props.bounds.max - props.bounds.min)
  const pos = (value: number) => Math.max(0, Math.min(100, (value - props.bounds.min) / span() * 100))
  return (
    <ul class="wx__days" aria-label="7-day weather forecast">
      <For each={props.days}>{(day, index) => {
        const start = () => pos(day.lowC)
        const end = () => Math.max(start() + 8, pos(day.highC))
        return (
          <li class="wx__day" aria-label={`${forecastDay(day.date, index())}, ${conditionLabel(day.code)}, high ${degrees(day.highC, props.units)}, low ${degrees(day.lowC, props.units)}`}>
            <span class="wx__day-name">{index() === 0 ? 'Today' : forecastWeekday(day.date)}</span>
            <span class="wx__day-glyph"><WeatherGlyph code={day.code} /><Show when={(day.precipitationProbability ?? 0) >= 20}><small>{day.precipitationProbability}%</small></Show></span>
            <span class="wx__day-low">{degrees(day.lowC, props.units)}</span>
            <span class="wx__day-bar">
              <i style={{ left: `${start()}%`, width: `${Math.min(100 - start(), end() - start())}%`, background: `linear-gradient(90deg, ${tempColor(day.lowC)}, ${tempColor(day.highC)})` }} />
              <Show when={index() === 0}><b style={{ left: `${pos(props.currentC)}%` }} /></Show>
            </span>
            <span class="wx__day-high">{degrees(day.highC, props.units)}</span>
          </li>
        )
      }}</For>
    </ul>
  )
}

export default function WeatherView() {
  const [weather, setWeather] = createSignal<WeatherSnapshot | null>(null)
  const [failed, setFailed] = createSignal(false)
  const [refreshing, setRefreshing] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  const [sceneActive, setSceneActive] = createSignal(false)
  const [size, setSize] = createSignal({ width: 342, height: 201 })
  const [menuOpen, setMenuOpen] = createSignal(false)
  let cardElement: HTMLElement | undefined
  let menuElement: HTMLDivElement | undefined
  let moreButton: HTMLButtonElement | undefined
  let weatherRequest = 0
  let active = true
  let lastLoadedAt = 0
  let recheckRunning = false

  const units = createMemo<WeatherUnits>(() => normalizeUnits(settings.weatherUnits))
  const openLocation = () => {
    setMenuOpen(false)
    void cmd.openSettings('location').catch(() => { /* The settings window reports its own errors. */ })
  }

  const layout = createMemo<WeatherLayout>(() => weatherLayout(size().width, size().height))
  const split = createMemo(() => weatherSplit(size().width, size().height))
  const hasLocation = () => canLoadWeather(settings)
  const kind = createMemo<ForecastKind>(() => {
    const snapshot = weather()
    return snapshot?.ok ? weatherKind(snapshot.code) : 'cloud'
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
  const showSky = () => !!weather()?.ok
  const setWeatherUnits = (value: WeatherUnits) => patchSettings({ weatherUnits: value })

  const load = async () => {
    if (!hasLocation()) { setWeather(null); return }
    const current = ++weatherRequest
    setRefreshing(true)
    try {
      const snapshot = await cmd.weatherGet()
      if (!active || current !== weatherRequest) return
      setWeather(snapshot)
      setFailed(!snapshot?.ok)
      if (snapshot?.ok) lastLoadedAt = Date.now()
    } catch {
      if (active && current === weatherRequest) setFailed(true)
    } finally {
      if (active && current === weatherRequest) setRefreshing(false)
    }
  }

  /**
   * People who opted into device location can move. Re-check quietly every few
   * hours while the widget is on screen. Failures keep the last saved city, so
   * the forecast never disappears because a lookup did.
   */
  const recheckDeviceLocation = async () => {
    if (recheckRunning || !shouldRecheckDeviceLocation(settings.weatherAutoLocation, readDeviceCheck(), Date.now())) return
    recheckRunning = true
    writeDeviceCheck(Date.now())
    try {
      const found = await cmd.weatherDetectLocation()
      if (!active || !settings.weatherAutoLocation) return
      const { location } = found
      if (movedFar({ lat: settings.weatherLat, lon: settings.weatherLon }, location)) {
        patchSettings({ weatherLat: location.latitude, weatherLon: location.longitude, weatherCity: location.name })
      }
    } catch { /* Keep the saved location. */ } finally {
      recheckRunning = false
    }
  }

  onMount(() => {
    const carried = legacyUnits()
    if (carried && settings.weatherUnits !== carried) patchSettings({ weatherUnits: carried })
    try { localStorage.removeItem(UNIT_KEY) } catch { /* Nothing to clean up. */ }
    void load()
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
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
    const onPointerDown = (event: PointerEvent) => {
      if (menuOpen() && !menuElement?.contains(event.target as Node) && !moreButton?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !menuOpen()) return
      event.stopPropagation()
      setMenuOpen(false)
      moreButton?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    onCleanup(() => {
      active = false
      weatherRequest++
      document.removeEventListener('visibilitychange', syncVisibility)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
      observer?.disconnect()
      resize?.disconnect()
      cardElement?.closest('.widget')?.removeAttribute('data-sky')
    })
  })

  // Only poll while the widget is actually on screen. Coming back after a while
  // refreshes straight away instead of waiting for the next tick.
  createEffect(() => {
    if (!sceneActive() || !islandOpen() || !hasLocation()) return
    setNow(Date.now())
    if (Date.now() - lastLoadedAt >= REFRESH_MS) void load()
    void recheckDeviceLocation()
    const refresh = window.setInterval(() => void load(), REFRESH_MS)
    const tick = window.setInterval(() => setNow(Date.now()), 30 * 1000)
    onCleanup(() => { clearInterval(refresh); clearInterval(tick) })
  })

  // The location is picked in the Settings window. Follow it as soon as it changes.
  let locationKey = `${settings.weatherLat}|${settings.weatherLon}|${settings.weatherCity}|${settings.weatherAutoLocation}`
  createEffect(() => {
    const next = `${settings.weatherLat}|${settings.weatherLon}|${settings.weatherCity}|${settings.weatherAutoLocation}`
    if (next === locationKey) return
    locationKey = next
    weatherRequest++
    lastLoadedAt = 0
    setWeather(null)
    setFailed(false)
    void load()
  })

  createEffect(() => {
    if (!hasLocation()) {
      weatherRequest++
      setWeather(null)
      setRefreshing(false)
    }
  })

  // The sky is painted on the widget platter itself so it reaches every edge.
  createEffect(() => {
    const host = cardElement?.closest('.widget')
    if (!host) return
    if (showSky()) host.setAttribute('data-sky', skyFor(kind(), night()))
    else host.removeAttribute('data-sky')
  })

  const sourceLabel = () => weather()?.locationSource === 'device'
    ? 'Device location'
    : weather()?.locationSource === 'manual' ? 'Selected city' : 'Nearby forecast'

  const hourCount = () => weatherHourCount(split() ? size().width * 0.45 : size().width - (layout() === 'wide' ? 250 : 0))
  const hours = (snapshot: WeatherSnapshot) => (snapshot.hourly ?? []).slice(0, hourCount())
  // Rows that fit under the hero, hourly strip and detail tiles in a narrow, tall tile.
  const dayCount = () => {
    if (split()) return 7
    const spare = size().height - 24 - 80 - 78 - 74 - 40
    return Math.max(0, Math.min(7, Math.floor(spare / 26)))
  }
  const days = (snapshot: WeatherSnapshot) => (snapshot.daily ?? []).slice(0, 7)
  const tall = () => layout() === 'tall'
  // The vertical layout trades detail tiles for forecast rows as the tile gets shorter.
  const tileRows = () => size().height >= 400 ? 2 : 1
  const verticalHours = (snapshot: WeatherSnapshot) => (snapshot.hourly ?? []).slice(0, Math.max(weatherVerticalHourCount(size().height, tileRows()), 12))

  const Tiles = (props: { snapshot: WeatherSnapshot }) => {
    const s = () => props.snapshot
    const uv = () => s().daily?.[0]?.uvIndexMax
    const room = () => tall() ? tileRows() * 2 : Math.max(1, Math.min(4, Math.floor((size().width + 8) / 84)))
    return (
      <div class="wx__tiles" aria-label="Current weather details" style={{ '--wx-cols': split() || tall() ? 2 : room() }} data-count={room()}>
        <Show when={s().humidityPct != null}>
          <div class="wx__tile"><span class="wx__tile-label"><Droplets size={11} />Humidity</span><strong>{s().humidityPct}%</strong><small>{s().feelsLikeC != null ? `Feels ${degrees(s().feelsLikeC!, units())}` : ''}</small></div>
        </Show>
        <Show when={s().windSpeedKmh != null}>
          <div class="wx__tile"><span class="wx__tile-label"><Wind size={11} />Wind</span><strong>{Math.round(windSpeed(s().windSpeedKmh ?? 0, units()))}<em>{unitLabel(units())}</em></strong><small>{compass(s().windDirectionDeg)}</small></div>
        </Show>
        <Show when={s().aqi != null}>
          <div class="wx__tile"><span class="wx__tile-label"><Gauge size={11} />Air quality</span><strong>{s().aqi}</strong><small class="wx__tile-aqi">{split() ? (s().aqiLabel || 'US AQI') : 'US AQI'}</small></div>
        </Show>
        <Show when={uv() != null}>
          <div class="wx__tile"><span class="wx__tile-label"><Sun size={11} />UV index</span><strong>{Math.round(uv()!)}</strong><small>{uvLabel(uv()!)}</small></div>
        </Show>
      </div>
    )
  }

  return (
    <section
      class="wx"
      classList={{
        [`wx--${layout()}`]: true,
        'wx--split': split(),
        'wx--night': night(),
        'wx--empty': !weather()?.ok,
      }}
      aria-label="Local weather"
      ref={cardElement}
    >
      <Show when={weather()?.ok ? weather() : undefined} fallback={
        <div class="wx__empty" role="status">
          <CloudOff size={28} strokeWidth={1.5} aria-hidden="true" />
          <strong>{!hasLocation() ? 'Choose a location' : failed() ? 'Weather unavailable' : 'Loading weather'}</strong>
          <p>{!hasLocation()
            ? 'Pick a city or use this device.'
            : failed() ? (weather()?.label || 'Check your connection and try again.') : 'Getting your forecast.'}</p>
          <div class="wx__empty-actions">
            <Show when={hasLocation() && failed()}>
              <button type="button" class="wx__ghost" disabled={refreshing()} onClick={() => void load()}>{refreshing() ? 'Trying…' : 'Try again'}</button>
            </Show>
            <button type="button" onClick={openLocation}>{hasLocation() ? 'Change city' : 'Set up'}</button>
          </div>
        </div>
      }>
        {(snapshot) => (
          <>
            <header class="wx__top">
              <button type="button" class="wx__city" aria-label={`${snapshot().city || 'Weather'}. Change location`} title={sourceLabel()} onClick={openLocation}>
                <Show when={snapshot().locationSource === 'device'} fallback={<Navigation size={10} fill="currentColor" aria-hidden="true" />}><LocateFixed size={11} aria-hidden="true" /></Show>
                <span>{snapshot().city}</span>
                <Show when={snapshot().stale}><em>Cached</em></Show>
              </button>
              <button ref={moreButton} type="button" class="wx__more" aria-label="Weather options" aria-haspopup="menu" aria-expanded={menuOpen()} onClick={() => setMenuOpen((value) => !value)}>
                <Ellipsis size={16} aria-hidden="true" />
              </button>
              <Show when={menuOpen()}>
                <div class="wx__menu" role="menu" aria-label="Weather options" ref={menuElement}>
                  <button type="button" role="menuitem" aria-label="Refresh weather" disabled={refreshing()} onClick={() => { void load(); setMenuOpen(false) }}>
                    <RefreshCw size={14} class={refreshing() ? 'wx__spin' : ''} aria-hidden="true" /><span>Refresh</span><small>{relativeTime(snapshot().updatedAt, now())}</small>
                  </button>
                  <div class="wx__units" role="group" aria-label="Temperature units">
                    <button type="button" aria-label="Metric units, Celsius and kilometers per hour" aria-pressed={units() === 'metric'} onClick={() => setWeatherUnits('metric')}>°C</button>
                    <button type="button" aria-label="Imperial units, Fahrenheit and miles per hour" aria-pressed={units() === 'imperial'} onClick={() => setWeatherUnits('imperial')}>°F</button>
                  </div>
                  <button type="button" role="menuitem" onClick={openLocation}><MapPin size={14} aria-hidden="true" /><span>Change location</span></button>
                </div>
              </Show>
            </header>

            <div class="wx__body">
              <div class="wx__main">
                <div class="wx__hero">
                  <div class="wx__now">
                    <span class="wx__temp">{degrees(snapshot().tempC, units())}</span>
                    <span class="wx__cond">{snapshot().label || conditionLabel(snapshot().code)}</span>
                    <span class="wx__hl">H:{degrees(snapshot().hiC, units())} L:{degrees(snapshot().loC, units())}</span>
                  </div>
                  <WeatherGlyph class="wx__glyph" code={snapshot().code} night={night()} />
                </div>

                <Show when={(layout() === 'compact' || split()) && hours(snapshot()).length > 0}>
                  <HourlyStrip hours={hours(snapshot())} today={snapshot().daily?.[0]} units={units()} />
                </Show>

                <Show when={tall()}>
                  <Show when={verticalHours(snapshot()).length > 0}>
                    <HourlyList hours={verticalHours(snapshot())} today={snapshot().daily?.[0]} units={units()} />
                  </Show>
                  <Tiles snapshot={snapshot()} />
                </Show>

                <Show when={split()}><Tiles snapshot={snapshot()} /></Show>
              </div>

              <Show when={layout() === 'wide'}>
                <div class="wx__aside">
                  <HourlyStrip hours={hours(snapshot())} today={snapshot().daily?.[0]} units={units()} />
                  <Show when={days(snapshot()).length > 1}><DayStrip days={days(snapshot()).slice(0, Math.max(3, Math.min(6, weatherHourCount(size().width - 250, 7))))} units={units()} /></Show>
                </div>
              </Show>

              <Show when={split()}>
                <div class="wx__aside">
                  <span class="wx__caption">7-day forecast</span>
                  <DayList days={days(snapshot())} units={units()} bounds={weekBounds()} currentC={snapshot().tempC} />
                </div>
              </Show>
            </div>
          </>
        )}
      </Show>
    </section>
  )
}
