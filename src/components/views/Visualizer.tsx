import { createEffect, onCleanup, onMount } from 'solid-js'
import { audioCaptureStatus, audioFrame, subscribeAudioSpectrum } from '../../state/audio'
import { normalizeVisualizerStyle, visualizerStyleLabel } from '../../lib/visualizerStyles'
import { createVisualizerDynamics } from '../../lib/visualizerEngine'
import { createBackdropRenderer, DEFAULT_BACKDROP_COLORS, parseColor, type BackdropRenderer, type Rgb } from '../../lib/visualizerBackdrop'
import './Visualizer.css'

/** Frame rates: 60 only while sound is visibly playing, 30 otherwise, a slow breath when paused. */
const FPS_LIVE = 60
const FPS_DEFAULT = 30
const FPS_IDLE = 6
const FPS_REDUCED = 10
const MAX_DPR = 1
/** Backing-store budget in device pixels: big views render a little softer instead of getting expensive. */
const PIXEL_BUDGET = 300_000

/**
 * Full-bleed audio backdrop. One canvas that fills its positioned parent; the
 * controls float above it. It only runs while visible, and only listens to system
 * audio while something is playing.
 */
export default function Visualizer(props: {
  style: string
  intensity: number
  reactivity: number
  /** True while media is playing. Pauses capture and drops to a slow idle breath. */
  playing: boolean
  /** False when the card is hidden or collapsed. Stops all work. Default true. */
  active?: boolean
  /** Up to three CSS colours (album palette). Falls back to the theme accent. */
  colors?: ReadonlyArray<string | undefined>
  class?: string
}) {
  let host: HTMLDivElement | undefined
  let canvas: HTMLCanvasElement | undefined
  let renderer: BackdropRenderer | undefined
  let mounted = false
  let disposed = false
  let intersects = true
  let pageVisible = !document.hidden
  let width = 0
  let height = 0
  let raf = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastFrame = 0
  let clock = 0
  let listening = false
  let pendingCapture = false
  let captureEpoch = 0
  let releaseCapture: (() => void) | undefined
  let themeColors: readonly Rgb[] = DEFAULT_BACKDROP_COLORS
  let appliedKey = ''
  const dynamics = createVisualizerDynamics()
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const mode = () => normalizeVisualizerStyle(props.style)
  const running = () => mounted && !disposed && pageVisible && intersects && props.active !== false && width > 0 && height > 0 && mode() !== 'off'
  const gain = () => Math.min(2.3, Math.max(0.15, props.intensity / 0.7))

  const frameInterval = () => {
    if (motion.matches) return 1000 / FPS_REDUCED
    if (!props.playing) return dynamics.state.moving ? 1000 / FPS_DEFAULT : 1000 / FPS_IDLE
    return dynamics.state.live ? 1000 / FPS_LIVE : 1000 / FPS_DEFAULT
  }

  const stopFrames = () => {
    cancelAnimationFrame(raf)
    clearTimeout(timer)
    raf = 0
    timer = undefined
    lastFrame = 0
  }

  const releaseAudio = () => {
    captureEpoch++
    releaseCapture?.()
    releaseCapture = undefined
  }

  const acquireAudio = async () => {
    if (pendingCapture || releaseCapture || !listening) return
    pendingCapture = true
    const epoch = ++captureEpoch
    try {
      const release = await subscribeAudioSpectrum('full')
      if (!listening || epoch !== captureEpoch) release()
      else releaseCapture = release
    } catch { /* the capture status already reports the failure */ } finally {
      pendingCapture = false
      if (listening && !releaseCapture && epoch !== captureEpoch) void acquireAudio()
    }
  }

  const draw = (now: number) => {
    if (!renderer) return
    const dt = lastFrame ? Math.min(0.1, Math.max(0.001, (now - lastFrame) / 1000)) : 1 / FPS_DEFAULT
    lastFrame = now
    const frame = props.playing && audioCaptureStatus() === 'active' ? audioFrame() : null
    const state = dynamics.update(frame, now, dt, props.reactivity, motion.matches)
    if (!motion.matches) clock += dt * (0.6 + state.energy * 1.4)
    renderer.draw(mode(), state, clock, dt, gain())
  }

  const schedule = () => {
    if (raf || timer !== undefined || !running()) return
    const wait = frameInterval() - (performance.now() - lastFrame)
    // Slow rates sleep on a timer instead of waking every display frame to skip it.
    if (lastFrame && wait > 24) {
      timer = setTimeout(() => { timer = undefined; raf = requestAnimationFrame(tick) }, wait - 10)
    } else {
      raf = requestAnimationFrame(tick)
    }
  }

  function tick(now: number) {
    raf = 0
    if (!running()) return
    if (lastFrame && now - lastFrame < frameInterval() - 3) {
      schedule()
      return
    }
    draw(now)
    schedule()
  }

  /** Start or stop everything that costs something, from the current visibility and playback. */
  const sync = () => {
    if (!running()) {
      stopFrames()
      listening = false
      releaseAudio()
      dynamics.reset()
      renderer?.clear()
      return
    }
    listening = props.playing
    if (listening) void acquireAudio()
    else releaseAudio()
    // Restarting the schedule repaints at once, so a style, size or playback change never waits for a slow tick.
    stopFrames()
    schedule()
  }

  const applyColors = () => {
    if (!renderer) return
    const wanted = [0, 1, 2].map((index) => parseColor(props.colors?.[index], themeColors[index] ?? themeColors[0]))
    const key = wanted.map((color) => color.join(',')).join('|')
    if (key === appliedKey) return
    const first = appliedKey === ''
    appliedKey = key
    renderer.setColors(wanted)
    if (!first && host && typeof host.animate === 'function' && !motion.matches) {
      host.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 700, easing: 'ease-out' })
    }
  }

  const readTheme = () => {
    const styles = getComputedStyle(document.documentElement)
    const accent = parseColor(styles.getPropertyValue('--accent'), DEFAULT_BACKDROP_COLORS[0])
    const second = parseColor(styles.getPropertyValue('--accent-2'), DEFAULT_BACKDROP_COLORS[1])
    themeColors = [accent, second, [255, 255, 255]]
    appliedKey = ''
    applyColors()
  }

  const resize = () => {
    if (!host || !canvas || !renderer) return
    // clientWidth is the local layout size; shell zoom/transform must not scale the backing store.
    const nextWidth = Math.max(0, host.clientWidth)
    const nextHeight = Math.max(0, host.clientHeight)
    if (nextWidth !== width || nextHeight !== height) {
      width = nextWidth
      height = nextHeight
      if (width > 0 && height > 0) {
        const scale = Math.max(0.5, Math.min(MAX_DPR, window.devicePixelRatio || 1, Math.sqrt(PIXEL_BUDGET / (width * height))))
        canvas.width = Math.max(1, Math.floor(width * scale))
        canvas.height = Math.max(1, Math.floor(height * scale))
        renderer.resize(width, height, canvas.width / width)
      }
    }
    sync()
  }

  onMount(() => {
    const context = canvas?.getContext('2d')
    if (!context || !host) return
    renderer = createBackdropRenderer(context)
    mounted = true
    readTheme()
    resize()
    const sizeObserver = new ResizeObserver(resize)
    sizeObserver.observe(host)
    const intersection = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver((entries) => {
      intersects = entries.some((entry) => entry.isIntersecting)
      sync()
    })
    intersection?.observe(host)
    const themeObserver = new MutationObserver(readTheme)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
    const visibility = () => { pageVisible = !document.hidden; sync() }
    const motionChanged = () => sync()
    document.addEventListener('visibilitychange', visibility)
    motion.addEventListener('change', motionChanged)
    onCleanup(() => {
      sizeObserver.disconnect()
      intersection?.disconnect()
      themeObserver.disconnect()
      document.removeEventListener('visibilitychange', visibility)
      motion.removeEventListener('change', motionChanged)
    })
  })

  createEffect(() => {
    mode()
    props.active
    props.playing
    sync()
  })

  createEffect(() => {
    props.colors?.[0]
    props.colors?.[1]
    props.colors?.[2]
    applyColors()
  })

  onCleanup(() => {
    disposed = true
    stopFrames()
    releaseAudio()
    renderer?.dispose()
    if (canvas) canvas.width = canvas.height = 0
  })

  return (
    <div
      ref={host}
      class={`viz viz--${mode()} ${props.class ?? ''}`}
      role="img"
      aria-label={`Visualiser: ${visualizerStyleLabel(props.style)}`}
      data-visualizer-mode={mode()}
    >
      <canvas ref={canvas} class="viz__canvas" aria-hidden="true" />
    </div>
  )
}
