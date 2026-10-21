import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'
import { CloudOff, LocateFixed, MapPin, Search, X } from 'lucide-solid'
import { cmd, type WeatherLocation, type WeatherSnapshot } from '../lib/ipc'
import { canLoadWeather, normalizeLocationFailure, normalizeUnits, type NormalizedLocationFailure } from '../lib/weatherLayout'
import { flushSettings, patchSettings, settings } from '../state/settings'
import WeatherGlyph, { weatherKind } from '../components/widgets/WeatherGlyph'
import { Group, Segmented } from './controls'
import './LocationPanel.css'

type Method = 'windows' | 'network' | 'manual'
const METHOD_KEY = 'hover-island.weather-location-method'
const DEVICE_CHECK_KEY = 'hover-island.weather-device-check'

function readMethod(): Method | null {
  try {
    const value = localStorage.getItem(METHOD_KEY)
    return value === 'windows' || value === 'network' || value === 'manual' ? value : null
  } catch { return null }
}

function writeMethod(method: Method) {
  try { localStorage.setItem(METHOD_KEY, method) } catch { /* The label falls back to a generic one. */ }
}

function markDeviceChecked() {
  try { localStorage.setItem(DEVICE_CHECK_KEY, String(Date.now())) } catch { /* Only delays the next quiet re-check. */ }
}

function toUnit(celsius: number, imperial: boolean): number {
  return Math.round(imperial ? celsius * 9 / 5 + 32 : celsius)
}

function describe(location: WeatherLocation): string {
  return [location.admin1, location.country].filter(Boolean).join(', ')
}

export default function LocationPanel() {
  const [query, setQuery] = createSignal('')
  const [results, setResults] = createSignal<WeatherLocation[]>([])
  const [searching, setSearching] = createSignal(false)
  const [searchMessage, setSearchMessage] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [detecting, setDetecting] = createSignal(false)
  const [failure, setFailure] = createSignal<NormalizedLocationFailure | null>(null)
  const [notice, setNotice] = createSignal<{ text: string; canOpenSettings: boolean } | null>(null)
  const [saveError, setSaveError] = createSignal('')
  const [preview, setPreview] = createSignal<WeatherSnapshot | null>(null)
  const [previewFailed, setPreviewFailed] = createSignal(false)
  const [method, setMethod] = createSignal<Method | null>(readMethod())
  let searchRequest = 0
  let previewRequest = 0
  let debounce: number | undefined
  let searchInput: HTMLInputElement | undefined
  let active = true

  const imperial = () => normalizeUnits(settings.weatherUnits) === 'imperial'
  const hasLocation = () => canLoadWeather(settings)

  const sourceLabel = () => {
    if (!hasLocation()) return ''
    if (settings.weatherAutoLocation) return method() === 'network' ? 'Based on your network' : 'Device location'
    return 'Selected city'
  }

  const loadPreview = async () => {
    const current = ++previewRequest
    if (!hasLocation()) { setPreview(null); setPreviewFailed(false); return }
    try {
      const snapshot = await cmd.weatherGet()
      if (!active || current !== previewRequest) return
      setPreview(snapshot?.ok ? snapshot : null)
      setPreviewFailed(!snapshot?.ok)
    } catch {
      if (active && current === previewRequest) { setPreview(null); setPreviewFailed(true) }
    }
  }

  onMount(() => {
    void loadPreview()
    onCleanup(() => { active = false; searchRequest++; previewRequest++; window.clearTimeout(debounce) })
  })

  // Follow changes that come from anywhere: this panel, the widget, another window.
  createEffect(on(
    () => [settings.weatherLat, settings.weatherLon, settings.weatherCity] as const,
    () => { setPreview(null); void loadPreview() },
    { defer: true },
  ))

  const runSearch = async (text: string) => {
    const value = text.trim()
    const current = ++searchRequest
    setSearchMessage('')
    if (value.length < 2) {
      setResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    try {
      const found = await cmd.weatherSearch(value)
      if (!active || current !== searchRequest) return
      setResults(found ?? [])
      if (!found?.length) setSearchMessage(`No cities found for "${value}".`)
    } catch {
      if (active && current === searchRequest) {
        setResults([])
        setSearchMessage('City search is unavailable. Check your connection and try again.')
      }
    } finally {
      if (active && current === searchRequest) setSearching(false)
    }
  }

  const onQuery = (value: string) => {
    setQuery(value)
    window.clearTimeout(debounce)
    if (value.trim().length < 2) { searchRequest++; setResults([]); setSearchMessage(''); setSearching(false); return }
    debounce = window.setTimeout(() => void runSearch(value), 280)
  }

  const save = async (patch: { lat: number | null; lon: number | null; city: string | null; device: boolean }, how: Method) => {
    setBusy(true)
    setSaveError('')
    try {
      patchSettings({ weatherLat: patch.lat, weatherLon: patch.lon, weatherCity: patch.city, weatherAutoLocation: patch.device })
      await flushSettings()
      writeMethod(how)
      setMethod(how)
      return true
    } catch {
      if (active) setSaveError('Could not save this location. Try again.')
      return false
    } finally {
      if (active) setBusy(false)
    }
  }

  const choose = async (location: WeatherLocation) => {
    setFailure(null)
    setNotice(null)
    const saved = await save({ lat: location.latitude, lon: location.longitude, city: location.name, device: false }, 'manual')
    if (saved && active) { setQuery(''); setResults([]); setSearchMessage('') }
  }

  const useDevice = async () => {
    if (detecting() || busy()) return
    setDetecting(true)
    setFailure(null)
    setNotice(null)
    setSaveError('')
    try {
      const found = await cmd.weatherDetectLocation()
      if (!active) return
      const { location } = found
      const saved = await save({ lat: location.latitude, lon: location.longitude, city: location.name, device: true }, found.method === 'network' ? 'network' : 'windows')
      if (saved) {
        markDeviceChecked()
        if (found.notice) setNotice({ text: found.notice, canOpenSettings: !!found.canOpenSettings })
      }
    } catch (error) {
      if (active) setFailure(normalizeLocationFailure(error))
    } finally {
      if (active) setDetecting(false)
    }
  }

  const clear = async () => {
    setFailure(null)
    setNotice(null)
    setPreview(null)
    await save({ lat: null, lon: null, city: null, device: false }, 'manual')
  }

  const openWindowsLocation = () => {
    void cmd.weatherOpenLocationSettings().catch(() => {
      setFailure({ code: 'unavailable', message: 'Open Settings, then Privacy and security, then Location.', canOpenSettings: false })
    })
  }

  const focusSearch = () => searchInput?.focus()

  const kind = () => weatherKind(preview()?.code ?? 3)
  const sky = () => `${kind()}-${preview()?.isDay === false ? 'night' : 'day'}`

  return (
    <div class="loc">
      <section class="loc__preview" data-sky={sky()} data-state={preview() ? 'ready' : hasLocation() ? (previewFailed() ? 'failed' : 'loading') : 'empty'} aria-label="Current weather preview">
        <Show when={preview()} fallback={
          <div class="loc__preview-empty" role="status">
            <CloudOff size={22} strokeWidth={1.5} aria-hidden="true" />
            <strong>{!hasLocation() ? 'No location set' : previewFailed() ? 'Weather unavailable' : 'Loading weather'}</strong>
            <span>{!hasLocation() ? 'Search for a city or use this device.' : previewFailed() ? 'Check your connection. Your location is saved.' : 'Getting your forecast.'}</span>
            <Show when={hasLocation() && previewFailed()}><button type="button" class="loc__chip" onClick={() => void loadPreview()}>Try again</button></Show>
          </div>
        }>
          {(snapshot) => (
            <>
              <div class="loc__now">
                <span class="loc__city"><MapPin size={12} aria-hidden="true" />{snapshot().city || settings.weatherCity}</span>
                <span class="loc__temp">{toUnit(snapshot().tempC, imperial())}°</span>
                <span class="loc__cond">{snapshot().label}</span>
                <span class="loc__hl">H:{toUnit(snapshot().hiC, imperial())}° L:{toUnit(snapshot().loC, imperial())}°</span>
              </div>
              <WeatherGlyph class="loc__glyph" code={snapshot().code} night={snapshot().isDay === false} />
              <Show when={(snapshot().hourly ?? []).length > 0}>
                <ul class="loc__hours" aria-label="Next hours">
                  <For each={(snapshot().hourly ?? []).slice(0, 6)}>{(hour, index) => (
                    <li>
                      <span>{index() === 0 ? 'Now' : (/T(\d{2})/.exec(hour.time)?.[1] ?? '').replace(/^0/, '') + ':00'}</span>
                      <WeatherGlyph code={hour.code} night={snapshot().isDay === false} />
                      <b>{toUnit(hour.temperatureC, imperial())}°</b>
                    </li>
                  )}</For>
                </ul>
              </Show>
            </>
          )}
        </Show>
      </section>

      <Group title="Saved location" description="Only an approximate area is saved, and only on this PC. It is sent to Open-Meteo to get the forecast.">
        <div class="loc__saved">
          <Show when={hasLocation()} fallback={<span class="loc__muted">Nothing saved yet.</span>}>
            <span class="loc__saved-icon" aria-hidden="true">{settings.weatherAutoLocation ? <LocateFixed size={16} /> : <MapPin size={16} />}</span>
            <span class="loc__saved-text">
              <strong>{settings.weatherCity}</strong>
              <small>{sourceLabel()}</small>
            </span>
            <button type="button" class="button loc__clear" disabled={busy()} onClick={() => void clear()}>Clear</button>
          </Show>
        </div>
        <Show when={saveError()}><p class="loc__error" role="alert">{saveError()}</p></Show>
      </Group>

      <Group title="Device location">
        <div class="loc__device">
          <div class="loc__device-row">
            <span class="loc__device-text">
              <strong>Use this device</strong>
              <small>Uses Windows location, or your network if that is off.</small>
            </span>
            <button type="button" class="button button--primary" disabled={detecting() || busy()} onClick={() => void useDevice()}>
              <LocateFixed size={14} aria-hidden="true" />{detecting() ? 'Locating…' : 'Use device location'}
            </button>
          </div>
          <Show when={failure()}>
            {(problem) => (
              <div class="loc__alert loc__alert--error" role="alert">
                <p>{problem().message}</p>
                <div class="loc__alert-actions">
                  <Show when={problem().canOpenSettings}>
                    <button type="button" class="button button--primary" onClick={openWindowsLocation}>Turn on location in Windows</button>
                  </Show>
                  <button type="button" class="button" onClick={focusSearch}>Pick a city</button>
                  <Show when={problem().code !== 'windows_disabled'}>
                    <button type="button" class="button" disabled={detecting()} onClick={() => void useDevice()}>Try again</button>
                  </Show>
                </div>
              </div>
            )}
          </Show>
          <Show when={notice()}>
            {(info) => (
              <div class="loc__alert" role="status">
                <p>{info().text}</p>
                <Show when={info().canOpenSettings}>
                  <div class="loc__alert-actions">
                    <button type="button" class="button" onClick={openWindowsLocation}>Open Windows location settings</button>
                  </div>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </Group>

      <Group title="Choose a city" flush>
        <div class="loc__search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchInput}
            type="search"
            value={query()}
            placeholder="Search for a city"
            aria-label="Search for a city"
            autocomplete="off"
            spellcheck={false}
            maxlength={80}
            onInput={(event) => onQuery(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { window.clearTimeout(debounce); void runSearch(query()) } }}
          />
          <Show when={query()}>
            <button type="button" class="loc__search-clear" aria-label="Clear search" onClick={() => { onQuery(''); focusSearch() }}><X size={13} /></button>
          </Show>
        </div>
        <Show when={searching() || searchMessage() || results().length > 0}>
          <div class="loc__results" role="listbox" aria-label="Matching cities">
            <Show when={searching() && results().length === 0}><p class="loc__muted loc__results-note">Searching…</p></Show>
            <Show when={searchMessage()}><p class="loc__muted loc__results-note">{searchMessage()}</p></Show>
            <For each={results()}>{(location) => (
              <button type="button" class="loc__result" role="option" aria-selected="false" disabled={busy()} onClick={() => void choose(location)}>
                <MapPin size={14} aria-hidden="true" />
                <span>{location.name}</span>
                <small>{describe(location)}</small>
              </button>
            )}</For>
          </div>
        </Show>
      </Group>

      <Group title="Units">
        <Segmented
          label="Temperature and wind"
          hint={imperial() ? 'Fahrenheit and miles per hour' : 'Celsius and kilometers per hour'}
          ariaLabel="Weather units"
          value={normalizeUnits(settings.weatherUnits)}
          options={[['metric', '°C'], ['imperial', '°F']] as const}
          onChange={(value) => patchSettings({ weatherUnits: value })}
        />
      </Group>
    </div>
  )
}
