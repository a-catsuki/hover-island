/** Analysis is measured by WASAPI. Renderers never invent an oscillator or beat. */
export interface VisualizerAudioFrame {
  readonly bands: readonly number[]
  readonly waveform?: readonly number[]
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
const TAU = Math.PI * 2
// The travel accumulator wraps on a shared period so long playback never jumps.
const PHASE_PERIOD = TAU * 20
const clamp = (value: number, min = 0, max = 1) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min
const follow = (current: number, target: number, dt: number, attack: number, release: number) =>
  current + (target - current) * (1 - Math.exp(-dt / (target > current ? attack : release)))

export interface VisualizerDynamics {
  readonly bands: Float32Array
  energy: number
  bass: number
  mid: number
  treble: number
  kick: number
  phase: number
  live: boolean
  moving: boolean
}

/** One mutable envelope per canvas: no per-frame signals, arrays, or beat detector.
 * Only the 24 spectrum bands and the scalar drives are tracked; the waveform is not used. */
export function createVisualizerDynamics() {
  const state: VisualizerDynamics = {
    bands: new Float32Array(BAND_COUNT),
    energy: 0, bass: 0, mid: 0, treble: 0, kick: 0, phase: 0,
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
      state.moving = live || strongest > 0.001 || state.energy > 0.001 || state.kick > 0
      return state
    },
    reset() {
      state.bands.fill(0)
      state.energy = state.bass = state.mid = state.treble = state.kick = state.phase = 0
      state.live = state.moving = false
      lastBeatSequence = lastFrameSequence = lastFrameAt = -1
    },
  }
}
