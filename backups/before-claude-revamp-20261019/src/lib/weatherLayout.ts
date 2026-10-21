export type WeatherLayout = 'compact' | 'wide' | 'full'

/** Layout follows the space actually assigned to the tile, including detail mode. */
export function weatherLayout(width: number, height: number): WeatherLayout {
  if (height >= 255) return 'full'
  return width >= 380 ? 'wide' : 'compact'
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
