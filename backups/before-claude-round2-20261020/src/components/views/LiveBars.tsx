import { createEffect, For, onCleanup, onMount } from 'solid-js'
import { audioCaptureStatus, audioFrame, subscribeAudioSpectrum } from '../../state/audio'
import './LiveBars.css'

/**
 * The now-playing equaliser: a few rounded bars driven by the real system-audio spectrum.
 * They settle to small dots when paused or silent. Used by the media card and the collapsed pill.
 */
export interface LiveBarsProps {
  /** Any CSS colour. Defaults to white. */
  color?: string
  /** True while media is playing. Bars settle to dots when false. */
  playing: boolean
  /** Number of bars, 3 to 8. Default 5. */
  bars?: number
  /** Overall height in px. Default 18. */
  size?: number
  /** Bar width in px. Default is derived from size. */
  barWidth?: number
  /** Optional custom band source (24 values 0..1). Defaults to the shared audio spectrum. */
  bands?: () => readonly number[]
  /** Acquire system audio capture while playing. Set false if the parent already does. Default true. */
  subscribe?: boolean
  class?: string
}

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))

/** Average the low/mid/high spectrum into `count` groups; the lowest bands carry little visual detail. */
export function groupBands(bands: readonly number[], count: number): number[] {
  const usable = bands.length > 20 ? bands.slice(1, 22) : bands
  const out: number[] = []
  for (let index = 0; index < count; index++) {
    const start = Math.floor((index / count) * usable.length)
    const end = Math.max(start + 1, Math.floor(((index + 1) / count) * usable.length))
    let sum = 0
    let peak = 0
    for (let band = start; band < end; band++) {
      const value = clamp(usable[band] ?? 0)
      sum += value
      peak = Math.max(peak, value)
    }
    out.push((sum / (end - start)) * 0.6 + peak * 0.4)
  }
  return out
}

export default function LiveBars(props: LiveBarsProps) {
  let host: HTMLSpanElement | undefined
  let raf = 0
  let last = 0
  let phase = 0
  let release: (() => void) | undefined
  let disposed = false
  const count = () => Math.round(clamp(props.bars ?? 5, 3, 8))
  const height = () => props.size ?? 18
  const width = () => props.barWidth ?? Math.max(2, Math.round(height() / 6))
  const levels: number[] = []
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  const target = (now: number): number[] => {
    const n = count()
    if (!props.playing) return Array(n).fill(0)
    const source = props.bands ? props.bands() : audioFrame().bands
    const frame = props.bands ? null : audioFrame()
    const status = audioCaptureStatus()
    if (!props.bands && status !== 'active') {
      // Audio capture is not ready: a quiet, slow swell so the card is not dead. Real data takes over at once.
      return Array.from({ length: n }, (_, i) => 0.22 + 0.16 * (0.5 + 0.5 * Math.sin(phase * 2.1 + i * 1.3)))
    }
    if (frame && now - frame.receivedAt > 400) return Array(n).fill(0)
    return groupBands(source, n).map(value => clamp((value - 0.14) / 0.6) ** 1.15)
  }

  const step = (now: number) => {
    raf = 0
    if (disposed || !host) return
    const dt = last ? Math.min(0.08, (now - last) / 1000) : 1 / 60
    last = now
    phase += dt
    const n = count()
    const goal = target(now)
    const min = width()
    const max = height()
    let settled = true
    const bars = host.children
    for (let index = 0; index < n; index++) {
      const current = levels[index] ?? 0
      const attack = reduced ? 0.12 : 0.045
      const decay = reduced ? 0.25 : 0.14
      const next = current + (goal[index] - current) * (1 - Math.exp(-dt / (goal[index] > current ? attack : decay)))
      levels[index] = Math.abs(next - goal[index]) < 0.002 ? goal[index] : next
      if (levels[index] > 0.004 || goal[index] > 0) settled = false
      const el = bars[index] as HTMLElement | undefined
      if (el) el.style.height = `${(min + (max - min) * levels[index]).toFixed(2)}px`
    }
    if (props.playing || !settled) raf = requestAnimationFrame(step)
    else last = 0
  }

  const wake = () => { if (!raf && !disposed) raf = requestAnimationFrame(step) }

  createEffect(() => {
    props.playing
    count()
    wake()
  })

  createEffect(() => {
    const want = props.playing && props.subscribe !== false && !props.bands
    if (!want) return
    let cancelled = false
    void subscribeAudioSpectrum().then(dispose => {
      if (cancelled || disposed) dispose()
      else release = dispose
    }).catch(() => {})
    onCleanup(() => { cancelled = true; release?.(); release = undefined })
  })

  onMount(() => wake())
  onCleanup(() => { disposed = true; cancelAnimationFrame(raf); release?.(); release = undefined })

  return (
    <span
      ref={host}
      class={`live-bars ${props.class ?? ''}`}
      style={{ '--lb-color': props.color ?? '#fff', '--lb-h': `${height()}px`, '--lb-w': `${width()}px` }}
      role="img"
      aria-label={props.playing ? 'Audio playing' : 'Audio paused'}
    >
      <For each={Array.from({ length: count() })}>{() => <i class="live-bars__bar" />}</For>
    </span>
  )
}
