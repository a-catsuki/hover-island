import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { Music } from 'lucide-solid'
import { cmd, type WeatherSnapshot } from '../lib/ipc'
import { getAlbumPalette, type AlbumPalette } from '../lib/albumPalette'
import { loadSettings, settings } from '../state/settings'
import { interpolatedPosition, mediaReceivedAt, nowPlaying, subscribeMedia } from '../state/media'

const WEATHER_REFRESH_MS = 15 * 60_000
const DRIFT_MS = 45_000

/** Night, dawn, day and dusk washes for when no album colours are available. */
function skyFor(hour: number, isDay: boolean | undefined): [string, string, string] {
  if (hour >= 5 && hour < 8) return ['#ff9a6b', '#7b5cff', '#1b1f4a']
  if (hour >= 8 && hour < 17 && isDay !== false) return ['#4fa3ff', '#7ad7c4', '#1b2f5a']
  if (hour >= 17 && hour < 20) return ['#ff6b8b', '#ffb36b', '#3a1f5e']
  return ['#3b5bff', '#8a4dff', '#0b1030']
}

const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/** Full-screen ambient page. Native code closes the window on any input, so this page only draws. */
export default function AmbientApp() {
  const [now, setNow] = createSignal(new Date())
  const [tickMs, setTickMs] = createSignal(performance.now())
  const [weather, setWeather] = createSignal<WeatherSnapshot | null>(null)
  const [drift, setDrift] = createSignal({ x: 0, y: 0 })
  const [palette, setPalette] = createSignal<AlbumPalette | null>(null)
  const [ready, setReady] = createSignal(false)
  const ambient = () => settings.ambient

  onMount(() => {
    void loadSettings()
    let stopMedia: (() => void) | undefined
    void subscribeMedia().then(stop => { stopMedia = stop }).catch(() => {})
    const tick = setInterval(() => { setNow(new Date()); setTickMs(performance.now()) }, 1000)
    const loadWeather = () => void cmd.weatherGet().then(snapshot => { if (snapshot.ok) setWeather(snapshot) }).catch(() => {})
    loadWeather()
    const refresh = setInterval(loadWeather, WEATHER_REFRESH_MS)
    // A slow wander keeps a still image from burning into OLED and IPS panels.
    const wander = setInterval(() => setDrift({ x: Math.round((Math.random() - 0.5) * 90), y: Math.round((Math.random() - 0.5) * 60) }), DRIFT_MS)
    const raf = requestAnimationFrame(() => setReady(true))
    onCleanup(() => { clearInterval(tick); clearInterval(refresh); clearInterval(wander); cancelAnimationFrame(raf); stopMedia?.() })
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
  const weekday = () => new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(now())
  const day = () => new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' }).format(now())
  const minuteFraction = () => now().getSeconds() / 60
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
  const position = () => { tickMs(); return interpolatedPosition(nowPlaying(), mediaReceivedAt(), performance.now()) }
  const duration = () => nowPlaying()?.duration ?? 0
  const progress = () => duration() > 0 ? Math.min(1, position() / duration()) : 0

  createEffect(() => {
    const art = hasMedia() ? track()?.thumbnail : null
    if (!art) { setPalette(null); return }
    let stale = false
    void getAlbumPalette(art).then(next => { if (!stale) setPalette(next) })
    onCleanup(() => { stale = true })
  })

  const colors = createMemo<[string, string, string]>(() => {
    const art = palette()
    if (art) return [art.dominant, art.secondary, art.highlight]
    return skyFor(now().getHours(), weather()?.isDay ?? undefined)
  })

  return (
    <main class="ambient" classList={{ 'ambient--dim': ambient().dim, 'ambient--ready': ready(), 'ambient--solo': !hasMedia() }}
      style={{ '--c1': colors()[0], '--c2': colors()[1], '--c3': colors()[2] }}>
      <div class="ambient__sky" aria-hidden="true">
        <i class="ambient__orb ambient__orb--a" />
        <i class="ambient__orb ambient__orb--b" />
        <i class="ambient__orb ambient__orb--c" />
        <i class="ambient__vignette" />
        <i class="ambient__grain" />
      </div>
      <div class="ambient__stage" style={{ transform: `translate(${ambient().dim ? drift().x : 0}px, ${ambient().dim ? drift().y : 0}px)` }}>
        <Show when={ambient().clock}>
          <section class="ambient__clock">
            <p class="ambient__eyebrow"><span>{weekday()}</span><i /><span>{day()}</span></p>
            <div class="ambient__time"><span>{time()}</span><Show when={period()}><small>{period()}</small></Show></div>
            <div class="ambient__minute" aria-hidden="true"><i style={{ transform: `scaleX(${minuteFraction()})` }} /></div>
            <Show when={ambient().weather && weather()}>
              <p class="ambient__weather"><b>{temperature()}</b><span>{weather()!.label}</span><Show when={weather()!.city}><em>{weather()!.city}</em></Show></p>
            </Show>
          </section>
        </Show>
        <Show when={hasMedia()}>
          <section class="ambient__card media" classList={{ 'media--playing': playing(), 'media--paused': !playing() }} style={{ '--art': '248px' }}>
            <div class="media__art" classList={{ [`media__art--${settings.coverStyle}`]: settings.coverStyle !== 'classic' }}>
              <Show when={track()!.thumbnail} fallback={<Music size={56} strokeWidth={1.2} />}>
                {src => <img src={src()} alt="Album artwork" draggable={false} />}
              </Show>
            </div>
            <div class="ambient__meta">
              <strong>{track()!.title}</strong>
              <span>{track()!.artist}</span>
            </div>
            <Show when={duration() > 0}>
              <div class="ambient__progress" aria-hidden="true">
                <em>{clock(position())}</em>
                <span><i style={{ transform: `scaleX(${progress()})` }} /></span>
                <em>{clock(duration())}</em>
              </div>
            </Show>
          </section>
        </Show>
        <Show when={!ambient().clock && !hasMedia()}>
          <p class="ambient__empty">Nothing to show</p>
        </Show>
      </div>
    </main>
  )
}
