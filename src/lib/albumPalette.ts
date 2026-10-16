export interface AlbumPalette {
  dominant: string
  secondary: string
  highlight: string
}

const MAX_CACHE = 32
const paletteCache = new Map<string, AlbumPalette | null>()
const pending = new Map<string, Promise<AlbumPalette | null>>()

const hex = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
const toHex = (rgb: readonly number[]) => `#${hex(rgb[0])}${hex(rgb[1])}${hex(rgb[2])}`

/** Deterministic, lightweight color selection suitable for thumbnail pixels and unit tests. */
export function paletteFromPixels(data: ArrayLike<number>): AlbumPalette | null {
  const colors: Array<{ rgb: [number, number, number]; weight: number; saturation: number; lightness: number }> = []
  for (let index = 0; index + 3 < data.length; index += 4) {
    const alpha = Number(data[index + 3]) / 255
    if (alpha < 0.5) continue
    const r = Number(data[index])
    const g = Number(data[index + 1])
    const b = Number(data[index + 2])
    const high = Math.max(r, g, b)
    const low = Math.min(r, g, b)
    const saturation = high === 0 ? 0 : (high - low) / high
    const lightness = (high + low) / 2
    if (lightness < 18 || lightness > 245) continue
    colors.push({ rgb: [r, g, b], weight: alpha, saturation, lightness })
  }
  if (colors.length === 0) return null
  const weighted = colors.reduce((sum, color) => [sum[0] + color.rgb[0] * color.weight, sum[1] + color.rgb[1] * color.weight, sum[2] + color.rgb[2] * color.weight], [0, 0, 0])
  const totalWeight = colors.reduce((sum, color) => sum + color.weight, 0)
  const dominant = weighted.map(value => value / totalWeight)
  const accent = [...colors].sort((a, b) => (b.saturation * Math.min(b.lightness, 255 - b.lightness)) - (a.saturation * Math.min(a.lightness, 255 - a.lightness)))[0]
  const bright = [...colors].sort((a, b) => (b.lightness * (0.45 + b.saturation * 0.55)) - (a.lightness * (0.45 + a.saturation * 0.55)))[0]
  const blend = (a: readonly number[], b: readonly number[], amount: number) => a.map((value, index) => value * (1 - amount) + b[index] * amount)
  return { dominant: toHex(dominant), secondary: toHex(blend(dominant, accent.rgb, 0.68)), highlight: toHex(blend(dominant, bright.rgb, 0.78)) }
}

function remember(key: string, value: AlbumPalette | null) {
  paletteCache.delete(key)
  paletteCache.set(key, value)
  while (paletteCache.size > MAX_CACHE) paletteCache.delete(paletteCache.keys().next().value!)
  return value
}

/** Extract a compact palette from the existing thumbnail URL; concurrent requests share work. */
export function getAlbumPalette(src: string | null | undefined): Promise<AlbumPalette | null> {
  if (!src) return Promise.resolve(null)
  if (paletteCache.has(src)) return Promise.resolve(paletteCache.get(src) ?? null)
  const existing = pending.get(src)
  if (existing) return existing
  const request = new Promise<AlbumPalette | null>((resolve) => {
    if (typeof Image === 'undefined' || typeof document === 'undefined') return resolve(remember(src, null))
    const image = new Image()
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 32
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) return resolve(remember(src, null))
        context.drawImage(image, 0, 0, 32, 32)
        resolve(remember(src, paletteFromPixels(context.getImageData(0, 0, 32, 32).data)))
      } catch {
        resolve(remember(src, null))
      }
    }
    image.onerror = () => resolve(remember(src, null))
    image.src = src
  }).finally(() => pending.delete(src))
  pending.set(src, request)
  return request
}

export function clearAlbumPaletteCache() {
  paletteCache.clear()
  pending.clear()
}
