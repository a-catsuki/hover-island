import { createSignal, Show } from 'solid-js'
import BrandIcon from '../BrandIcon'
import './NotificationAppIcon.css'

const brands = ['openai', 'claude', 'cursor', 'gmail', 'whatsapp', 'instagram', 'telegram', 'outlook', 'discord']
const brandAliases: Record<string, string> = { 'whatsapp web': 'whatsapp', 'google mail': 'gmail', 'microsoft outlook': 'outlook' }
const glyphApps = new Set(['Bluetooth', 'Battery', 'Phone bucket', 'Focus timer', 'Media'])

export function hashHue(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i++) hash = (hash * 31 + input.charCodeAt(i)) >>> 0
  return hash % 360
}

function brandKey(app: string): string | undefined {
  const name = app.trim().toLowerCase()
  return brandAliases[name] ?? brands.find(brand => name === brand || name.startsWith(`${brand} `))
}

function monogram(app: string): string {
  const letters = app.trim().match(/[\p{L}\p{N}]/u)
  return (letters?.[0] ?? '?').toUpperCase()
}

/** Last good icon per app, so a toast that arrives without one still shows the app's logo. */
const knownIcons = new Map<string, string>()
const badIcons = new Set<string>()

/** Inspect a decoded icon: returns 'blank' when almost nothing is visible, 'dark' for dark glyphs on transparency. */
function inspectIcon(image: HTMLImageElement): 'ok' | 'blank' | 'dark' {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 24
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return 'ok'
    context.drawImage(image, 0, 0, 24, 24)
    const data = context.getImageData(0, 0, 24, 24).data
    let visible = 0, luminance = 0
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3]
      if (alpha < 24) continue
      visible++
      luminance += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) * (alpha / 255)
    }
    if (visible < 576 * 0.03) return 'blank'
    return visible < 576 * 0.8 && luminance / visible < 60 ? 'dark' : 'ok'
  } catch { return 'ok' }
}

/** Rounded-square app tile: the real app logo when Windows gives us one, else a brand glyph or a coloured monogram. It is never blank or broken. */
export default function NotificationAppIcon(props: { app: string; icon?: string | null; size?: number }) {
  const size = () => props.size ?? 40
  const [brokenSource, setBrokenSource] = createSignal('')
  const [lightTile, setLightTile] = createSignal('')
  const [brandBroken, setBrandBroken] = createSignal(false)
  const brand = () => brandKey(props.app)
  const hue = () => hashHue(props.app)
  const source = () => {
    const given = props.icon && props.icon.length > 32 ? props.icon : ''
    const key = props.app.trim().toLowerCase()
    if (given && !badIcons.has(given)) { if (!knownIcons.has(key) || knownIcons.get(key) !== given) knownIcons.set(key, given); return given }
    const remembered = knownIcons.get(key)
    return remembered && !badIcons.has(remembered) ? remembered : ''
  }
  const usable = () => !!source() && brokenSource() !== source()
  return <span class="app-tile" classList={{ 'app-tile--light': usable() && lightTile() === source() }} style={{ width: `${size()}px`, height: `${size()}px`, 'border-radius': `${Math.round(size() * 0.24)}px`, 'font-size': `${Math.round(size() * 0.46)}px` }} aria-hidden="true">
    <Show when={usable()} fallback={
      <Show when={glyphApps.has(props.app) ? 'glyph' : brand() && !brandBroken() ? 'brand' : ''} keyed fallback={
        <span class="app-tile__mono" style={{ background: `linear-gradient(160deg, hsl(${hue()} 70% 62%), hsl(${(hue() + 28) % 360} 68% 44%))` }}>{monogram(props.app)}</span>
      }>{kind => kind === 'glyph'
        ? <span class="app-tile__brand"><BrandIcon name={props.app} size={Math.round(size() * 0.55)} /></span>
        : <span class="app-tile__brand"><img src={`/brands/${brand()}.svg`} alt="" width={Math.round(size() * 0.6)} height={Math.round(size() * 0.6)} draggable={false} onError={() => setBrandBroken(true)} /></span>}
      </Show>
    }>
      <img src={source()} alt="" draggable={false}
        onError={() => { badIcons.add(source()); setBrokenSource(source()) }}
        onLoad={event => {
          const verdict = inspectIcon(event.currentTarget)
          if (verdict === 'blank') { badIcons.add(source()); setBrokenSource(source()) }
          else if (verdict === 'dark') setLightTile(source())
        }} />
    </Show>
  </span>
}
