import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { settings } from '../../state/settings'
import { nowPlaying } from '../../state/media'
import { open } from '../../state/ui'
import { audioCaptureStatus, audioFrame, subscribeAudioSpectrum } from '../../state/audio'
import { createVisualizerDynamics } from '../../lib/visualizerEngine'
import { getAlbumPalette, type AlbumPalette } from '../../lib/albumPalette'
import './AmbientBackground.css'

// Scenes whose light follows the shared speaker spectrum.
const AUDIO_SCENES = new Set(['aurora', 'reactive', 'artwork', 'ember'])
// Procedural pattern scenes drawn with a tiled SVG layer instead of random colour.
const PATTERN_SCENES = new Set(['contours', 'dots', 'grid', 'waves'])

export default function AmbientBackground() {
  const [visible, setVisible] = createSignal(!document.hidden)
  const [palette, setPalette] = createSignal<AlbumPalette | null>(null)
  const [drive, setDrive] = createSignal({ energy: 0, bass: 0, mids: 0, treble: 0, punch: 0 })
  const dynamics = createVisualizerDynamics()
  let lastDriveAt = 0
  const sceneVisible = () => open() && visible() && settings.background !== 'plain'

  onMount(() => {
    const updateVisibility = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', updateVisibility)
    onCleanup(() => document.removeEventListener('visibilitychange', updateVisibility))
  })

  createEffect(() => {
    const scene = settings.background
    const shouldCapture = open()
      && visible()
      && scene !== 'plain'
      && AUDIO_SCENES.has(scene)
      && settings.modules.visualizer
      && settings.visualizer.style !== 'off'
    if (!shouldCapture) return

    let cancelled = false
    let release: (() => void) | undefined
    void subscribeAudioSpectrum().then((dispose) => {
      if (cancelled) dispose()
      else release = dispose
    })
    onCleanup(() => {
      cancelled = true
      release?.()
    })
  })

  createEffect(() => {
    const src = sceneVisible() && settings.background === 'artwork' ? nowPlaying()?.thumbnail : undefined
    let current = true
    setPalette(null)
    void getAlbumPalette(src).then((value) => {
      if (current) setPalette(value)
    })
    onCleanup(() => { current = false })
  })

  createEffect(() => {
    const captureEnabled = sceneVisible()
      && settings.modules.visualizer
      && settings.visualizer.style !== 'off'
      && AUDIO_SCENES.has(settings.background)
    if (!captureEnabled) {
      dynamics.reset()
      lastDriveAt = 0
      setDrive({ energy: 0, bass: 0, mids: 0, treble: 0, punch: 0 })
      return
    }
    const frame = audioCaptureStatus() === 'active' ? audioFrame() : null
    const now = performance.now()
    const dt = lastDriveAt ? (now - lastDriveAt) / 1000 : 1 / 30
    lastDriveAt = now
    const live = dynamics.update(frame, now, dt, settings.visualizer.reactivity, window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    const intensity = Math.max(0.1, Math.min(1.6, settings.visualizer.intensity)) / 0.7
    const amplify = (value: number) => Math.max(0, Math.min(1, value * intensity))
    setDrive({ energy: amplify(live.energy), bass: amplify(live.bass), mids: amplify(live.mid), treble: amplify(live.treble), punch: amplify(live.kick) })
  })

  const sceneUsesAudio = () => AUDIO_SCENES.has(settings.background)
  const audioIsLive = () => sceneUsesAudio() && open() && settings.modules.visualizer && audioCaptureStatus() === 'active' && audioFrame().rms > 0.000025
  const paletteStyle = () => {
    const colors = palette()
    return colors ? {
      '--album-a': colors.dominant,
      '--album-b': colors.secondary,
      '--album-c': colors.highlight,
    } : {}
  }

  const isPattern = () => PATTERN_SCENES.has(settings.background)

  return (
    <Show when={sceneVisible()}>
    <div
      class={`ambient ambient--${settings.background}`}
      classList={{
        'ambient--awake': open(),
        'ambient--audio': audioIsLive(),
        'ambient--pattern': isPattern(),
      }}
      style={{
        ...paletteStyle(),
        '--audio-energy': String(drive().energy),
        '--audio-bass': String(drive().bass),
        '--audio-mid': String(drive().mids),
        '--audio-treble': String(drive().treble),
        '--audio-punch': String(drive().punch),
      }}
      aria-hidden="true"
    >
      <Show when={settings.background === 'artwork' && nowPlaying()?.thumbnail}>
        {(src) => <img class="ambient__art" src={src()} alt="" draggable={false} />}
      </Show>
      <div class="ambient__pattern" />
      <div class="ambient__light ambient__light--a" />
      <div class="ambient__light ambient__light--b" />
      <div class="ambient__pulse" />
      <div class="ambient__grain" />
    </div>
    </Show>
  )
}
