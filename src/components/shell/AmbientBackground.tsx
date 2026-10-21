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
// The wash only needs a gentle 20 Hz update, quantised so unchanged values cost nothing.
const DRIVE_INTERVAL_MS = 50
const quantise = (value: number) => Math.round(value * 32) / 32
// Procedural pattern scenes drawn with a tiled SVG layer instead of random colour.
const PATTERN_SCENES = new Set(['contours', 'dots', 'grid', 'waves'])

/**
 * Album wash. The old version blurred a 512 px image with a CSS filter at island size
 * (blur(48-65px) on a ~960x640 layer allocates a filter surface well over twice that area
 * on the GPU). The wash is a blur anyway, so the cover is shrunk once into a 64x40 canvas
 * and the browser's bilinear stretch does the softening for free.
 */
function AmbientArt(props: { src: string }) {
  let node: HTMLDivElement | undefined
  let blobUrl = ''
  const release = () => {
    if (node) node.style.backgroundImage = ''
    if (blobUrl) URL.revokeObjectURL(blobUrl)
    blobUrl = ''
  }
  createEffect(() => {
    const src = props.src
    let current = true
    const image = new Image()
    const settle = () => { image.onload = null; image.onerror = null; image.removeAttribute('src') }
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = 64
      canvas.height = 40
      const context = canvas.getContext('2d')
      const { naturalWidth: w, naturalHeight: h } = image
      if (!context || !w || !h || !current) { settle(); canvas.width = canvas.height = 0; return }
      // object-fit: cover into the 64x40 grid.
      const scale = Math.max(canvas.width / w, canvas.height / h)
      const dw = w * scale
      const dh = h * scale
      context.imageSmoothingQuality = 'high'
      context.filter = 'saturate(1.4)'
      context.drawImage(image, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh)
      settle()
      // A plain background-image is not a compositor layer, unlike a <canvas> element.
      canvas.toBlob((blob) => {
        canvas.width = canvas.height = 0
        if (!blob || !current || !node) return
        const next = URL.createObjectURL(blob)
        node.style.backgroundImage = `url(${next})`
        if (blobUrl) URL.revokeObjectURL(blobUrl)
        blobUrl = next
      })
    }
    image.onerror = settle
    image.src = src
    onCleanup(() => { current = false; settle() })
  })
  onCleanup(release)
  return <div ref={node} class="ambient__art" />
}

export default function AmbientBackground() {
  const [visible, setVisible] = createSignal(!document.hidden)
  const [palette, setPalette] = createSignal<AlbumPalette | null>(null)
  const [drive, setDrive] = createSignal({ energy: 0, bass: 0, mids: 0, treble: 0, punch: 0 })
  const dynamics = createVisualizerDynamics()
  // Native silence is a once-a-second heartbeat, so the release envelope runs on its own short timer.
  const [decayTick, setDecayTick] = createSignal(0)
  let lastDriveAt = 0
  const sceneVisible = () => open() && visible() && settings.background !== 'plain'
  const playing = () => nowPlaying()?.status === 'playing'

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
      && playing()
    if (!shouldCapture) return

    let cancelled = false
    let release: (() => void) | undefined
    // The wash follows band energy only, so it asks for the lightweight stream.
    void subscribeAudioSpectrum('low').then((dispose) => {
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
      && playing()
    if (!captureEnabled) {
      dynamics.reset()
      lastDriveAt = 0
      const current = drive()
      if (current.energy || current.bass || current.mids || current.treble || current.punch) setDrive({ energy: 0, bass: 0, mids: 0, treble: 0, punch: 0 })
      return
    }
    decayTick()
    const frame = audioCaptureStatus() === 'active' ? audioFrame() : null
    const now = performance.now()
    const again = () => {
      const timer = setTimeout(() => setDecayTick((value) => value + 1), DRIVE_INTERVAL_MS)
      onCleanup(() => clearTimeout(timer))
    }
    if (lastDriveAt && now - lastDriveAt < DRIVE_INTERVAL_MS) { again(); return }
    const dt = lastDriveAt ? (now - lastDriveAt) / 1000 : 1 / 20
    lastDriveAt = now
    const live = dynamics.update(frame, now, dt, settings.visualizer.reactivity, window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    const intensity = Math.max(0.1, Math.min(1.6, settings.visualizer.intensity)) / 0.7
    const amplify = (value: number) => quantise(Math.max(0, Math.min(1, value * intensity)))
    const next = { energy: amplify(live.energy), bass: amplify(live.bass), mids: amplify(live.mid), treble: amplify(live.treble), punch: amplify(live.kick) }
    const current = drive()
    if (next.energy !== current.energy || next.bass !== current.bass || next.mids !== current.mids || next.treble !== current.treble || next.punch !== current.punch) setDrive(next)
    if (live.moving) again()
  })

  const sceneUsesAudio = () => AUDIO_SCENES.has(settings.background)
  const audioIsLive = () => sceneUsesAudio() && open() && settings.modules.visualizer && playing() && audioCaptureStatus() === 'active' && audioFrame().rms > 0.000025
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
        {(src) => <AmbientArt src={src()} />}
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
