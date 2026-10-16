import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { settings } from '../../state/settings'
import { nowPlaying } from '../../state/media'
import { open } from '../../state/ui'
import { audioCaptureStatus, audioSpectrum, subscribeAudioSpectrum } from '../../state/audio'
import { audioFrequencyMetrics, createAudioDynamics } from '../../lib/audioMetrics'
import { getAlbumPalette, type AlbumPalette } from '../../lib/albumPalette'
import { syntheticAudioSpectrum } from '../../lib/syntheticAudioPreview'
import './AmbientBackground.css'

// Scenes whose light follows the shared speaker spectrum.
const AUDIO_SCENES = new Set(['aurora', 'reactive', 'artwork', 'ember'])
// Procedural pattern scenes drawn with a tiled SVG layer instead of random colour.
const PATTERN_SCENES = new Set(['contours', 'dots', 'grid', 'waves'])

export default function AmbientBackground() {
  const [visible, setVisible] = createSignal(!document.hidden)
  const [palette, setPalette] = createSignal<AlbumPalette | null>(null)
  const [drive, setDrive] = createSignal({ energy: 0, bass: 0, mids: 0, treble: 0, punch: 0 })
  const dynamics = createAudioDynamics()
  let lastDriveAt = 0

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
      && nowPlaying()?.status === 'playing'
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
    const src = settings.background === 'artwork' ? nowPlaying()?.thumbnail : undefined
    let current = true
    setPalette(null)
    void getAlbumPalette(src).then((value) => {
      if (current) setPalette(value)
    })
    onCleanup(() => { current = false })
  })

  createEffect(() => {
    const preview = syntheticAudioSpectrum()
    const active = open() && (preview !== null || (audioCaptureStatus() === 'active' && AUDIO_SCENES.has(settings.background)))
    const spectrum = preview ?? audioSpectrum()
    if (!active) {
      dynamics.reset()
      lastDriveAt = 0
      setDrive({ energy: 0, bass: 0, mids: 0, treble: 0, punch: 0 })
      return
    }
    const now = performance.now()
    const dt = lastDriveAt ? (now - lastDriveAt) / 1000 : 1 / 30
    lastDriveAt = now
    const live = dynamics.update(spectrum, true, dt)
    setDrive({ energy: live.energy, bass: live.bass, mids: live.mids, treble: live.treble, punch: live.punch })
  })

  const sceneUsesAudio = () => AUDIO_SCENES.has(settings.background)
  const audioIsLive = () => sceneUsesAudio() && open() && audioCaptureStatus() === 'active'
  const previewIsActive = () => sceneUsesAudio() && open() && syntheticAudioSpectrum() !== null
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
    <div
      class={`ambient ambient--${settings.background}`}
      classList={{
        'ambient--awake': open(),
        'ambient--audio': audioIsLive() && !previewIsActive(),
        'ambient--preview': previewIsActive(),
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
  )
}
