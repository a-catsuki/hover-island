export type WeatherLayout = 'compact' | 'wide' | 'tall' | 'full'

/**
 * Layout follows the space actually assigned to the tile.
 * compact: one cell, hero plus an hourly strip.
 * wide: two cells side by side, hero left and hourly plus daily strips right.
 * tall: one column, two rows high, hero then a vertical hourly list and detail tiles.
 * full: wide and tall, current conditions left and the 7-day forecast right.
 */
export function weatherLayout(width: number, height: number): WeatherLayout {
  if (height >= 290) return width >= 560 ? 'full' : 'tall'
  return width >= 380 ? 'wide' : 'compact'
}

/** A tile that is both tall and wide places the forecast list beside the current conditions. */
export function weatherSplit(width: number, height: number): boolean {
  return weatherLayout(width, height) === 'full'
}

export type WeatherOrientationId = 'compact' | 'wide' | 'vertical' | 'large'

export interface WeatherOrientation {
  id: WeatherOrientationId
  /** Short name for a picker. */
  label: string
  /** One line describing what the tile shows. */
  hint: string
  /** Grid cells the tile takes in the 2 x 2 widget grid. */
  columns: 1 | 2
  rows: 1 | 2
  /** Nearest widget size name. `tall` is a one-column, two-row tile. */
  size: 'compact' | 'wide' | 'tall' | 'full'
  /** The layout the weather view switches to when it is given this shape. */
  layout: WeatherLayout
}

/** Every shape the weather widget has a layout for, in picker order. */
export const WEATHER_ORIENTATIONS: readonly WeatherOrientation[] = [
  { id: 'compact', label: 'Compact', hint: 'Temperature and the next few hours', columns: 1, rows: 1, size: 'compact', layout: 'compact' },
  { id: 'wide', label: 'Wide', hint: 'Hourly and daily strips beside the temperature', columns: 2, rows: 1, size: 'wide', layout: 'wide' },
  { id: 'vertical', label: 'Vertical', hint: 'Hourly list and details under the temperature', columns: 1, rows: 2, size: 'tall', layout: 'tall' },
  { id: 'large', label: 'Large', hint: 'Full 7-day forecast and all details', columns: 2, rows: 2, size: 'full', layout: 'full' },
]

export function weatherOrientation(id: string | null | undefined): WeatherOrientation | undefined {
  return WEATHER_ORIENTATIONS.find(item => item.id === id)
}

/** The orientation that matches a grid footprint, or the nearest one that fits inside it. */
export function weatherOrientationFor(columns: number, rows: number): WeatherOrientation {
  const exact = WEATHER_ORIENTATIONS.find(item => item.columns === columns && item.rows === rows)
  if (exact) return exact
  return columns >= 2 ? WEATHER_ORIENTATIONS[rows >= 2 ? 3 : 1] : WEATHER_ORIENTATIONS[rows >= 2 ? 2 : 0]
}

/** Hourly rows that fit in the vertical layout once the header, hero and detail tiles are placed. */
export function weatherVerticalHourCount(height: number, tileRows = 2, max = 24): number {
  if (!Number.isFinite(height) || height <= 0) return 4
  const fixed = 24 + 10 + 60 + 10 + 16 + 10 + tileRows * 62 + Math.max(0, tileRows - 1) * 8
  return Math.max(0, Math.min(max, Math.floor((height - fixed) / 29)))
}

/** How many evenly spaced hourly columns fit; each needs about 52px to stay legible. */
export function weatherHourCount(width: number, max = 24): number {
  if (!Number.isFinite(width) || width <= 0) return 5
  return Math.max(3, Math.min(max, Math.floor(width / 52)))
}

export function canLoadWeather(location: { weatherLat?: number | null; weatherLon?: number | null; weatherCity?: string | null; weatherAutoLocation?: boolean }): boolean {
  const { weatherLat: lat, weatherLon: lon, weatherCity: city } = location
  const manual = typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90
    && typeof lon === 'number' && Number.isFinite(lon) && Math.abs(lon) <= 180 && !!city?.trim()
  // A persisted opt-in flag is not a location. Denied/timed-out OS reads never
  // become an implicit network geolocation request.
  return manual
}

/** A cleared or replaced location must also invalidate already pending replies. */
export function createWeatherLoader<T>(fetch: () => Promise<T>, receive: (value: T | null) => void) {
  let revision = 0
  let enabled = false
  return {
    configure(allowed: boolean) {
      enabled = allowed
      revision++
      receive(null)
    },
    async refresh() {
      if (!enabled) return
      const current = ++revision
      try {
        const value = await fetch()
        if (enabled && revision === current) receive(value)
      } catch {
        if (enabled && revision === current) receive(null)
      }
    },
  }
}

export type TemperatureUnits = 'metric' | 'imperial'

export function normalizeUnits(value: unknown): TemperatureUnits {
  return value === 'imperial' ? 'imperial' : 'metric'
}

/** Rejections from `weather_detect_location` are objects; older builds and the browser preview send strings. */
export interface NormalizedLocationFailure {
  code: string
  message: string
  canOpenSettings: boolean
}

export function normalizeLocationFailure(error: unknown): NormalizedLocationFailure {
  const fallback = 'Could not find your location. Pick a city instead.'
  if (typeof error === 'string') return { code: 'unavailable', message: error.replace(/^Error:\s*/, '') || fallback, canOpenSettings: false }
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown; canOpenSettings?: unknown }
    const message = typeof value.message === 'string' && value.message.trim() ? value.message : fallback
    const code = typeof value.code === 'string' ? value.code : 'unavailable'
    return { code, message, canOpenSettings: value.canOpenSettings === true || code === 'windows_disabled' }
  }
  return { code: 'unavailable', message: fallback, canOpenSettings: false }
}

/** Device location drifts for people who travel; re-check at most every few hours, and only if they opted in. */
export const DEVICE_RECHECK_MS = 3 * 60 * 60 * 1000

export function shouldRecheckDeviceLocation(autoLocation: boolean, lastCheckedAt: number | null, now: number): boolean {
  if (!autoLocation) return false
  if (lastCheckedAt == null || !Number.isFinite(lastCheckedAt)) return true
  return now - lastCheckedAt >= DEVICE_RECHECK_MS
}

/** Roughly 1 km. Smaller moves are not worth a new forecast or a settings write. */
export function movedFar(from: { lat?: number | null; lon?: number | null }, to: { latitude: number; longitude: number }): boolean {
  if (typeof from.lat !== 'number' || typeof from.lon !== 'number') return true
  return Math.abs(from.lat - to.latitude) > 0.02 || Math.abs(from.lon - to.longitude) > 0.02
}
