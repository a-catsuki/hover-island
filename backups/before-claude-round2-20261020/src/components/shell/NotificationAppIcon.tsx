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

/** Rounded-square app tile: the real app logo when Windows gives us one, else a brand glyph or a coloured monogram. */
export default function NotificationAppIcon(props: { app: string; icon?: string | null; size?: number }) {
  const size = () => props.size ?? 40
  const [broken, setBroken] = createSignal(false)
  const [brandBroken, setBrandBroken] = createSignal(false)
  const brand = () => brandKey(props.app)
  const hue = () => hashHue(props.app)
  return <span class="app-tile" style={{ width: `${size()}px`, height: `${size()}px`, 'border-radius': `${Math.round(size() * 0.24)}px`, 'font-size': `${Math.round(size() * 0.46)}px` }} aria-hidden="true">
    <Show when={props.icon && !broken()} fallback={
      <Show when={glyphApps.has(props.app) ? 'glyph' : brand() && !brandBroken() ? 'brand' : ''} keyed fallback={
        <span class="app-tile__mono" style={{ background: `linear-gradient(160deg, hsl(${hue()} 70% 62%), hsl(${(hue() + 28) % 360} 68% 44%))` }}>{monogram(props.app)}</span>
      }>{kind => kind === 'glyph'
        ? <span class="app-tile__brand"><BrandIcon name={props.app} size={Math.round(size() * 0.55)} /></span>
        : <span class="app-tile__brand"><img src={`/brands/${brand()}.svg`} alt="" width={Math.round(size() * 0.6)} height={Math.round(size() * 0.6)} draggable={false} onError={() => setBrandBroken(true)} /></span>}
      </Show>
    }>
      <img src={props.icon!} alt="" draggable={false} onError={() => setBroken(true)} />
    </Show>
  </span>
}
