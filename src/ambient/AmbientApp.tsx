import { createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { Music } from 'lucide-solid'
import { cmd, type WeatherSnapshot } from '../lib/ipc'
import { loadSettings, settings } from '../state/settings'
import { nowPlaying, subscribeMedia } from '../state/media'

const WEATHER_REFRESH_MS = 15 * 60_000
const DRIFT_MS = 45_000

/** Full-screen ambient page. Native code closes the window on any input, so this page only draws. */
export default function AmbientApp() {
  const [now, setNow] = createSignal(new Date())
  const [weather, setWeather] = createSignal<WeatherSnapshot | null>(null)
  const [drift, setDrift] = createSignal({ x: 0, y: 0 })
  const ambient = () => settings.ambient

  onMount(() => {
    void loadSettings()
    let stopMedia: (() => void) | undefined
    void subscribeMedia().then(stop => { stopMedia = stop }).catch(() => {})
    const tick = setInterval(() => setNow(new Date()), 1000)
    const loadWeather = () => void cmd.weatherGet().then(snapshot => { if (snapshot.ok) setWeather(snapshot) }).catch(() => {})
    loadWeather()
    const refresh = setInterval(loadWeather, WEATHER_REFRESH_MS)
    // A slow wander keeps a still image from burning into OLED and IPS panels.
    const wander = setInterval(() => setDrift({ x: Math.round((Math.random() - 0.5) * 90), y: Math.round((Math.random() - 0.5) * 60) }), DRIFT_MS)
    onCleanup(() => { clearInterval(tick); clearInterval(refresh); clearInterval(wander); stopMedia?.() })
  })

  const time = createMemo(() => {
    const parts = new Intl.DateTimeFormat(undefined, {
      hour: settings.clockHourCycle === '24' ? '2-digit' : 'numeric',
      minute: '2-digit',
      hour12: settings.clockHourCycle !== '24',
    }).formatToParts(now())
    return parts.filter(part => part.type !== 'dayPeriod').map(part => part.value).join('').trim()
  })
  const period = () => settings.clockHourCycle === '24' ? '' : (new Intl.DateTimeFormat(undefined, { hour: 'numeric', hour12: true }).formatToParts(now()).find(part => part.type === 'dayPeriod')?.value ?? '')
  const date = () => new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(now())
  const temperature = () => {
    const snapshot = weather()
    if (!snapshot) return ''
    return settings.weatherUnits === 'imperial' ? `${Math.round(snapshot.tempC * 9 / 5 + 32)}°` : `${Math.round(snapshot.tempC)}°`
  }
  const track = () => {
    const media = nowPlaying()
    return media && media.status !== 'stopped' && media.title ? media : null
  }
  const playing = () => nowPlaying()?.status === 'playing'
  const hasMedia = () => ambient().media && !!track()

  return (
    <main class="ambient" classList={{ 'ambient--dim': ambient().dim }}>
      <div class="ambient__stage" style={{ transform: `translate(${ambient().dim ? drift().x : 0}px, ${ambient().dim ? drift().y : 0}px)` }}>
        <Show when={ambient().clock}>
          <section class="ambient__clock" classList={{ 'ambient__clock--solo': !hasMedia() }}>
            <div class="ambient__time"><span>{time()}</span><Show when={period()}><small>{period()}</small></Show></div>
            <p class="ambient__date">{date()}</p>
            <Show when={ambient().weather && weather()}>
              <p class="ambient__weather">{temperature()} <span>{weather()!.label}</span><Show when={weather()!.city}><span> · {weather()!.city}</span></Show></p>
            </Show>
          </section>
        </Show>
        <Show when={hasMedia()}>
          <section class="ambient__media media" classList={{ 'media--playing': playing(), 'media--paused': !playing() }} style={{ '--art': '260px' }}>
            <div class="media__art" classList={{ [`media__art--${settings.coverStyle}`]: settings.coverStyle !== 'classic' }}>
              <Show when={track()!.thumbnail} fallback={<Music size={56} strokeWidth={1.2} />}>
                {src => <img src={src()} alt="Album artwork" draggable={false} />}
              </Show>
            </div>
            <div class="ambient__meta">
              <strong>{track()!.title}</strong>
              <span>{track()!.artist}</span>
            </div>
          </section>
        </Show>
        <Show when={!ambient().clock && !hasMedia()}>
          <p class="ambient__empty">Nothing to show</p>
        </Show>
      </div>
    </main>
  )
}
