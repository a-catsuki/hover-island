import { createEffect, onCleanup, onMount } from 'solid-js'
import { audioCaptureError, audioCaptureStatus, audioFrame, subscribeAudioSpectrum } from '../../state/audio'
import { normalizeVisualizerStyle, visualizerStyleLabel, type VisualizerStyle } from '../../lib/visualizerStyles'
import { createVisualizerDynamics, createVisualizerRenderer, VISUALIZER_STALE_MS } from '../../lib/visualizerEngine'
import { createVisualizerField } from '../../lib/visualizerField'
import './Visualizer.css'

export default function Visualizer(props: {
  title?: string
  style: VisualizerStyle
  intensity: number
  reactivity: number
  showModeLabel?: boolean
}) {
  let host: HTMLDivElement | undefined
  let canvas: HTMLCanvasElement | undefined
  let fieldCanvas: HTMLCanvasElement | undefined
  let canvasContext: CanvasRenderingContext2D | null = null
  let renderer: ReturnType<typeof createVisualizerRenderer> | undefined
  let field: ReturnType<typeof createVisualizerField> | undefined
  let fieldFailed = false
  let usingField = false
  let releaseCapture: (() => void) | undefined
  let pendingCapture = false
  let captureEpoch = 0
  let mounted = false
  let disposed = false
  let intersects = true
  let width = 0
  let height = 0
  let pixelWidth = 0
  let pixelHeight = 0
  let raf = 0
  let lastDrawAt = 0
  let staleTimer: ReturnType<typeof setTimeout> | undefined
  let palette = ['#8b9dff', '#bfa9ff']
  const dynamics = createVisualizerDynamics()
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const mode = () => normalizeVisualizerStyle(props.style)
  const visible = () => mounted && !disposed && !document.hidden && intersects && width > 0 && height > 0 && mode() !== 'off'
  const fieldMode = () => mode() === 'ambient' || mode() === 'particles'

  const stopFrames = () => {
    cancelAnimationFrame(raf)
    raf = 0
    clearTimeout(staleTimer)
    staleTimer = undefined
    lastDrawAt = 0
  }

  const releaseAudio = () => {
    captureEpoch++
    releaseCapture?.()
    releaseCapture = undefined
  }

  const acquireAudio = async () => {
    if (pendingCapture || releaseCapture || !visible()) return
    pendingCapture = true
    const epoch = ++captureEpoch
    try {
      const release = await subscribeAudioSpectrum()
      if (!visible() || epoch !== captureEpoch) release()
      else releaseCapture = release
    } finally {
      pendingCapture = false
      if (visible() && !releaseCapture && epoch !== captureEpoch) void acquireAudio()
    }
  }

  const draw = (now: number) => {
    if (!visible() || !canvas || !fieldCanvas) return false
    const dt = lastDrawAt ? (now - lastDrawAt) / 1000 : 1 / 60
    lastDrawAt = now
    const frame = audioCaptureStatus() === 'active' ? audioFrame() : null
    const state = dynamics.update(frame, now, dt, props.reactivity, motion.matches)
    if (fieldMode() && !fieldFailed && !field) {
      field = createVisualizerField(fieldCanvas)
      if (!field) fieldFailed = true
      else field.resize(pixelWidth, pixelHeight, palette[0], palette[1])
    }
    const gpu = fieldMode() && !fieldFailed && Boolean(field)
    if (gpu !== usingField) {
      usingField = gpu
      canvas.style.visibility = gpu ? 'hidden' : 'visible'
      fieldCanvas.style.visibility = gpu ? 'visible' : 'hidden'
    }
    if (gpu && field) {
      if (!field.draw(mode() === 'particles', state, props.intensity, motion.matches)) {
        fieldFailed = true
        field.dispose()
        field = null
        requestDraw()
      }
    } else {
      if (!renderer) {
        const ctx = canvasContext = canvas.getContext('2d', { alpha: false })
        if (!ctx) return false
        ctx.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0)
        renderer = createVisualizerRenderer(ctx)
        renderer.resize(width, height, palette[0], palette[1])
      }
      renderer.draw(mode(), state, props.intensity, motion.matches)
    }
    // Silence paints one settled composition. No idle waveform or fake beat loop.
    return state.moving
  }

  const tick = (now: number) => {
    raf = 0
    if (!visible()) return
    // Reduced motion is sampled at 10 Hz and has no traveling domain or impulses.
    // Live playback uses the display clock with a bounded pixel workload.
    const interval = motion.matches ? 100 : 1000 / 60
    if (lastDrawAt && now - lastDrawAt < interval - 1) {
      raf = requestAnimationFrame(tick)
      return
    }
    if (draw(now)) raf = requestAnimationFrame(tick)
  }

  function requestDraw() {
    if (visible() && !raf) raf = requestAnimationFrame(tick)
  }

  const readPalette = () => {
    const styles = getComputedStyle(document.documentElement)
    const primary = styles.getPropertyValue('--accent').trim() || '#8b9dff'
    const secondary = styles.getPropertyValue('--accent-2').trim() || '#bfa9ff'
    if (primary === palette[0] && secondary === palette[1]) return
    palette = [primary, secondary]
    renderer?.resize(width, height, primary, secondary)
    field?.resize(pixelWidth, pixelHeight, primary, secondary)
    requestDraw()
  }

  const resize = () => {
    if (!host || !canvas || !fieldCanvas) return
    // clientWidth is the actual local content size. A shell transform/zoom must
    // not multiply the backing store or distort the visualizer's aspect ratio.
    const nextWidth = Math.max(0, host.clientWidth)
    const nextHeight = Math.max(0, host.clientHeight)
    const dpr = Math.min(1.5, window.devicePixelRatio || 1, Math.sqrt(750_000 / Math.max(1, nextWidth * nextHeight)))
    const nextPixelWidth = Math.max(1, Math.floor(nextWidth * dpr))
    const nextPixelHeight = Math.max(1, Math.floor(nextHeight * dpr))
    const changed = nextWidth !== width || nextHeight !== height || nextPixelWidth !== pixelWidth || nextPixelHeight !== pixelHeight
    width = nextWidth
    height = nextHeight
    pixelWidth = nextPixelWidth
    pixelHeight = nextPixelHeight
    if (changed) {
      canvas.width = fieldCanvas.width = pixelWidth
      canvas.height = fieldCanvas.height = pixelHeight
      canvasContext?.setTransform(pixelWidth / Math.max(1, width), 0, 0, pixelHeight / Math.max(1, height), 0, 0)
      renderer?.resize(width, height, palette[0], palette[1])
      field?.resize(pixelWidth, pixelHeight, palette[0], palette[1])
    }
    if (visible()) {
      void acquireAudio()
      requestDraw()
    } else {
      stopFrames()
      releaseAudio()
      dynamics.reset()
    }
  }

  const syncVisibility = () => {
    if (visible()) {
      void acquireAudio()
      requestDraw()
    } else {
      stopFrames()
      releaseAudio()
      dynamics.reset()
    }
  }

  onMount(() => {
    mounted = true
    readPalette()
    resize()
    const sizeObserver = new ResizeObserver(resize)
    if (host) sizeObserver.observe(host)
    const intersectionObserver = new IntersectionObserver(entries => {
      intersects = entries.some(entry => entry.isIntersecting)
      syncVisibility()
    })
    if (host) intersectionObserver.observe(host)
    const paletteObserver = new MutationObserver(readPalette)
    paletteObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
    const motionChanged = () => { stopFrames(); requestDraw() }
    const contextLost = (event: Event) => {
      event.preventDefault()
      fieldFailed = true
      requestDraw()
    }
    fieldCanvas?.addEventListener('webglcontextlost', contextLost)
    document.addEventListener('visibilitychange', syncVisibility)
    motion.addEventListener('change', motionChanged)
    window.addEventListener('resize', resize)
    onCleanup(() => {
      sizeObserver.disconnect()
      intersectionObserver.disconnect()
      paletteObserver.disconnect()
      fieldCanvas?.removeEventListener('webglcontextlost', contextLost)
      document.removeEventListener('visibilitychange', syncVisibility)
      motion.removeEventListener('change', motionChanged)
      window.removeEventListener('resize', resize)
    })
  })

  createEffect(() => {
    mode()
    props.intensity
    props.reactivity
    audioCaptureStatus()
    syncVisibility()
    requestDraw()
  })

  createEffect(() => {
    const frame = audioFrame()
    const sounding = frame.rms > 0.000025 && frame.peak > 0.00008
    if (sounding || dynamics.state.moving) requestDraw()
    clearTimeout(staleTimer)
    // A lost capture event still schedules its release envelope. The UI does
    // not stay pinned to the last loud spectrum while the watchdog reconnects.
    if (visible() && sounding) staleTimer = setTimeout(requestDraw, VISUALIZER_STALE_MS + 20)
  })

  onCleanup(() => {
    disposed = true
    stopFrames()
    releaseAudio()
    renderer?.dispose()
    field?.dispose()
    if (canvas) canvas.width = canvas.height = 0
    if (fieldCanvas) fieldCanvas.width = fieldCanvas.height = 0
  })

  const modeLabel = () => {
    if (mode() === 'off') return 'Off'
    if (audioCaptureStatus() === 'starting') return 'Connecting to audio'
    if (audioCaptureStatus() === 'error') return 'System audio unavailable'
    if (audioCaptureStatus() === 'active') return audioFrame()?.rms ? 'System audio · live' : 'Listening for sound'
    return 'Ready for system audio'
  }

  return (
    <div ref={host} class={`viz viz--${mode()}`} aria-label={`${props.title ?? 'System audio'} · ${visualizerStyleLabel(mode())}`} data-visualizer-mode={mode()}>
      <canvas ref={canvas} class="viz__canvas" aria-hidden="true" />
      <canvas ref={fieldCanvas} class="viz__canvas viz__canvas--field" aria-hidden="true" />
      {props.showModeLabel !== false && <span class="viz__mode" aria-live="off">{modeLabel()}</span>}
      <span class="viz__sr-only" aria-live="polite">{audioCaptureError() ? `System audio visualization unavailable: ${audioCaptureError()}` : ''}</span>
    </div>
  )
}
