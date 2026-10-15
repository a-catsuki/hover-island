import { createSignal } from 'solid-js'
import { AUDIO_BANDS, type AudioSpectrum } from '../state/audio'

export function normalizeSyntheticBands(value: unknown): AudioSpectrum | null {
  if (!Array.isArray(value) || value.length !== AUDIO_BANDS) return null
  if (value.some((band) => typeof band !== 'number' || !Number.isFinite(band))) return null
  return value.map((band) => Math.max(0, Math.min(1, band)))
}

const [syntheticAudioSpectrum, setSyntheticAudioSpectrum] = createSignal<AudioSpectrum | null>(null)

// Browser preview harness only. The synthetic signal is kept outside the native
// capture state and gets its own label so it can never be mistaken for WASAPI.
if (typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname)) {
  window.addEventListener('hover-island:visualizer-preview', (event) => {
    const bands = (event as CustomEvent<{ bands?: unknown }>).detail?.bands
    if (bands === null) {
      setSyntheticAudioSpectrum(null)
      return
    }
    const normalized = normalizeSyntheticBands(bands)
    if (normalized) setSyntheticAudioSpectrum(normalized)
  })
}

export { syntheticAudioSpectrum }
