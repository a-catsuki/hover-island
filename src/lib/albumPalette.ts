export interface AlbumPalette {
  dominant: string
  secondary: string
  highlight: string
}

const MAX_CACHE = 32
// Data URLs can be several megabytes. A count limit alone retains every
// previous album's encoded image as a key even though the value is tiny.
const MAX_CACHE_KEY_BYTES = 2 * 1024 * 1024
let cacheKeyBytes = 0
const paletteCache = new Map<string, AlbumPalette | null>()
const pending = new Map<string, Promise<AlbumPalette | null>>()

const hex = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
const toHex = (rgb: readonly number[]) => `#${hex(rgb[0])}${hex(rgb[1])}${hex(rgb[2])}`

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const red = r / 255, green = g / 255, blue = b / 255
  const high = Math.max(red, green, blue), low = Math.min(red, green, blue)
  const lightness = (high + low) / 2
  const delta = high - low
  if (delta === 0) return [0, 0, lightness]
  const saturation = delta / (1 - Math.abs(2 * lightness - 1))
  let hue = high === red ? ((green - blue) / delta) % 6 : high === green ? (blue - red) / delta + 2 : (red - green) / delta + 4
  hue = ((hue * 60) + 360) % 360
  return [hue, clamp01(saturation), lightness]
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const section = (((hue % 360) + 360) % 360) / 60
  const x = chroma * (1 - Math.abs((section % 2) - 1))
  const [r, g, b] = section < 1 ? [chroma, x, 0] : section < 2 ? [x, chroma, 0] : section < 3 ? [0, chroma, x] : section < 4 ? [0, x, chroma] : section < 5 ? [x, 0, chroma] : [chroma, 0, x]
  const m = lightness - chroma / 2
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

/** Vivid but readable on black: boost saturation and keep lightness between 45% and 70%. */
export function vividColor(rgb: readonly number[]): string {
  const [hue, saturation, lightness] = rgbToHsl(rgb[0], rgb[1], rgb[2])
  // Near-greys stay neutral instead of inventing a hue.
  const boosted = saturation < 0.1 ? saturation : clamp01(Math.max(0.55, saturation * 1.2 + 0.08))
  return toHex(hslToRgb(hue, boosted, Math.min(0.7, Math.max(0.45, lightness))))
}

/** Deterministic, lightweight color selection suitable for thumbnail pixels and unit tests. */
export function paletteFromPixels(data: ArrayLike<number>): AlbumPalette | null {
  const colors: Array<{ rgb: [number, number, number]; weight: number; saturation: number; lightness: number; hue: number }> = []
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
    colors.push({ rgb: [r, g, b], weight: alpha, saturation, lightness, hue: rgbToHsl(r, g, b)[0] })
  }
  if (colors.length === 0) return null
  // Hue buckets weighted by saturation and mid-tone-ness: the album's main colour, not a muddy average.
  const buckets = Array.from({ length: 12 }, () => ({ score: 0, sum: [0, 0, 0], weight: 0 }))
  for (const color of colors) {
    const midtone = 1 - Math.abs(color.lightness / 255 - 0.5) * 1.2
    const score = color.weight * (0.04 + color.saturation * color.saturation) * Math.max(0.15, midtone)
    const bucket = buckets[Math.min(11, Math.floor(color.hue / 30))]
    bucket.score += score
    bucket.weight += color.weight
    for (let channel = 0; channel < 3; channel++) bucket.sum[channel] += color.rgb[channel] * color.weight
  }
  const best = buckets.reduce((top, bucket) => bucket.score > top.score ? bucket : top)
  const dominantRgb = best.weight > 0 ? best.sum.map(value => value / best.weight) : [128, 128, 128]
  const totalWeight = colors.reduce((sum, color) => sum + color.weight, 0)
  const average = colors.reduce((sum, color) => [sum[0] + color.rgb[0] * color.weight, sum[1] + color.rgb[1] * color.weight, sum[2] + color.rgb[2] * color.weight], [0, 0, 0]).map(value => value / totalWeight)
  const accent = [...colors].sort((a, b) => (b.saturation * Math.min(b.lightness, 255 - b.lightness)) - (a.saturation * Math.min(a.lightness, 255 - a.lightness)))[0]
  const bright = [...colors].sort((a, b) => (b.lightness * (0.45 + b.saturation * 0.55)) - (a.lightness * (0.45 + a.saturation * 0.55)))[0]
  const blend = (a: readonly number[], b: readonly number[], amount: number) => a.map((value, index) => value * (1 - amount) + b[index] * amount)
  return {
    dominant: vividColor(dominantRgb),
    secondary: vividColor(blend(average, accent.rgb, 0.68)),
    highlight: vividColor(blend(dominantRgb, bright.rgb, 0.6)),
  }
}

function remember(key: string, value: AlbumPalette | null) {
  if (paletteCache.delete(key)) cacheKeyBytes -= key.length * 2
  if (key.length * 2 > MAX_CACHE_KEY_BYTES) return value
  paletteCache.set(key, value)
  cacheKeyBytes += key.length * 2
  while (paletteCache.size > MAX_CACHE || cacheKeyBytes > MAX_CACHE_KEY_BYTES) {
    const oldest = paletteCache.keys().next().value!
    paletteCache.delete(oldest)
    cacheKeyBytes -= oldest.length * 2
  }
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
    const releaseImage = () => {
      image.onload = null
      image.onerror = null
      image.removeAttribute('src')
    }
    image.onload = () => {
      let canvas: HTMLCanvasElement | undefined
      try {
        canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 32
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) return resolve(remember(src, null))
        context.drawImage(image, 0, 0, 32, 32)
        resolve(remember(src, paletteFromPixels(context.getImageData(0, 0, 32, 32).data)))
      } catch {
        resolve(remember(src, null))
      } finally {
        if (canvas) { canvas.width = 0; canvas.height = 0 }
        releaseImage()
      }
    }
    image.onerror = () => { releaseImage(); resolve(remember(src, null)) }
    image.src = src
  }).finally(() => pending.delete(src))
  pending.set(src, request)
  return request
}

export function clearAlbumPaletteCache() {
  paletteCache.clear()
  cacheKeyBytes = 0
  pending.clear()
}
