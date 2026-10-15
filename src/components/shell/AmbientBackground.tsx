import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { settings } from '../../state/settings'
import { nowPlaying } from '../../state/media'
import { open } from '../../state/ui'
import { audioCaptureStatus, audioSpectrum, subscribeAudioSpectrum } from '../../state/audio'
import { audioMetrics } from '../../lib/audioMetrics'
import { syntheticAudioSpectrum } from '../../lib/syntheticAudioPreview'
import './AmbientBackground.css'

// Scenes whose light follows the shared speaker spectrum.
const AUDIO_SCENES = new Set(['aurora', 'reactive', 'artwork', 'ember'])
// Procedural pattern scenes drawn with a tiled SVG layer instead of random colour.
const PATTERN_SCENES = new Set(['contours', 'dots', 'grid', 'waves'])

export default function AmbientBackground() {
  const [visible, setVisible] = createSignal(!document.hidden)

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

  const sceneUsesAudio = () => AUDIO_SCENES.has(settings.background)
  const audioIsLive = () => sceneUsesAudio() && open() && audioCaptureStatus() === 'active'
  const previewIsActive = () => sceneUsesAudio() && open() && syntheticAudioSpectrum() !== null
  const drive = () => {
    const preview = syntheticAudioSpectrum()
    if (previewIsActive() && preview) return audioMetrics(preview)
    return audioIsLive() ? audioMetrics(audioSpectrum()) : { energy: 0, bass: 0 }
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
      style={{ '--audio-energy': String(drive().energy), '--audio-bass': String(drive().bass) }}
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
