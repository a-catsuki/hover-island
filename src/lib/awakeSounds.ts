/**
 * Alarm sounds for Keep me awake, synthesised with WebAudio so the widget needs no audio files.
 * `playPack` resolves true once the sound is scheduled on a running context (so the caller can tell
 * the native side not to play its own copy) and false when the browser blocked audio.
 */

export type SoundPack = 'chimes' | 'bell' | 'marimba' | 'beep' | 'rooster' | 'system'

export const SOUND_PACKS: Array<{ id: SoundPack; label: string; hint: string }> = [
  { id: 'chimes', label: 'Chimes', hint: 'Bright pentatonic run' },
  { id: 'bell', label: 'Bell', hint: 'One long ring' },
  { id: 'marimba', label: 'Marimba', hint: 'Quick wooden notes' },
  { id: 'beep', label: 'Beep', hint: 'Plain double beep' },
  { id: 'rooster', label: 'Rooster', hint: 'Cock-a-doodle-doo' },
  { id: 'system', label: 'Windows sound', hint: 'Your system alert' },
]

export const isSoundPack = (value: unknown): value is SoundPack => SOUND_PACKS.some((pack) => pack.id === value)

let context: AudioContext | null = null

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  context ??= new Ctor()
  return context
}

/** Resume the audio context from a user gesture so later alarms are allowed to play. */
export function primeAudio(): void {
  const ctx = audio()
  if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
}

const PENTATONIC = [0, 2, 4, 7, 9]
const pentatonic = (index: number) => 523.25 * 2 ** ((PENTATONIC[index % 5] + 12 * Math.floor(index / 5)) / 12)

interface Voice { at: number; freq: number; dur: number; decay: number; amp: number; partials: Array<[number, number]>; type?: OscillatorType }

function voice(ctx: AudioContext, out: AudioNode, base: number, v: Voice): void {
  const start = base + v.at
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.linearRampToValueAtTime(v.amp, start + 0.006)
  // A struck-object decay: fast fall, then a tail.
  gain.gain.setTargetAtTime(0.0001, start + 0.006, 1 / v.decay)
  gain.connect(out)
  for (const [multiple, level] of v.partials) {
    const osc = ctx.createOscillator()
    const part = ctx.createGain()
    osc.type = v.type ?? 'sine'
    osc.frequency.value = v.freq * multiple
    part.gain.value = level
    osc.connect(part).connect(gain)
    osc.start(start)
    osc.stop(start + v.dur + 0.05)
  }
}

function rooster(ctx: AudioContext, out: AudioNode, base: number): void {
  const syllables: Array<[number, number, number, number]> = [[0, 0.17, 520, 700], [0.2, 0.14, 700, 560], [0.38, 0.2, 560, 930], [0.62, 0.62, 930, 600]]
  for (const [at, dur, from, to] of syllables) {
    const start = base + at
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(from, start)
    osc.frequency.linearRampToValueAtTime(to, start + dur)
    const vibrato = ctx.createOscillator()
    const vibratoDepth = ctx.createGain()
    vibrato.frequency.value = 38
    vibratoDepth.gain.value = 12
    vibrato.connect(vibratoDepth).connect(osc.frequency)
    const formant = ctx.createBiquadFilter()
    formant.type = 'bandpass'
    formant.Q.value = 2.2
    formant.frequency.setValueAtTime(900, start)
    formant.frequency.linearRampToValueAtTime(1500, start + dur)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.linearRampToValueAtTime(0.9, start + 0.04)
    gain.gain.setValueAtTime(0.9, start + dur - 0.08)
    gain.gain.linearRampToValueAtTime(0.0001, start + dur)
    osc.connect(formant).connect(gain).connect(out)
    osc.start(start)
    vibrato.start(start)
    osc.stop(start + dur + 0.02)
    vibrato.stop(start + dur + 0.02)
  }
}

/** How long one pass of a pack lasts, seconds. */
const PHRASE: Record<Exclude<SoundPack, 'system'>, number> = { chimes: 1.5, bell: 2.2, marimba: 1.2, beep: 0.62, rooster: 1.35 }

export interface PlayOptions {
  volume: number
  /** escalation step, 0 to 4: later steps repeat the phrase */
  level?: number
  /** calm rising phrase for the end of a session */
  final?: boolean
  rng?: () => number
}

export async function playPack(pack: SoundPack, options: PlayOptions): Promise<boolean> {
  const ctx = audio()
  if (!ctx) return false
  try {
    if (ctx.state !== 'running') await ctx.resume()
  } catch {
    return false
  }
  if (ctx.state !== 'running') return false
  const rng = options.rng ?? Math.random
  const master = ctx.createGain()
  master.gain.value = Math.min(1, Math.max(0.02, options.volume)) * 0.8
  master.connect(ctx.destination)
  const now = ctx.currentTime + 0.03
  if (options.final) {
    ;[523.25, 659.25, 783.99, 1046.5].forEach((freq, n) => voice(ctx, master, now, { at: n * 0.28, freq, dur: 1.4, decay: 2.8, amp: 0.45, partials: [[1, 1], [2, 0.18]] }))
    return true
  }
  const kind = pack === 'system' ? 'beep' : pack
  const repeats = (options.level ?? 0) >= 3 ? 3 : (options.level ?? 0) >= 1 ? 2 : 1
  for (let round = 0; round < repeats; round++) {
    const at = now + PHRASE[kind] * round
    if (kind === 'chimes') {
      let index = 3 + Math.floor(rng() * 3)
      for (let n = 0; n < 4; n++) {
        voice(ctx, master, at, { at: n * 0.17, freq: pentatonic(index), dur: 1.1, decay: 4.5, amp: 0.5, partials: [[1, 1], [2, 0.18]] })
        index = Math.min(9, index + 1 + Math.floor(rng() * 2))
      }
    } else if (kind === 'bell') {
      voice(ctx, master, at, { at: 0, freq: 660, dur: 2.3, decay: 1.9, amp: 0.45, partials: [[1, 1], [2.76, 0.5], [5.4, 0.25], [8.93, 0.12]] })
    } else if (kind === 'marimba') {
      for (let n = 0; n < 5; n++) {
        voice(ctx, master, at, { at: n * 0.12, freq: pentatonic(Math.floor(rng() * 6)) / 2, dur: 0.6, decay: 9, amp: 0.6, partials: [[1, 1], [4, 0.3], [9.9, 0.05]] })
      }
    } else if (kind === 'beep') {
      for (let n = 0; n < 2; n++) voice(ctx, master, at, { at: n * 0.24, freq: 880, dur: 0.16, decay: 12, amp: 0.4, partials: [[1, 1], [3, 0.33], [5, 0.2]], type: 'sine' })
    } else {
      rooster(ctx, master, at)
    }
  }
  return true
}
