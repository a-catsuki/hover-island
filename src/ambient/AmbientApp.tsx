import { createEffect, createMemo, createSignal, Match, onCleanup, onMount, Show, Switch } from 'solid-js'
import { Music } from 'lucide-solid'
import { cmd, type AmbientPalette, type WeatherSnapshot } from '../lib/ipc'
import { getAlbumPalette, type AlbumPalette } from '../lib/albumPalette'
import { loadSettings, settings } from '../state/settings'
import { interpolatedPosition, mediaReceivedAt, nowPlaying, subscribeMedia } from '../state/media'
import { audioFrame, subscribeAudioSpectrum } from '../state/audio'
import SoftLock from './SoftLock'
import { AnalogClock, StackedClock, WordsClock } from './clocks'
import { Ripples, Starfield } from './scenes'

const WEATHER_REFRESH_MS = 15 * 60_000
const DRIFT_MS = 45_000

/** Night, dawn, day and dusk washes for when no album colours are available. */
function skyFor(hour: number, isDay: boolean | undefined): [string, string, string] {
  if (hour >= 5 && hour < 8) return ['#ff9a6b', '#7b5cff', '#1b1f4a']
  if (hour >= 8 && hour < 17 && isDay !== false) return ['#4fa3ff', '#7ad7c4', '#1b2f5a']
  if (hour >= 17 && hour < 20) return ['#ff6b8b', '#ffb36b', '#3a1f5e']
  return ['#3b5bff', '#8a4dff', '#0b1030']
}

const PALETTES: Record<Exclude<AmbientPalette, 'auto'>, [string, string, string]> = {
  sunset: ['#ff6b6b', '#ffb36b', '#5b2a86'],
  ocean: ['#2d9cff', '#33d6c4', '#0b2a5c'],
  forest: ['#3ddc84', '#c3e86b', '#0f3b2e'],
  neon: ['#ff2fd1', '#2ff3ff', '#3a0ca3'],
  mono: ['#9aa0aa', '#e6e8ec', '#22252b'],
}

const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/** Full-screen ambient page. Native code closes the window on any input unless soft lock is on; then `SoftLock` handles unlocking. */
export default function AmbientApp() {
  const [now, setNow] = createSignal(new Date())
  const [tickMs, setTickMs] = createSignal(performance.now())
  const [weather, setWeather] = createSignal<WeatherSnapshot | null>(null)
  const [drift, setDrift] = createSignal({ x: 0, y: 0 })
  const [palette, setPalette] = createSignal<AlbumPalette | null>(null)
  const [ready, setReady] = createSignal(false)
  const [cursor, setCursor] = createSignal(false)
  const [unlocking, setUnlocking] = createSignal(false)
  const [energy, setEnergy] = createSignal(0)
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
    const fixed = ambient().palette
    if (fixed && fixed !== 'auto' && PALETTES[fixed]) return PALETTES[fixed]
    const art = palette()
    if (art) return [art.dominant, art.secondary, art.highlight]
    return skyFor(now().getHours(), weather()?.isDay ?? undefined)
  })

  const scene = () => ambient().scene ?? 'aurora'
  const artwork = () => scene() === 'artwork' && hasMedia() ? track()?.thumbnail ?? null : null
  const reactive = () => ambient().musicReactive && playing() && scene() !== 'black'

  // The background follows the music: one shared low-rate loopback stream while something plays.
  createEffect(() => {
    if (!reactive()) { setEnergy(0); return }
    let release: (() => void) | undefined
    let stopped = false
    void subscribeAudioSpectrum('low').then(stop => { if (stopped) stop(); else release = stop }).catch(() => {})
    onCleanup(() => { stopped = true; release?.() })
  })
  createEffect(() => {
    const frame = audioFrame()
    if (!reactive()) return
    // Rise fast, fall slowly, so the scene breathes instead of flickering.
    const target = Math.min(1, frame.bass * 0.7 + frame.energy * 0.5)
    setEnergy(current => target > current ? current + (target - current) * 0.6 : current * 0.88 + target * 0.12)
  })
  const sceneInput = { colors, energy, beat: () => audioFrame().beatSequence, dim: () => ambient().dim }

  const hours = () => {
    const hour = now().getHours()
    return settings.clockHourCycle === '24' ? String(hour).padStart(2, '0') : String(hour % 12 || 12)
  }
  const minutes = () => String(now().getMinutes()).padStart(2, '0')
  const clockStyle = () => ambient().clockStyle ?? 'classic'

  return (
    <main class={`ambient ambient--scene-${scene()} ambient--clock-${clockStyle()}`} classList={{ 'ambient--dim': ambient().dim, 'ambient--ready': ready(), 'ambient--solo': !hasMedia(), 'ambient--cursor': cursor(), 'ambient--unlocking': unlocking(), 'ambient--art': !!artwork() }}
      style={{ '--c1': colors()[0], '--c2': colors()[1], '--c3': colors()[2] }}>
      <div class="ambient__sky" aria-hidden="true" style={{ '--energy': energy().toFixed(3) }}>
        <Show when={artwork()}>
          {src => <img class="ambient__art" src={src()} alt="" draggable={false} />}
        </Show>
        <Show when={scene() !== 'black' && !artwork()}>
          <i class="ambient__orb ambient__orb--a" />
          <i class="ambient__orb ambient__orb--b" />
          <i class="ambient__orb ambient__orb--c" />
        </Show>
        <Show when={scene() === 'stars'}><Starfield {...sceneInput} /></Show>
        <Show when={scene() === 'ripples'}><Ripples {...sceneInput} /></Show>
        <i class="ambient__vignette" />
        <Show when={scene() !== 'black'}><i class="ambient__grain" /></Show>
      </div>
      <Show when={ambient().softLock}>
        <SoftLock onAwake={setCursor} onUnlock={() => setUnlocking(true)} />
      </Show>
      <div class="ambient__stage" style={{ transform: `translate(${ambient().dim ? drift().x : 0}px, ${ambient().dim ? drift().y : 0}px)` }}>
        <Show when={ambient().clock}>
          <section class="ambient__clock">
            <p class="ambient__eyebrow"><span>{weekday()}</span><i /><span>{day()}</span></p>
            <Switch fallback={
              <>
                <div class="ambient__time"><span>{time()}</span><Show when={period()}><small>{period()}</small></Show></div>
                <div class="ambient__minute" aria-hidden="true"><i style={{ transform: `scaleX(${minuteFraction()})` }} /></div>
              </>
            }>
              <Match when={clockStyle() === 'stacked'}><StackedClock hours={hours()} minutes={minutes()} /></Match>
              <Match when={clockStyle() === 'analog'}><AnalogClock now={now()} /></Match>
              <Match when={clockStyle() === 'words'}><WordsClock now={now()} /></Match>
            </Switch>
            <Show when={ambient().weather && weather()}>
              <p class="ambient__weather"><b>{temperature()}</b><span>{weather()!.label}</span><Show when={weather()!.city}><em>{weather()!.city}</em></Show></p>
            </Show>
            <Show when={ambient().note}>
              <p class="ambient__note">{ambient().note}</p>
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
          <Show when={ambient().note} fallback={<p class="ambient__empty">Nothing to show</p>}>
            <p class="ambient__note ambient__note--solo">{ambient().note}</p>
          </Show>
        </Show>
      </div>
    </main>
  )
}
