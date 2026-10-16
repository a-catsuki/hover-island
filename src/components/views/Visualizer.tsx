import { createEffect, onCleanup, onMount } from 'solid-js'
import { audioCaptureError, audioCaptureStatus, audioSpectrum, subscribeAudioSpectrum } from '../../state/audio'
import { normalizeVisualizerStyle, visualizerStyleLabel, type VisualizerStyle } from '../../lib/visualizerStyles'
import { adaptSpectrumLevels, audioMetrics, isMeaningfulSpectrum } from '../../lib/audioMetrics'
import { syntheticAudioSpectrum } from '../../lib/syntheticAudioPreview'
import './Visualizer.css'

const BANDS = 24
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const mix = (from: number, to: number, t: number) => from + (to - from) * t

export default function Visualizer(props: {
  title?: string
  style: VisualizerStyle
  intensity: number
  reactivity: number
  showModeLabel?: boolean
}) {
  let wrapRef: HTMLDivElement | undefined
  let canvasRef: HTMLCanvasElement | undefined
  let ctx: CanvasRenderingContext2D | null = null
  let cssW = 0
  let cssH = 0
  let dpr = 1
  let raf = 0
  let previous = 0
  let lastDynamicsAt = 0
  let disposed = false
  let releaseCapture: (() => void) | undefined
  let captureEpoch = 0
  let acquiring = false
  const smoothed = Array.from({ length: BANDS }, () => 0)
  const peakTrack = Array.from({ length: BANDS }, () => 0.008)
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let bassBaseline = 0
  let beatPulse = 0
  let energy = 0

  const style = () => normalizeVisualizerStyle(props.style)
  const intensity = () => clamp(Number.isFinite(props.intensity) ? props.intensity : 0.7, 0, 1.6)

  const resize = () => {
    if (!wrapRef || !canvasRef) return
    const rect = wrapRef.getBoundingClientRect()
    cssW = Math.max(1, Math.floor(rect.width))
    cssH = Math.max(1, Math.floor(rect.height))
    dpr = Math.min(1.75, window.devicePixelRatio || 1)
    canvasRef.width = Math.round(cssW * dpr)
    canvasRef.height = Math.round(cssH * dpr)
    canvasRef.style.width = `${cssW}px`
    canvasRef.style.height = `${cssH}px`
    ctx = canvasRef.getContext('2d')
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
    draw()
  }

  const readLevels = (active: boolean, raw: readonly number[], dt: number) => {
    const response = clamp(Number.isFinite(props.reactivity) ? props.reactivity : 0.8, 0, 1)
    const adapted = adaptSpectrumLevels(raw, peakTrack, active, dt)
    adapted.peaks.forEach((peak, index) => { peakTrack[index] = peak })
    const attack = 0.018 + (1 - response) * 0.045
    const release = 0.11 + (1 - response) * 0.19
    const levels = smoothed.map((old, index) => {
      const next = adapted.levels[index]
      const tau = next > old ? attack : release
      const alpha = reducedMotion.matches ? 1 : 1 - Math.exp(-dt / tau)
      const level = old + (next - old) * alpha
      smoothed[index] = level
      return level
    })
    const rawMetrics = active ? audioMetrics(raw) : {energy:0,bass:0}
    energy += (rawMetrics.energy-energy) * (reducedMotion.matches ? 1 : 1-Math.exp(-dt/.08))
    const bass = rawMetrics.bass
    bassBaseline += (bass - bassBaseline) * (reducedMotion.matches ? 1 : 1 - Math.exp(-dt / 0.7))
    const bassOnset = Math.max(0, bass - bassBaseline - 0.025)
    beatPulse = Math.max(beatPulse * Math.exp(-dt / 0.19), clamp(bassOnset * 4.2, 0, 1))
    return levels
  }

  // Smoothly sample the 24 bands at any position along the spectrum (0..1).
  const sample = (levels: number[], position: number) => {
    const at = clamp(position, 0, 1) * (BANDS - 1)
    const low = Math.floor(at)
    const high = Math.min(BANDS - 1, low + 1)
    return mix(levels[low] ?? 0, levels[high] ?? 0, at - low)
  }

  // Idle motion keeps every scene alive even with no signal — the "ambient" half.
  const idleAt = (index: number, time: number) => (Math.sin(time * 1.7 + index * 0.62) * 0.5 + 0.5)
  const levelAt = (levels: number[], index: number, active: boolean, time: number) =>
    active ? levels[index] ?? 0 : idleAt(index, time) * 0.16

  const roundBar = (x: number, y: number, w: number, h: number, r: number) => {
    if (!ctx) return
    ctx.beginPath()
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, Math.max(1, h), Math.min(r, w / 2, h / 2))
    else ctx.rect(x, y, w, Math.max(1, h))
    ctx.fill()
  }

  const drawBars = (levels: number[], active: boolean, gradient: CanvasGradient, time: number) => {
    if (!ctx) return
    const gap = clamp(cssW / 190, 2, 5)
    const side = Math.max(6, cssW * 0.045)
    const width = Math.max(1, (cssW - side * 2 - gap * (BANDS - 1)) / BANDS)
    const baseline = cssH * 0.84
    const maxHeight = cssH * 0.66
    const radius = Math.min(width / 2, 2.6)
    ctx.save()
    ctx.fillStyle = gradient
    for (let index = 0; index < BANDS; index++) {
      const level = levelAt(levels, index, active, time)
      const height = Math.max(2, level * intensity() * maxHeight)
      const x = side + index * (width + gap)
      // reflection
      ctx.globalAlpha = active ? 0.16 : 0.08
      ctx.fillStyle = index % 2 ? '#ffffff' : '#ffffff'
      roundBar(x, baseline + 2, width, Math.max(1, height * 0.32), radius)
      // bar with a soft glow that only shows when there is real energy
      ctx.globalAlpha = 1
      ctx.fillStyle = gradient
      ctx.shadowColor = index % 2 ? 'rgba(0,0,0,0)' : 'rgba(0,0,0,0)'
      if (active) {
        ctx.shadowColor = 'rgba(255,255,255,0.22)'
        ctx.shadowBlur = 7 * level * intensity()
      }
      roundBar(x, baseline - height, width, height, radius)
      ctx.shadowBlur = 0
    }
    ctx.restore()
    ctx.globalAlpha = active ? 0.22 : 0.12
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(side, baseline + 1, cssW - side * 2, 1)
    ctx.globalAlpha = 1
  }

  const drawWave = (levels: number[], active: boolean, gradient: CanvasGradient, accent: string, accent2: string, time: number) => {
    if (!ctx) return
    const cx = cssW / 2
    const cy = cssH * 0.54
    const amp = cssH * 0.34 * intensity()
    const steps = 72
    const curve: number[] = []
    for (let step = 0; step <= steps; step++) {
      const pos = step / steps
      const base = active ? sample(levels, pos) : 0
      const breathe = active ? 0 : 0.1 * (Math.sin(pos * Math.PI * 2.2 + time * 1.1) * 0.5 + 0.5)
      curve.push(clamp(base + breathe, 0, 1))
    }
    const fill = ctx.createLinearGradient(0, cy - amp, 0, cy + amp)
    fill.addColorStop(0, 'transparent')
    fill.addColorStop(0.5, accent2)
    fill.addColorStop(1, 'transparent')
    ctx.save()
    ctx.beginPath()
    for (let step = 0; step <= steps; step++) {
      const x = side(step, steps)
      ctx.lineTo(x, cy - curve[step] * amp)
    }
    for (let step = steps; step >= 0; step--) {
      const x = side(step, steps)
      ctx.lineTo(x, cy + curve[step] * amp)
    }
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.globalAlpha = active ? 0.5 : 0.3
    ctx.fill()
    // crisp mirrored edges
    ctx.globalAlpha = active ? 0.9 : 0.55
    ctx.strokeStyle = gradient
    ctx.lineWidth = 1.6
    ctx.shadowColor = accent
    ctx.shadowBlur = active ? 10 : 5
    for (const sign of [-1, 1]) {
      ctx.beginPath()
      for (let step = 0; step <= steps; step++) {
        const x = side(step, steps)
        const y = cy + sign * curve[step] * amp
        if (step === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    ctx.restore()
  }

  const side = (step: number, steps: number) => (step / steps) * cssW

  const drawPulse = (levels: number[], active: boolean, accent: string, accent2: string, gradient: CanvasGradient, time: number) => {
    if (!ctx) return
    const cx = cssW / 2
    const cy = cssH * 0.52
    const base = Math.min(cssW, cssH) * 0.34
    const pulse = 1 + Math.sin(time * 1.35) * 0.05 + beatPulse * 0.28 + (active ? energy * 0.35 : 0)
    ctx.save()
    const glow = ctx.createRadialGradient(cx, cy, 1, cx, cy, base * (2.4 + beatPulse * 0.5))
    glow.addColorStop(0, accent2)
    glow.addColorStop(0.42, accent)
    glow.addColorStop(1, 'transparent')
    ctx.globalAlpha = 0.24 + beatPulse * 0.24 + (active ? energy * 0.22 : 0)
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(cx, cy, base * (2.4 + beatPulse * 0.5), 0, Math.PI * 2)
    ctx.fill()
    // concentric rings drifting outward forever
    for (let ring = 0; ring < 3; ring++) {
      const phase = (time * 0.26 + ring / 3) % 1
      const radius = base * (0.45 + phase * 1.5) * pulse
      ctx.beginPath()
      ctx.arc(cx, cy, radius, 0, Math.PI * 2)
      ctx.globalAlpha = (active ? 0.32 : 0.2) * (1 - phase) * (0.6 + beatPulse * 0.8)
      ctx.strokeStyle = ring % 2 ? accent2 : accent
      ctx.lineWidth = 1.1 + energy * 2.4
      ctx.stroke()
    }
    // core
    ctx.globalAlpha = active ? 0.85 : 0.5
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(cx, cy, base * 0.2 * pulse, 0, Math.PI * 2)
    ctx.fill()
    // spectrum arc hugging the lower rim
    const arcR = base * 1.05
    ctx.globalAlpha = active ? 0.55 : 0.28
    ctx.strokeStyle = gradient
    ctx.lineCap = 'round'
    for (let index = 0; index < BANDS; index++) {
      const angle = Math.PI * 0.18 + (index / (BANDS - 1)) * Math.PI * 0.64
      const len = 4 + levelAt(levels, index, active, time) * intensity() * base * 0.5
      ctx.lineWidth = 2.4
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(angle) * arcR, cy + Math.sin(angle) * arcR)
      ctx.lineTo(cx + Math.cos(angle) * (arcR + len), cy + Math.sin(angle) * (arcR + len))
      ctx.stroke()
    }
    ctx.restore()
  }

  const drawBloom = (levels: number[], active: boolean, gradient: CanvasGradient, accent: string, accent2: string, time: number) => {
    if (!ctx) return
    const cx = cssW / 2
    const cy = cssH * 0.55
    const radius = Math.min(cssW * 0.24, cssH * 0.44) * (1 + beatPulse * 0.18)
    ctx.save()
    const halo = ctx.createRadialGradient(cx, cy, 1, cx, cy, radius * 3)
    halo.addColorStop(0, accent2)
    halo.addColorStop(0.4, accent)
    halo.addColorStop(1, 'transparent')
    ctx.globalAlpha = 0.28 + Math.sin(time * 0.9) * 0.05 + beatPulse * 0.14
    ctx.fillStyle = halo
    ctx.beginPath()
    ctx.arc(cx, cy, radius * 3, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    for (let step = 0; step <= 96; step++) {
      const angle = (step / 96) * Math.PI * 2
      const wobble = Math.sin(angle * 6 + time * 0.4) * 0.1
      const live = levelAt(levels, Math.floor((step / 96) * BANDS) % BANDS, active, time) * 0.42
      const at = radius * (1 + wobble + live)
      const x = cx + Math.cos(angle) * at
      const y = cy + Math.sin(angle) * at * 0.62
      if (!step) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.globalAlpha = active ? 0.62 : 0.4
    ctx.fillStyle = gradient
    ctx.fill()
    ctx.globalAlpha = active ? 0.82 : 0.55
    ctx.strokeStyle = accent2
    ctx.lineWidth = 1.2
    ctx.stroke()
    ctx.restore()
  }

  const drawAurora = (levels: number[], active: boolean, accent: string, accent2: string, time: number) => {
    if (!ctx) return
    ctx.save()
    for (let ribbon = 0; ribbon < 3; ribbon++) {
      const center = cssH * (0.36 + ribbon * 0.16)
      const amplitude = Math.max(4, cssH * 0.22)
      const fill = ctx.createLinearGradient(0, center - amplitude, 0, center + amplitude)
      fill.addColorStop(0, 'transparent')
      fill.addColorStop(0.5, ribbon % 2 ? accent2 : accent)
      fill.addColorStop(1, 'transparent')
      ctx.beginPath()
      for (let step = 0; step <= 48; step++) {
        const x = (step / 48) * cssW
        const band = Math.min(BANDS - 1, Math.floor(step / 2))
        const wave = Math.sin((x / cssW) * Math.PI * 2 + time * 0.42 + ribbon * 1.8) * amplitude
        const y = center + wave + levelAt(levels, band, active, time) * cssH * 0.2
        if (step === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.lineTo(cssW, cssH + 1)
      ctx.lineTo(0, cssH + 1)
      ctx.closePath()
      ctx.globalAlpha = active ? 0.22 + ribbon * 0.05 : 0.16 + ribbon * 0.03
      ctx.fillStyle = fill
      ctx.fill()
    }
    ctx.restore()
  }

  const drawSilk = (levels: number[], active: boolean, accent: string, accent2: string, time: number) => {
    if (!ctx) return
    ctx.save()
    ctx.lineCap = 'round'
    for (let strand = 0; strand < 4; strand++) {
      ctx.beginPath()
      for (let step = 0; step <= 40; step++) {
        const x = (step / 40) * cssW
        const band = Math.min(BANDS - 1, Math.floor(step / 2))
        const y = cssH * (0.24 + strand * 0.17)
          + Math.sin((step / 40) * Math.PI * 2 + time * 0.35 + strand) * cssH * 0.09
          + levelAt(levels, band, active, time) * cssH * 0.22
        if (!step) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = strand % 2 ? accent2 : accent
      ctx.globalAlpha = active ? 0.4 + strand * 0.05 : 0.28 + strand * 0.04
      ctx.lineWidth = strand === 1 ? 2.2 : 1.25
      ctx.shadowColor = accent
      ctx.shadowBlur = 8
      ctx.stroke()
    }
    ctx.restore()
  }

  const drawHalo = (levels: number[], active: boolean, gradient: CanvasGradient, accent: string, accent2: string, time: number) => {
    if (!ctx) return
    const cx = cssW / 2
    const cy = cssH / 2
    const inner = Math.max(6, Math.min(cssW, cssH) * 0.16)
    const maxLength = Math.max(4, Math.min(cssW, cssH) * 0.27)
    ctx.save()
    ctx.lineCap = 'round'
    ctx.globalAlpha = 0.18
    ctx.strokeStyle = accent
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(cx, cy, inner, 0, Math.PI * 2)
    ctx.stroke()
    for (let index = 0; index < BANDS; index++) {
      const angle = (Math.PI * 2 * index) / BANDS - Math.PI / 2
      const length = active ? levelAt(levels, index, active, time) * intensity() * maxLength : Math.max(2, idleAt(index, time) * maxLength * 0.14)
      ctx.globalAlpha = active ? 0.42 + clamp(levels[index], 0, 1) * 0.58 : 0.34
      ctx.strokeStyle = index % 2 ? accent2 : accent
      ctx.lineWidth = Math.max(1.6, Math.min(3.6, cssW / 150))
      ctx.shadowColor = accent
      ctx.shadowBlur = active ? 8 : 4
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner)
      ctx.lineTo(cx + Math.cos(angle) * (inner + Math.max(1, length)), cy + Math.sin(angle) * (inner + Math.max(1, length)))
      ctx.stroke()
    }
    ctx.globalAlpha = active ? 0.85 : 0.5
    ctx.fillStyle = gradient
    ctx.shadowBlur = 0
    ctx.beginPath()
    ctx.arc(cx, cy, inner * 0.42 * (1 + beatPulse * 0.3), 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  const drawOrbit = (levels: number[], active: boolean, gradient: CanvasGradient, accent: string, time: number) => {
    if (!ctx) return
    const cx = cssW / 2
    const cy = cssH / 2
    const radius = Math.min(cssW * 0.24, cssH * 0.43)
    ctx.save()
    ctx.lineCap = 'round'
    for (let ring = 0; ring < 3; ring++) {
      const r = radius * (0.5 + ring * 0.32) + (active ? 0 : Math.sin(time * 0.7 + ring) * 1.4)
      const start = time * (ring % 2 ? -0.07 : 0.07) + ring
      ctx.beginPath()
      ctx.arc(cx, cy, r, start, start + Math.PI * 1.72)
      ctx.strokeStyle = gradient
      ctx.globalAlpha = active ? 0.36 + levelAt(levels, ring * 7, active, time) * 0.34 : 0.42 - ring * 0.06
      ctx.lineWidth = ring === 1 ? 2.1 : 1.2
      ctx.shadowColor = accent
      ctx.shadowBlur = 7
      ctx.stroke()
    }
    ctx.restore()
  }

  const drawMirror = (levels: number[], active: boolean, gradient: CanvasGradient, time: number) => {
    if (!ctx) return
    const gap = clamp(cssW / 220, 1.5, 4)
    const sidePad = Math.max(5, cssW * 0.035)
    const width = (cssW - sidePad * 2 - gap * (BANDS - 1)) / BANDS
    const center = cssH * 0.52
    const maxHeight = cssH * 0.36
    ctx.save()
    ctx.fillStyle = gradient
    for (let index = 0; index < BANDS; index++) {
      const value = levelAt(levels, index, active, time)
      const height = Math.max(1.5, value * intensity() * maxHeight)
      const x = sidePad + index * (width + gap)
      ctx.globalAlpha = active ? 0.9 : 0.6
      ctx.shadowColor = active ? '#ffffff' : 'transparent'
      ctx.shadowBlur = active ? value * 7 : 0
      roundBar(x, center - height, width, height, Math.min(width / 2, 3))
      roundBar(x, center + 2, width, height, Math.min(width / 2, 3))
    }
    ctx.restore()
  }

  const drawRadial = (levels: number[], active: boolean, gradient: CanvasGradient, accent: string, time: number) => {
    if (!ctx) return
    const cx = cssW / 2
    const cy = cssH / 2
    const radius = Math.min(cssW, cssH) * 0.22
    const maxLength = Math.min(cssW, cssH) * 0.25 * intensity()
    ctx.save()
    ctx.lineCap = 'round'
    ctx.globalAlpha = 0.3
    ctx.strokeStyle = accent
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.stroke()
    for (let index = 0; index < BANDS; index++) {
      const angle = (Math.PI * 2 * index) / BANDS - Math.PI / 2
      const length = Math.max(2, levelAt(levels, index, active, time) * maxLength)
      ctx.globalAlpha = active ? 0.38 + levels[index] * 0.62 : 0.3
      ctx.strokeStyle = gradient
      ctx.lineWidth = Math.max(2, Math.min(4, cssW / 110))
      ctx.shadowColor = accent
      ctx.shadowBlur = active ? 8 : 3
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius)
      ctx.lineTo(cx + Math.cos(angle) * (radius + length), cy + Math.sin(angle) * (radius + length))
      ctx.stroke()
    }
    ctx.restore()
  }

  const drawParticles = (levels: number[], active: boolean, accent: string, accent2: string, time: number) => {
    if (!ctx) return
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (let index = 0; index < 28; index++) {
      const seed = index * 2.399963
      const xBase = (Math.sin(seed * 1.73) * 0.5 + 0.5) * cssW
      const yBase = (Math.cos(seed * 2.17) * 0.5 + 0.5) * cssH
      const band = index % BANDS
      const level = levelAt(levels, band, active, time)
      const phase = (time * (0.025 + level * 0.07) + index * 0.071) % 1
      const x = xBase + Math.sin(time * 0.16 + seed) * (5 + level * 12)
      const y = ((yBase - phase * cssH + cssH) % cssH)
      const radius = 1 + level * 4 + beatPulse * (index % 3 === 0 ? 2.5 : 0.8)
      ctx.globalAlpha = active ? 0.22 + level * 0.68 + beatPulse * 0.18 : 0.22
      ctx.fillStyle = index % 2 ? accent : accent2
      ctx.shadowColor = ctx.fillStyle
      ctx.shadowBlur = active ? radius * 3 : 4
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  const drawAmbientLight = (levels: number[], sourceActive: boolean, accent: string, accent2: string, time: number) => {
    if (!ctx) return
    const rms = (group: number[]) => Math.sqrt(group.reduce((sum, value) => sum + value * value, 0) / Math.max(1, group.length))
    // The broad-light transfer has its own lower noise floor than the crisp
    // geometry. WASAPI's FFT bands can be useful while still below the equalizer
    // gate, and the ambient fields should reflect that real low-level spectrum.
    const lift = (value: number) => clamp(Math.sqrt(Math.max(0, value - 0.0015)) * 1.7, 0, 1)
    const rawEnergy = rms(levels)
    const lowRaw = rms(levels.slice(0, 7))
    const midRaw = rms(levels.slice(7, 17))
    const highRaw = rms(levels.slice(17))
    // Even quiet but valid loopback frames must steer the light field. The
    // per-style active threshold is useful for crisp geometry, but using it as
    // the Ambient data gate made low-level music fall back to unrelated idle
    // breathing and looked like the effect was not listening to the track.
    const liveSpectrum = sourceActive && rawEnergy > 0.002
    const low = liveSpectrum ? lift(lowRaw) : idleAt(0, time) * 0.18
    const mid = liveSpectrum ? lift(midRaw) : idleAt(1, time + 1.8) * 0.16
    const high = liveSpectrum ? lift(highRaw) : idleAt(2, time + 3.1) * 0.14
    const drive = liveSpectrum ? clamp(lift(rawEnergy) + beatPulse * 0.25, 0, 1) : 0.12
    ctx.save()
    // Three broad, edge-to-edge light fields respond independently to bass,
    // mids and treble. The canvas is softly blurred by the media stage CSS, so
    // these overlap as one liquid wash without hard circular seams.
    ctx.globalCompositeOperation = 'screen'
    const fields = [
      { x: 0.08, y: 0.84, color: accent, amount: low, phase: 0.2, size: 0.76 },
      { x: 0.54, y: 0.12, color: accent2, amount: mid, phase: 2.1, size: 0.65 },
      { x: 0.98, y: 0.74, color: accent, amount: high, phase: 4.0, size: 0.6 },
    ]
    for (const field of fields) {
      const driftX = Math.sin(time * 0.22 + field.phase) * cssW * (0.035 + field.amount * 0.055)
      const driftY = Math.cos(time * 0.19 + field.phase) * cssH * (0.045 + field.amount * 0.04)
      const bx = cssW * field.x + driftX
      const by = cssH * field.y + driftY
      const radius = Math.max(cssW, cssH) * field.size * (0.92 + field.amount * 0.28)
      const glow = ctx.createRadialGradient(bx, by, 0, bx, by, radius)
      glow.addColorStop(0, field.color)
      glow.addColorStop(0.42, field.color)
      glow.addColorStop(1, 'transparent')
      ctx.globalAlpha = 0.12 + field.amount * 0.38 + drive * 0.1
      ctx.fillStyle = glow
      ctx.fillRect(0, 0, cssW, cssH)
    }
    ctx.restore()
  }

  const draw = () => {
    if (!ctx || !cssW || !cssH) return
    const theme = getComputedStyle(document.documentElement)
    const accent = theme.getPropertyValue('--accent').trim() || '#6e8bff'
    const accent2 = theme.getPropertyValue('--accent-2').trim() || '#b18cff'
    const gradient = ctx.createLinearGradient(0, 0, cssW, cssH)
    gradient.addColorStop(0, accent2)
    gradient.addColorStop(0.52, accent)
    gradient.addColorStop(1, accent2)
    ctx.clearRect(0, 0, cssW, cssH)
    const current = style()
    if (current === 'off') return
    const preview = syntheticAudioSpectrum()
    const sourceActive = audioCaptureStatus() === 'active' || preview !== null
    const rawBands = preview ?? audioSpectrum()
    const safeBands = Array.from({ length: BANDS }, (_, index) => clamp(rawBands[index] ?? 0, 0, 1))
    // Reject near-silence and isolated single-bin noise, but keep real quiet
    // music responsive across every visual style.
    const active = sourceActive && isMeaningfulSpectrum(safeBands)
    const now = performance.now()
    const dt = lastDynamicsAt ? clamp((now - lastDynamicsAt) / 1000, 1 / 120, 0.12) : 1 / 30
    lastDynamicsAt = now
    const levels = readLevels(active, safeBands, dt)
    const time = reducedMotion.matches ? 0 : performance.now() / 1000
    switch (current) {
      case 'ambient': drawAmbientLight(levels, active, accent, accent2, time); break
      case 'bars': drawBars(levels, active, gradient, time); break
      case 'mirror': drawMirror(levels, active, gradient, time); break
      case 'radial': drawRadial(levels, active, gradient, accent, time); break
      case 'particles': drawParticles(levels, active, accent, accent2, time); break
      case 'wave': drawWave(levels, active, gradient, accent, accent2, time); break
      case 'pulse': drawPulse(levels, active, accent, accent2, gradient, time); break
      case 'bloom': drawBloom(levels, active, gradient, accent, accent2, time); break
      case 'aurora': drawAurora(levels, active, accent, accent2, time); break
      case 'silk': drawSilk(levels, active, accent, accent2, time); break
      case 'halo': drawHalo(levels, active, gradient, accent, accent2, time); break
      case 'orbit': drawOrbit(levels, active, gradient, accent, time); break
    }
  }

  const frame = (now: number) => {
    raf = 0
    if (!ctx || disposed || document.hidden) return
    // 30fps is plenty for these scenes and keeps the desktop calm.
    if (now - previous < 1000 / 30) {
      raf = requestAnimationFrame(frame)
      return
    }
    previous = now
    draw()
    if (!reducedMotion.matches && style() !== 'off') raf = requestAnimationFrame(frame)
  }

  const requestFrame = () => {
    if (!disposed && !document.hidden && !raf && !reducedMotion.matches && style() !== 'off') {
      raf = requestAnimationFrame(frame)
    } else if (!disposed && !document.hidden && reducedMotion.matches) {
      draw()
    }
  }

  const releaseAudio = () => {
    captureEpoch++
    releaseCapture?.()
    releaseCapture = undefined
  }

  const acquireAudio = async () => {
    const isOff = () => style() === 'off'
    if (acquiring || releaseCapture || disposed || document.hidden || isOff()) return
    acquiring = true
    const epoch = ++captureEpoch
    const release = await subscribeAudioSpectrum()
    acquiring = false
    if (disposed || document.hidden || epoch !== captureEpoch || isOff()) release()
    else releaseCapture = release
    if (!disposed && !document.hidden && !isOff() && !releaseCapture) void acquireAudio()
  }

  onMount(() => {
    resize()
    const observer = wrapRef && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : undefined
    if (observer && wrapRef) observer.observe(wrapRef)
    const visibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf)
        raf = 0
        releaseAudio()
      } else {
        void acquireAudio()
        previous = performance.now()
        requestFrame()
      }
    }
    const motion = () => {
      cancelAnimationFrame(raf)
      raf = 0
      if (reducedMotion.matches) draw()
      else requestFrame()
    }
    const theme = new MutationObserver(() => requestFrame())
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    document.addEventListener('visibilitychange', visibility)
    reducedMotion.addEventListener('change', motion)
    previous = performance.now()
    if (!document.hidden) void acquireAudio()
    requestFrame()
    onCleanup(() => {
      observer?.disconnect()
      theme.disconnect()
      document.removeEventListener('visibilitychange', visibility)
      reducedMotion.removeEventListener('change', motion)
    })
  })

  createEffect(() => {
    props.intensity
    props.reactivity
    props.style
    if (style() === 'off') releaseAudio()
    else if (!document.hidden) void acquireAudio()
    audioCaptureStatus()
    audioCaptureError()
    requestFrame()
  })

  createEffect(() => {
    audioSpectrum()
    syntheticAudioSpectrum()
    if (!reducedMotion.matches) requestFrame()
  })

  onCleanup(() => {
    disposed = true
    cancelAnimationFrame(raf)
    releaseAudio()
  })

  const modeLabel = () => {
    if (style() === 'off') return 'Off'
    if (syntheticAudioSpectrum()) return 'Synthetic preview'
    if (audioCaptureStatus() === 'active') return 'System audio · live'
    if (audioCaptureStatus() === 'error') return 'Ambient · audio unavailable'
    return 'Ambient'
  }

  return (
    <div ref={wrapRef} class={`viz viz--${style()}`} aria-label={`${props.title ?? 'Now playing'} ${visualizerStyleLabel(style())} visualizer`}>
      <canvas ref={canvasRef} class="viz__canvas" aria-hidden="true" style={{ display: style() === 'off' ? 'none' : undefined }} />
      {props.showModeLabel !== false && <span class="viz__mode" aria-live="off">{modeLabel()}</span>}
      <span class="viz__sr-only" aria-live="polite">
        {audioCaptureError() ? `System audio visualization unavailable: ${audioCaptureError()}` : ''}
      </span>
    </div>
  )
}
