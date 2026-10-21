import { For, Show, createUniqueId } from 'solid-js'

export type WeatherKind = 'clear' | 'partly' | 'cloud' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'thunder'

export function weatherKind(code: number): WeatherKind {
  if (code === 0) return 'clear'
  if (code <= 2) return 'partly'
  if (code === 3) return 'cloud'
  if (code <= 48) return 'fog'
  if (code <= 57) return 'drizzle'
  if (code <= 67 || (code >= 80 && code <= 82)) return 'rain'
  if (code <= 77 || (code >= 85 && code <= 86)) return 'snow'
  return 'thunder'
}

const RAYS = [0, 45, 90, 135, 180, 225, 270, 315]

/**
 * Flat, multicolour weather glyphs in the spirit of the system weather icons:
 * yellow sun, soft white clouds, blue rain. No glow, no filters.
 */
export default function WeatherGlyph(props: { code: number; night?: boolean; class?: string }) {
  const id = createUniqueId()
  const kind = () => weatherKind(props.code)
  const dark = () => kind() === 'rain' || kind() === 'drizzle' || kind() === 'thunder'
  const showCelestial = () => kind() === 'clear' || (kind() === 'partly')
  const big = () => kind() === 'clear'
  // Celestial body centre and radius; smaller and tucked up-left behind a cloud.
  const cx = () => (big() ? 32 : 23)
  const cy = () => (big() ? 32 : 22)
  const r = () => (big() ? 13 : 9.5)
  return (
    <svg class={`wglyph ${props.class ?? ''}`} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-sun`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#FFE45C" />
          <stop offset="1" stop-color="#FFB000" />
        </linearGradient>
        <linearGradient id={`${id}-moon`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#F4F1FF" />
          <stop offset="1" stop-color="#B9B7D6" />
        </linearGradient>
        <linearGradient id={`${id}-cloud`} gradientUnits="userSpaceOnUse" x1="0" y1="20" x2="0" y2="52">
          <stop offset="0" stop-color="#FFFFFF" />
          <stop offset="1" stop-color="#C5CBD6" />
        </linearGradient>
        <linearGradient id={`${id}-cloud-dark`} gradientUnits="userSpaceOnUse" x1="0" y1="20" x2="0" y2="52">
          <stop offset="0" stop-color="#E4E8EF" />
          <stop offset="1" stop-color="#8E98A8" />
        </linearGradient>
      </defs>

      <Show when={showCelestial()}>
        <Show
          when={props.night}
          fallback={
            <g>
              <For each={RAYS}>{(deg) => {
                const a = (deg * Math.PI) / 180
                const r1 = r() + 4.5
                const r2 = r() + (big() ? 9.5 : 7.5)
                return <line x1={cx() + Math.cos(a) * r1} y1={cy() + Math.sin(a) * r1} x2={cx() + Math.cos(a) * r2} y2={cy() + Math.sin(a) * r2} stroke="#FFC400" stroke-width={big() ? 3.4 : 2.8} stroke-linecap="round" />
              }}</For>
              <circle cx={cx()} cy={cy()} r={r()} fill={`url(#${id}-sun)`} />
            </g>
          }
        >
          <path
            fill={`url(#${id}-moon)`}
            transform={big() ? '' : 'translate(-6 -6) scale(.82)'}
            d="M38 12.5a21 21 0 1 0 14.5 33.8A17.5 17.5 0 0 1 38 12.5Z"
          />
        </Show>
      </Show>

      <Show when={kind() !== 'clear'}>
        <g transform={kind() === 'partly' ? 'translate(7 6)' : ''} fill={`url(#${id}-${dark() ? 'cloud-dark' : 'cloud'})`}>
          <circle cx="22" cy="38" r="10" />
          <circle cx="33" cy="31" r="13" />
          <circle cx="45" cy="38" r="9" />
          <rect x="12" y="38" width="42" height="10" rx="5" />
        </g>
      </Show>

      <Show when={kind() === 'rain'}>
        <g stroke="#4FB4FF" stroke-width="3.4" stroke-linecap="round">
          <line x1="22" y1="52.5" x2="19.5" y2="59" />
          <line x1="33" y1="52.5" x2="30.5" y2="59" />
          <line x1="44" y1="52.5" x2="41.5" y2="59" />
        </g>
      </Show>
      <Show when={kind() === 'drizzle'}>
        <g stroke="#7CC8FF" stroke-width="3" stroke-linecap="round">
          <line x1="24" y1="53" x2="22.5" y2="57" />
          <line x1="35" y1="53" x2="33.5" y2="57" />
          <line x1="46" y1="53" x2="44.5" y2="57" />
        </g>
      </Show>
      <Show when={kind() === 'snow'}>
        <g fill="#FFFFFF">
          <circle cx="22" cy="55" r="2.6" />
          <circle cx="33" cy="58" r="2.6" />
          <circle cx="44" cy="55" r="2.6" />
        </g>
      </Show>
      <Show when={kind() === 'fog'}>
        <g stroke="#C9D0DB" stroke-width="3.2" stroke-linecap="round" opacity=".9">
          <line x1="16" y1="52" x2="48" y2="52" />
          <line x1="22" y1="58.5" x2="42" y2="58.5" />
        </g>
      </Show>
      <Show when={kind() === 'thunder'}>
        <path fill="#FFD60A" d="M35.5 44 27 55.5h6l-2.5 8.5 10-12.5h-6.2l3.2-7.5Z" />
      </Show>
    </svg>
  )
}
