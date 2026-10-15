import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { ChevronDown, CloudOff, CloudSun } from 'lucide-solid'
import { cmd, type WeatherLocation, type WeatherSnapshot } from '../../lib/ipc'
import { flushSettings, patchSettings, settings } from '../../state/settings'
import { requestWidgetDetail } from '../../state/panel'
import './widgets.css'
import './WeatherView.css'

type ConditionGroup = 'clear' | 'partly' | 'cloud' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'thunder'

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
  const [hovered, setHovered] = createSignal(false)
  const [pinned, setPinned] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  const [meterReady, setMeterReady] = createSignal(false)
  const [sceneActive, setSceneActive] = createSignal(false)
  let cardElement: HTMLElement | undefined
  let searchRequest = 0
  let weatherRequest = 0
  let active = true

  const revealed = () => hovered() || pinned()
  const group = createMemo<ConditionGroup>(() => {
    const snapshot = weather()
    return snapshot?.ok ? conditionGroup(snapshot.code) : 'clear'
  })
  const night = createMemo(() => localNight(settings.weatherLat, settings.weatherLon, now()))

  const load = async () => {
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

  const persistLocation = async (lat: number | null, lon: number | null, city: string | null) => {
    setSavingLocation(true)
    setLocationError('')
    try {
      patchSettings({ weatherLat: lat, weatherLon: lon, weatherCity: city })
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

  const useApproximate = () => void persistLocation(null, null, null)

  onMount(() => {
    void load()
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
    const refresh = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 10 * 60 * 1000)
    const tick = window.setInterval(() => {
      if (document.visibilityState === 'visible') setNow(Date.now())
    }, 30 * 1000)
    onCleanup(() => {
      active = false
      weatherRequest++
      searchRequest++
      clearInterval(refresh)
      clearInterval(tick)
      document.removeEventListener('visibilitychange', syncVisibility)
      observer?.disconnect()
    })
  })

  createEffect(() => {
    const snapshot = weather()
    if (!snapshot?.ok || !sceneActive()) {
      setMeterReady(false)
      return
    }
    setMeterReady(false)
    const frame = window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => setMeterReady(true)),
    )
    onCleanup(() => window.cancelAnimationFrame(frame))
  })

  const sourceLabel = () => `Open-Meteo · ${weather()?.locationSource === 'approximate'
    ? 'approximate location'
    : weather()?.locationSource === 'manual' ? 'selected city' : 'nearby forecast'}`

  return (
    <section
      class="weather-card"
      classList={{
        [`weather-card--${group()}`]: true,
        'weather-card--night': night(),
        'weather-card--animated': sceneActive(),
        'weather-card--revealed': revealed(),
      }}
      aria-label="Local weather"
      ref={cardElement}
    >
      <div class="weather__atmos" aria-hidden="true" />
      <div class="weather__scene" aria-hidden="true">
        <div class="weather__orb"/><div class="weather__halo"/>
        <div class="weather__cloud weather__cloud--one"/><div class="weather__cloud weather__cloud--two"/><div class="weather__cloud weather__cloud--three"/>
        <div class="weather__particles"><For each={Array.from({length:18},(_,i)=>i)}>{i=><i style={{'--particle-x':`${(i*37+11)%100}%`,'--particle-delay':`${-i*.73}s`,'--particle-size':`${1+i%3}px`,'--particle-y':`${(i*23+7)%92}%`}}/>}</For></div>
        <div class="weather__horizon"/>
      </div>

      <header class="widget__head">
        <span class="widget__title">
          <CloudSun class="icon icon--sm" strokeWidth={1.7} aria-hidden="true" />
          Weather
        </span>
        <span class="widget__eyebrow" title={sourceLabel()}>
          {weather()?.city || (refreshing() ? 'Finding a nearby area…' : '')}
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
            disabled={savingLocation() || weather()?.locationSource === 'approximate'}
            onClick={useApproximate}
          >
            {savingLocation() ? 'Saving…' : 'Use approximate location'}
          </button>
          <span>Approximate from public IP; no GPS is sent.</span>
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

      <Show when={weather()?.ok ? weather() : undefined} fallback={
        <div class="weather-empty" role="status">
          <span class="weather-empty__glyph" aria-hidden="true">
            <CloudOff size={26} strokeWidth={1.5} />
          </span>
          <div class="weather-empty__message"><strong class="weather-empty__title">
            {weather()?.label || (failed() ? 'Weather unavailable' : 'Finding local weather')}
          </strong><p class="weather-empty__copy">{failed() ? 'Live conditions will retry automatically.' : 'Checking the nearest forecast.'}</p></div>
          <button type="button" class="weather-empty__action" onClick={() => setEditingLocation(true)}>
            {weather()?.city ? 'Change city' : 'Choose city'}
          </button>
        </div>
      }>
        {(snapshot) => (
          <div
            class="weather"
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
          >
            <div class="weather__now">
              <span class="weather__temp">
                {Math.round(snapshot().tempC)}<span class="weather__deg">°</span>
              </span>
              <WeatherIcon code={snapshot().code} night={night()} />
            </div>

            <div class="weather__meta">
              <span class="weather__desc">{snapshot().label}</span>
              <Show when={snapshot().locationSource === 'approximate'}>
                <span class="weather__approx">Approx</span>
              </Show>
            </div>

            <div class="weather__range">
              <span class="weather__range-label">Today</span>
              <span class="weather__range-item"><em>H</em>{Math.round(snapshot().hiC)}°</span>
              <span class="weather__range-item"><em>L</em>{Math.round(snapshot().loC)}°</span>
            </div>

            <Show when={snapshot().aqi != null}>
              <div class="weather__aqi">
                <div class="weather__aqi-head">
                  <span class="weather__aqi-label">Air quality</span>
                  <strong class="weather__aqi-value">
                    {snapshot().aqi}
                    <small>{snapshot().aqiLabel || 'US AQI'}</small>
                  </strong>
                </div>
                <div
                  class="weather__aqi-track"
                  role="meter"
                  aria-valuenow={snapshot().aqi ?? 0}
                  aria-valuemin={0}
                  aria-valuemax={300}
                  aria-label="Air quality index"
                >
                  <span
                    class="weather__aqi-fill"
                    style={{
                      width: `${meterReady() ? aqiPercent(snapshot().aqi ?? 0) : 0}%`,
                      background: aqiColor(snapshot().aqi ?? 0),
                    }}
                  />
                </div>
              </div>
            </Show>

            <div
              class="weather__details"
              classList={{ 'weather__details--open': revealed() }}
              aria-hidden={!revealed()}
            >
              <div class="weather__details-inner">
                <div class="weather__detail">
                  <span class="weather__detail-label">Source</span>
                  <span class="weather__detail-value">{sourceLabel() || 'Live station'}</span>
                </div>
                <div class="weather__detail">
                  <span class="weather__detail-label">Updated</span>
                  <span class="weather__detail-value">{relativeTime(snapshot().updatedAt, now())}</span>
                </div>
                <Show when={snapshot().stale}>
                  <div class="weather__detail">
                    <span class="weather__detail-label">Status</span>
                    <span class="weather__detail-value weather__detail-value--warn">Saved copy</span>
                  </div>
                </Show>
                <Show when={snapshot().aqi != null}>
                  <p class="weather__attribution">Model estimate · CAMS ENSEMBLE / Open-Meteo</p>
                </Show>
              </div>
            </div>

            <div class="weather__foot">
              <span class="weather__updated">
                Updated <strong>{relativeTime(snapshot().updatedAt, now())}</strong>
              </span>
              <button
                type="button"
                class="weather__toggle"
                aria-expanded={revealed()}
                onClick={() => setPinned((value) => !value)}
              >
                {revealed() ? 'Less' : 'Details'}
                <ChevronDown class="weather__chevron" size={12} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
      </Show>
    </section>
  )
}
