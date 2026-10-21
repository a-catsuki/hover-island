import type { VisualizerMode } from './visualizerStyles'

/** Analysis is measured by WASAPI. Renderers never invent an oscillator or beat. */
export interface VisualizerAudioFrame {
  readonly bands: readonly number[]
  readonly waveform: readonly number[]
  readonly rms: number
  readonly peak: number
  readonly energy: number
  readonly bass: number
  readonly mid: number
  readonly treble: number
  readonly onset: number
  readonly sequence: number
  readonly beatSequence: number
  readonly receivedAt: number
}

export const VISUALIZER_STALE_MS = 250
const BAND_COUNT = 24
const WAVE_COUNT = 128
const TAU = Math.PI * 2
// Shader travel rates use multiples of 1/20. Their shared period prevents a
// visible domain jump when the accumulator wraps during long playback.
const PHASE_PERIOD = TAU * 20
const clamp = (value: number, min = 0, max = 1) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min
const follow = (current: number, target: number, dt: number, attack: number, release: number) =>
  current + (target - current) * (1 - Math.exp(-dt / (target > current ? attack : release)))

export interface VisualizerDynamics {
  readonly bands: Float32Array
  readonly waveform: Float32Array
  energy: number
  bass: number
  mid: number
  treble: number
  kick: number
  phase: number
  wavePeak: number
  live: boolean
  moving: boolean
}

/** One mutable envelope per canvas: no per-frame signals, arrays, or beat detector. */
export function createVisualizerDynamics() {
  const state: VisualizerDynamics = {
    bands: new Float32Array(BAND_COUNT), waveform: new Float32Array(WAVE_COUNT),
    energy: 0, bass: 0, mid: 0, treble: 0, kick: 0, phase: 0, wavePeak: 0,
    live: false, moving: false,
  }
  let lastBeatSequence = -1
  let lastFrameSequence = -1
  let lastFrameAt = -1
  return {
    state,
    update(frame: VisualizerAudioFrame | null, now: number, seconds: number, response: number, reducedMotion: boolean) {
      const dt = clamp(seconds, 0.001, 0.08)
      const fresh = Boolean(frame && now - frame.receivedAt >= 0 && now - frame.receivedAt <= VISUALIZER_STALE_MS)
      // A ready endpoint can keep sending zeroes forever. That is silence, not a beat.
      const live = fresh && Boolean(frame && frame.rms > 0.000025 && frame.peak > 0.00008)
      const attack = reducedMotion ? 0.001 : 0.012 + (1 - clamp(response)) * 0.025
      const release = reducedMotion ? 0.001 : 0.11 + (1 - clamp(response)) * 0.13
      const next = (current: number, target: number) => {
        const value = follow(current, target, dt, attack, release)
        return Math.abs(value) < 0.00015 ? 0 : value
      }
      let strongest = 0
      for (let index = 0; index < BAND_COUNT; index++) {
        const level = next(state.bands[index], live ? clamp(frame!.bands[index] ?? 0) : 0)
        state.bands[index] = level
        strongest = Math.max(strongest, level)
      }
      state.wavePeak = 0
      for (let index = 0; index < WAVE_COUNT; index++) {
        const target = live ? clamp(frame!.waveform[index] ?? 0, -1, 1) : 0
        // Filtering individual PCM samples across frames erases the waveform
        // through phase cancellation. Only its release into silence is eased.
        const released = state.waveform[index] * Math.exp(-dt / release)
        state.waveform[index] = live ? target : Math.abs(released) < 0.00015 ? 0 : released
        state.wavePeak = Math.max(state.wavePeak, Math.abs(state.waveform[index]))
      }
      state.energy = next(state.energy, live ? clamp(frame!.energy) : 0)
      state.bass = next(state.bass, live ? clamp(frame!.bass) : 0)
      state.mid = next(state.mid, live ? clamp(frame!.mid) : 0)
      state.treble = next(state.treble, live ? clamp(frame!.treble) : 0)
      state.kick *= Math.exp(-dt / 0.16)
      // Consume an onset once. Repainting the same frame cannot manufacture beats.
      const newFrame = frame && (frame.sequence !== lastFrameSequence || frame.receivedAt !== lastFrameAt)
      if (newFrame) {
        if (frame.sequence < lastFrameSequence) lastBeatSequence = -1
        if (live && frame.beatSequence > 0 && frame.beatSequence !== lastBeatSequence && frame.onset > 0) {
          state.kick = Math.max(state.kick, clamp(frame.onset))
        }
        lastBeatSequence = frame.beatSequence
        lastFrameSequence = frame.sequence
        lastFrameAt = frame.receivedAt
      }
      if (state.kick < 0.001) state.kick = 0
      // Travel is the integral of measured sound. It stops when sound stops.
      if (live && !reducedMotion) state.phase = (state.phase + dt * state.energy * 0.48) % PHASE_PERIOD
      state.live = live
      state.moving = live || strongest > 0.001 || state.energy > 0.001 || state.kick > 0 || state.wavePeak > 0.001
      return state
    },
    reset() {
      state.bands.fill(0)
      state.waveform.fill(0)
      state.energy = state.bass = state.mid = state.treble = state.kick = state.phase = state.wavePeak = 0
      state.live = state.moving = false
      lastBeatSequence = lastFrameSequence = lastFrameAt = -1
    },
  }
}

const sampleBand = (bands: Float32Array, at: number) => {
  const position = clamp(at) * (bands.length - 1)
  const lower = Math.floor(position)
  return bands[lower] + (bands[Math.min(lower + 1, bands.length - 1)] - bands[lower]) * (position - lower)
}

/** Canvas surfaces are allocated on palette/size changes, never in the draw loop. */
export function createVisualizerRenderer(context: CanvasRenderingContext2D) {
  let width = 1
  let height = 1
  let accent = '#8b9dff'
  let accent2 = '#bfa9ff'
  let base: CanvasGradient
  let ink: CanvasGradient
  let wash: CanvasGradient
  let column: CanvasGradient
  const lights = [document.createElement('canvas'), document.createElement('canvas')]
  const px = new Float32Array(64)
  const py = new Float32Array(64)
  const seed = new Float32Array(64)
  for (let index = 0; index < px.length; index++) {
    // Low-discrepancy placement reaches every part of the frame without random
    // allocations during playback.
    px[index] = ((index + 0.5) * 0.61803398875) % 1
    py[index] = ((index + 0.5) * 0.75487766625) % 1
    seed[index] = index * 2.39996322973
  }

  const prepare = () => {
    base = context.createLinearGradient(0, 0, width, height)
    base.addColorStop(0, '#080b14')
    base.addColorStop(0.52, '#0d101a')
    base.addColorStop(1, '#080a11')
    ink = context.createLinearGradient(0, height, width, 0)
    ink.addColorStop(0, accent)
    ink.addColorStop(0.48, accent2)
    ink.addColorStop(1, '#e9f3ff')
    wash = context.createLinearGradient(0, 0, 0, height)
    wash.addColorStop(0, accent2)
    wash.addColorStop(0.45, accent)
    wash.addColorStop(1, 'transparent')
    column = context.createLinearGradient(0, height * 0.08, 0, height)
    column.addColorStop(0, '#eff7ff')
    column.addColorStop(0.36, accent2)
    column.addColorStop(0.76, accent)
    column.addColorStop(1, '#101629')
    for (let index = 0; index < lights.length; index++) {
      const canvas = lights[index]
      canvas.width = canvas.height = 128
      const ctx = canvas.getContext('2d')!
      const glow = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
      glow.addColorStop(0, index ? accent2 : accent)
      glow.addColorStop(0.18, index ? accent2 : accent)
      glow.addColorStop(1, 'transparent')
      ctx.fillStyle = glow
      ctx.fillRect(0, 0, 128, 128)
    }
  }

  const light = (x: number, y: number, w: number, h: number, color: number, opacity: number) => {
    if (opacity < 0.001) return
    context.globalAlpha = clamp(opacity)
    context.drawImage(lights[color], x - w / 2, y - h / 2, w, h)
  }

  const atmosphere = (state: VisualizerDynamics, gain: number, gentle: boolean) => {
    const { energy, bass, mid, treble, phase } = state
    const kick = gentle ? 0 : state.kick
    context.globalCompositeOperation = 'screen'
    light(width * (0.12 + bass * 0.14), height * 0.76, width * 1.8, height * (1.4 + bass * 0.5), 0, 0.2 + bass * 0.5 * gain)
    light(width * 0.8, height * (0.12 + mid * 0.12), width * 1.5, height * 1.8, 1, 0.17 + mid * 0.5 * gain)
    for (let ribbon = 0; ribbon < 4; ribbon++) {
      const band = ribbon === 0 ? bass : ribbon === 1 ? mid : ribbon === 2 ? treble : energy
      context.beginPath()
      for (let step = 0; step <= 64; step++) {
        const x = step / 64
        const spectrum = sampleBand(state.bands, x)
        const arc = Math.sin(x * Math.PI)
        const bend = Math.sin(x * TAU * 0.65 + ribbon * 0.7 + phase) * (0.06 + band * 0.14)
        const y = height * (0.2 + ribbon * 0.19 + bend - arc * (band * 0.18 + kick * 0.035) * gain + spectrum * 0.065)
        if (step === 0) context.moveTo(0, y)
        else context.lineTo(x * width, y)
      }
      context.lineTo(width, height * 1.15)
      context.lineTo(0, height * 1.15)
      context.closePath()
      context.globalAlpha = 0.1 + band * 0.13 * gain
      context.fillStyle = wash
      context.fill()
      context.globalAlpha = 0.18 + band * 0.3
      context.lineWidth = 0.8 + band * 0.7
      context.strokeStyle = ink
      context.stroke()
    }
    context.globalCompositeOperation = 'source-over'
  }

  const contour = (state: VisualizerDynamics, gain: number, gentle: boolean) => {
    const waveGain = Math.min(12, 0.72 / Math.max(0.06, state.wavePeak))
    light(width * 0.28, height * 0.55, width * 1.4, height * 1.6, 0, 0.14 + state.energy * 0.2)
    light(width * 0.84, height * 0.55, width * 1.1, height * 1.7, 1, 0.12 + state.treble * 0.18)
    context.lineCap = 'round'
    context.lineJoin = 'round'
    for (let layer = 0; layer < 3; layer++) {
      const center = height * (0.26 + layer * 0.24)
      const amplitude = height * (gentle ? 0.13 : 0.19) * gain * (layer === 1 ? 1.1 : 0.58)
      context.beginPath()
      for (let index = 0; index < WAVE_COUNT; index++) {
        const x = index / (WAVE_COUNT - 1) * width
        const y = center + state.waveform[index] * waveGain * amplitude
        if (!index) context.moveTo(x, y)
        else context.lineTo(x, y)
      }
      context.strokeStyle = ink
      context.globalAlpha = layer === 1 ? 0.14 + state.energy * 0.12 : 0.06 + state.energy * 0.06
      context.lineWidth = layer === 1 ? 7 : 4
      context.stroke()
      context.globalAlpha = layer === 1 ? 0.78 : 0.28
      context.lineWidth = layer === 1 ? 1.45 : 0.9
      context.stroke()
    }
  }

  const spectrum = (state: VisualizerDynamics, gain: number, gentle: boolean) => {
    const count = Math.min(72, Math.max(24, Math.floor(width / 8)))
    const gap = Math.max(1.4, width / count * 0.28)
    const barWidth = Math.max(1, width / count - gap)
    const bottom = height * 0.94
    const maxHeight = height * (gentle ? 0.7 : 0.88)
    light(width / 2, height * 0.85, width * 1.8, height * 1.3, 0, 0.14 + state.bass * 0.18)
    context.fillStyle = column
    for (let index = 0; index < count; index++) {
      const level = sampleBand(state.bands, index / Math.max(1, count - 1))
      const h = Math.max(1.5, clamp(level * gain) * maxHeight)
      const x = index * width / count + gap / 2
      context.globalAlpha = 0.7 + level * 0.3
      context.beginPath()
      context.roundRect(x, bottom - h, barWidth, h, Math.min(barWidth * 0.45, 2.2))
      context.fill()
      context.globalAlpha = level * 0.2
      context.fillRect(x, bottom + height * 0.02, barWidth, height * 0.04)
    }
    context.globalAlpha = 1
  }

  const orbit = (state: VisualizerDynamics, gain: number, gentle: boolean) => {
    light(width / 2, height / 2, width * 1.6, height * 1.8, 0, 0.16 + state.bass * 0.2)
    light(width * 0.65, height * 0.38, width * 1.2, height * 1.2, 1, 0.1 + state.mid * 0.2)
    const kick = gentle ? 0 : state.kick
    for (let ring = 0; ring < 5; ring++) {
      const baseX = width * (0.19 + ring * 0.07)
      const baseY = height * (0.17 + ring * 0.062)
      context.beginPath()
      for (let step = 0; step <= 128; step++) {
        const angle = step / 128 * TAU
        const bandAt = 1 - Math.abs(step / 64 - 1)
        const level = sampleBand(state.bands, bandAt)
        const displacement = level * gain * 0.07 + kick * 0.018
        const x = width / 2 + Math.cos(angle) * (baseX + width * displacement)
        const y = height / 2 + Math.sin(angle) * (baseY + height * displacement)
        if (step === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      }
      context.closePath()
      context.strokeStyle = ink
      context.lineWidth = ring === 3 ? 1.65 : 0.8
      context.globalAlpha = (ring === 3 ? 0.75 : 0.14 + ring * 0.035) + state.energy * 0.14
      context.stroke()
    }
  }

  const lightfield = (state: VisualizerDynamics, gain: number, gentle: boolean) => {
    light(width * 0.2, height * 0.72, width * 1.5, height * 1.9, 0, 0.12 + state.bass * 0.25)
    light(width * 0.9, height * 0.22, width * 1.35, height * 1.7, 1, 0.1 + state.mid * 0.2)
    context.globalCompositeOperation = 'screen'
    for (let index = 0; index < px.length; index++) {
      const level = state.bands[index % BAND_COUNT]
      const impulse = gentle ? 0 : state.kick * (index % 3 ? 0.4 : 1)
      const offset = (level * 0.025 + impulse * 0.035) * gain
      const x = width * (px[index] + Math.cos(seed[index] + state.phase) * offset)
      const y = height * (py[index] + Math.sin(seed[index] + state.phase) * offset)
      const size = 1 + level * 3.2 * gain + impulse * 2
      light(x, y, size * 13, size * 13, index % 2, (0.07 + level * 0.35 + impulse * 0.22) * gain)
      context.globalAlpha = 0.16 + level * 0.7 + impulse * 0.13
      context.fillStyle = index % 3 ? accent2 : '#eef5ff'
      context.beginPath()
      context.arc(x, y, Math.max(0.6, size * 0.38), 0, TAU)
      context.fill()
    }
    context.globalCompositeOperation = 'source-over'
  }

  prepare()
  return {
    resize(w: number, h: number, primary: string, secondary: string) {
      width = Math.max(1, w)
      height = Math.max(1, h)
      accent = primary || '#8b9dff'
      accent2 = secondary || '#bfa9ff'
      prepare()
    },
    draw(mode: VisualizerMode, state: VisualizerDynamics, intensity: number, reducedMotion: boolean) {
      context.globalCompositeOperation = 'source-over'
      context.globalAlpha = 1
      context.clearRect(0, 0, width, height)
      if (mode === 'off') return
      context.fillStyle = base
      context.fillRect(0, 0, width, height)
      const gain = 0.45 + clamp(intensity, 0, 1.6) * 0.72
      switch (mode) {
        case 'ambient': atmosphere(state, gain, reducedMotion); break
        case 'wave': contour(state, gain, reducedMotion); break
        case 'bars': spectrum(state, gain, reducedMotion); break
        case 'radial': orbit(state, gain, reducedMotion); break
        case 'particles': lightfield(state, gain, reducedMotion); break
      }
      context.globalAlpha = 1
    },
    dispose() {
      for (const canvas of lights) canvas.width = canvas.height = 0
    },
  }
}
