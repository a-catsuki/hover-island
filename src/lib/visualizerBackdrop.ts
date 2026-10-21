import type { VisualizerDynamics } from './visualizerEngine'
import type { VisualizerMode } from './visualizerStyles'

/**
 * Full-bleed media backdrop painter. One 2D canvas, additive blending, low alpha.
 * Everything that allocates (gradients, glow sprites, typed arrays) is built in
 * `resize`/`setColors`; `draw` only reads and writes pre-allocated buffers.
 */
export type Rgb = readonly [number, number, number]

const TAU = Math.PI * 2
const BANDS = 24
const FLOW_POINTS = 36
const AURORA_POINTS = 30
const MAX_BARS = 64
const RING_COUNT = 4
const clamp = (value: number, min = 0, max = 1) => Number.isFinite(value) ? (value < min ? min : value > max ? max : value) : min

export const DEFAULT_BACKDROP_COLORS: readonly [Rgb, Rgb, Rgb] = [[10, 132, 255], [191, 90, 242], [100, 210, 255]]

/** `#rgb`, `#rrggbb`, `rgb()` and `rgba()` are enough for album palettes and theme tokens. */
export function parseColor(input: string | null | undefined, fallback: Rgb): Rgb {
  const text = (input ?? '').trim()
  let match = /^#([0-9a-f]{3})$/i.exec(text)
  if (match) {
    const [r, g, b] = match[1].split('').map((digit) => parseInt(digit + digit, 16))
    return [r, g, b]
  }
  match = /^#([0-9a-f]{6})/i.exec(text)
  if (match) {
    const value = parseInt(match[1], 16)
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
  }
  const functional = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text)
  if (functional) return [clamp(+functional[1], 0, 255) | 0, clamp(+functional[2], 0, 255) | 0, clamp(+functional[3], 0, 255) | 0]
  return fallback
}

const rgba = (color: Rgb, alpha: number) => `rgba(${color[0]},${color[1]},${color[2]},${alpha})`

export interface BackdropRenderer {
  resize(width: number, height: number, scale: number): void
  setColors(colors: readonly Rgb[]): void
  draw(mode: VisualizerMode, state: VisualizerDynamics, time: number, dt: number, gain: number): void
  clear(): void
  dispose(): void
}

export function createBackdropRenderer(context: CanvasRenderingContext2D): BackdropRenderer {
  let width = 1
  let height = 1
  let colors: readonly Rgb[] = DEFAULT_BACKDROP_COLORS
  const flowFill: CanvasGradient[] = []
  const hangFill: CanvasGradient[] = []
  const riseFill: CanvasGradient[] = []
  const strokes: string[] = []
  const glows = [0, 1, 2].map(() => document.createElement('canvas'))
  const level = new Float32Array(BANDS)
  const heights = new Float32Array(MAX_BARS)
  const flowX = new Float32Array(FLOW_POINTS)
  const flowTop = new Float32Array(FLOW_POINTS)
  const flowBottom = new Float32Array(FLOW_POINTS)
  const auroraX = new Float32Array(AURORA_POINTS)
  const auroraY = new Float32Array(AURORA_POINTS)
  const ringAge = new Float32Array(RING_COUNT).fill(-1)
  let ringCursor = 0
  let previousKick = 0
  const roundRect = (context as CanvasRenderingContext2D & { roundRect?: (x: number, y: number, w: number, h: number, r: number | number[]) => void }).roundRect

  const build = () => {
    flowFill.length = hangFill.length = riseFill.length = strokes.length = 0
    for (let index = 0; index < 3; index++) {
      const color = colors[index] ?? colors[0]
      const flow = context.createLinearGradient(0, 0, 0, height)
      flow.addColorStop(0, rgba(color, 0))
      flow.addColorStop(0.5, rgba(color, 0.36))
      flow.addColorStop(1, rgba(color, 0))
      flowFill.push(flow)
      const hang = context.createLinearGradient(0, 0, 0, height)
      hang.addColorStop(0, rgba(color, 0))
      hang.addColorStop(0.3, rgba(color, 0.05))
      hang.addColorStop(0.72, rgba(color, 0.2))
      hang.addColorStop(1, rgba(color, 0))
      hangFill.push(hang)
      const rise = context.createLinearGradient(0, height, 0, height * 0.18)
      rise.addColorStop(0, rgba(color, 0.62))
      rise.addColorStop(0.6, rgba(color, 0.16))
      rise.addColorStop(1, rgba(color, 0))
      riseFill.push(rise)
      strokes.push(rgba(color, 1))
      const sprite = glows[index]
      sprite.width = sprite.height = 96
      const ctx = sprite.getContext('2d')
      if (ctx) {
        ctx.clearRect(0, 0, 96, 96)
        const glow = ctx.createRadialGradient(48, 48, 0, 48, 48, 48)
        glow.addColorStop(0, rgba(color, 0.85))
        glow.addColorStop(0.35, rgba(color, 0.32))
        glow.addColorStop(1, rgba(color, 0))
        ctx.fillStyle = glow
        ctx.fillRect(0, 0, 96, 96)
      }
    }
    for (let index = 0; index < FLOW_POINTS; index++) flowX[index] = (index / (FLOW_POINTS - 1)) * width
    for (let index = 0; index < AURORA_POINTS; index++) auroraX[index] = (index / (AURORA_POINTS - 1)) * width
  }

  const sample = (at: number) => {
    const position = clamp(at) * (BANDS - 1)
    const lower = position | 0
    const upper = lower + 1 < BANDS ? lower + 1 : lower
    return level[lower] + (level[upper] - level[lower]) * (position - lower)
  }

  const shape = (state: VisualizerDynamics, time: number, gain: number) => {
    // Silence breathes very gently; real sound takes over completely as soon as it arrives.
    const idle = 1 - Math.min(1, state.energy * 10)
    for (let index = 0; index < BANDS; index++) {
      const raw = clamp((state.bands[index] - 0.08) / 0.8)
      const heard = Math.pow(raw, 1.15) * gain * (1 + (index / BANDS) * 0.55)
      const breath = (0.1 + 0.06 * Math.sin(time * 0.8 + index * 0.55)) * idle
      level[index] = clamp(heard > breath ? heard : breath)
    }
  }

  /** Smooth closed ribbon through (x, top) then back through (x, bottom). */
  const ribbon = (x: Float32Array, top: Float32Array, bottom: Float32Array, count: number) => {
    context.beginPath()
    context.moveTo(x[0], top[0])
    for (let index = 1; index < count; index++) {
      context.quadraticCurveTo(x[index - 1], top[index - 1], (x[index - 1] + x[index]) / 2, (top[index - 1] + top[index]) / 2)
    }
    context.lineTo(x[count - 1], top[count - 1])
    context.lineTo(x[count - 1], bottom[count - 1])
    for (let index = count - 1; index > 0; index--) {
      context.quadraticCurveTo(x[index], bottom[index], (x[index - 1] + x[index]) / 2, (bottom[index - 1] + bottom[index]) / 2)
    }
    context.lineTo(x[0], bottom[0])
    context.closePath()
  }

  const drawFlow = (state: VisualizerDynamics, time: number, gain: number) => {
    for (let layer = 0; layer < 3; layer++) {
      const cy = height * (0.5 + (layer - 1) * 0.045 * Math.sin(time * 0.45 + layer * 1.7))
      const speed = 0.55 + layer * 0.23
      const cycles = 1.6 + layer * 0.9
      const scale = 0.36 - layer * 0.05
      for (let index = 0; index < FLOW_POINTS; index++) {
        const u = index / (FLOW_POINTS - 1)
        const mirrored = Math.abs(u - 0.5) * 2
        // Low frequencies sit in the middle and the highs spread to the edges.
        const band = sample(0.03 + Math.pow(mirrored, 0.85) * 0.8)
        const wobble = 0.6 + 0.4 * Math.sin(u * TAU * cycles + time * speed + layer * 2.1)
        const envelope = Math.pow(Math.sin(Math.PI * u), 0.7)
        const amplitude = height * (0.03 + scale * band * wobble) * envelope
        flowTop[index] = cy - amplitude
        flowBottom[index] = cy + amplitude
      }
      ribbon(flowX, flowTop, flowBottom, FLOW_POINTS)
      context.globalAlpha = clamp(0.5 + state.energy * 0.7 * gain, 0, 0.95)
      context.fillStyle = flowFill[layer]
      context.fill()
      context.globalAlpha = 0.2
      context.strokeStyle = strokes[layer]
      context.lineWidth = 1.2
      context.stroke()
    }
  }

  const drawBars = (state: VisualizerDynamics) => {
    const count = Math.min(MAX_BARS, Math.max(14, Math.round(width / 9)))
    const slot = width / count
    const barWidth = Math.max(2, slot * 0.58)
    const radius = barWidth / 2
    for (let index = 0; index < count; index++) {
      const u = (index + 0.5) / count
      heights[index] = 3 + sample(u * 0.94) * height * 0.62
    }
    // A faint floor glow that breathes with the bass keeps the bars connected to the edge.
    context.globalAlpha = 0.12 + state.bass * 0.3
    context.fillStyle = riseFill[0]
    context.fillRect(0, height * 0.18, width, height * 0.82)
    context.globalAlpha = 0.9
    for (let group = 0; group < 3; group++) {
      const from = Math.floor((group * count) / 3)
      const to = Math.floor(((group + 1) * count) / 3)
      context.beginPath()
      for (let index = from; index < to; index++) {
        const x = index * slot + (slot - barWidth) / 2
        const barHeight = heights[index]
        if (roundRect) roundRect.call(context, x, height - barHeight, barWidth, barHeight + radius, [radius, radius, 0, 0])
        else context.rect(x, height - barHeight, barWidth, barHeight)
      }
      context.fillStyle = riseFill[group]
      context.fill()
    }
  }

  const drawAurora = (state: VisualizerDynamics, time: number, gain: number) => {
    for (let layer = 0; layer < 3; layer++) {
      for (let index = 0; index < AURORA_POINTS; index++) {
        const u = index / (AURORA_POINTS - 1)
        const drift = Math.sin(u * TAU * (0.9 + layer * 0.4) + time * (0.25 + layer * 0.1) + layer * 2) * height * 0.07
        const heard = sample(clamp(u * 0.7 + layer * 0.12)) * height * 0.3
        auroraY[index] = height * (0.34 + layer * 0.12) + drift + heard
      }
      context.beginPath()
      context.moveTo(0, -2)
      context.lineTo(auroraX[0], auroraY[0])
      for (let index = 1; index < AURORA_POINTS; index++) {
        context.quadraticCurveTo(auroraX[index - 1], auroraY[index - 1], (auroraX[index - 1] + auroraX[index]) / 2, (auroraY[index - 1] + auroraY[index]) / 2)
      }
      context.lineTo(auroraX[AURORA_POINTS - 1], auroraY[AURORA_POINTS - 1])
      context.lineTo(width, -2)
      context.closePath()
      context.globalAlpha = clamp(0.55 + state.energy * 0.5 * gain, 0, 0.9)
      context.fillStyle = hangFill[layer]
      context.fill()
    }
  }

  const drawPulse = (state: VisualizerDynamics, time: number, dt: number, gain: number) => {
    const reach = Math.max(width, height)
    for (let glow = 0; glow < 3; glow++) {
      let sum = 0
      const from = glow * 8
      for (let index = from; index < from + 8; index++) sum += level[index]
      const heard = sum / 8
      const x = width * (0.2 + glow * 0.3) + Math.sin(time * 0.4 + glow * 2.1) * width * 0.04
      const y = height * (glow === 1 ? 0.6 : 0.76) + Math.cos(time * 0.33 + glow) * height * 0.03
      const radius = reach * (0.34 + heard * 0.5 + (glow === 0 ? state.kick * 0.08 : 0))
      context.globalAlpha = clamp(0.16 + heard * 0.5 * gain, 0, 0.7)
      context.drawImage(glows[glow], x - radius, y - radius, radius * 2, radius * 2)
    }
    if (state.kick > 0.45 && previousKick < 0.3) {
      ringAge[ringCursor] = 0
      ringCursor = (ringCursor + 1) % RING_COUNT
    }
    previousKick = state.kick
    context.strokeStyle = strokes[2]
    for (let ring = 0; ring < RING_COUNT; ring++) {
      const age = ringAge[ring]
      if (age < 0) continue
      const next = age + dt / 1.5
      if (next >= 1) { ringAge[ring] = -1; continue }
      ringAge[ring] = next
      context.globalAlpha = clamp((1 - next) * (1 - next) * 0.45 * gain, 0, 0.6)
      context.lineWidth = 1 + 2.5 * (1 - next)
      context.beginPath()
      context.arc(width * 0.5, height * 0.62, reach * (0.08 + next * 0.55), 0, TAU)
      context.stroke()
    }
  }

  return {
    resize(nextWidth, nextHeight, scale) {
      width = Math.max(1, nextWidth)
      height = Math.max(1, nextHeight)
      context.setTransform(scale, 0, 0, scale, 0, 0)
      build()
    },
    setColors(next) {
      if (next.length < 3) return
      colors = next
      build()
    },
    draw(mode, state, time, dt, gain) {
      context.clearRect(0, 0, width, height)
      if (mode === 'off') return
      shape(state, time, gain)
      context.globalCompositeOperation = 'lighter'
      if (mode === 'ambient') drawFlow(state, time, gain)
      else if (mode === 'bars') drawBars(state)
      else if (mode === 'wave') drawAurora(state, time, gain)
      else drawPulse(state, time, dt, gain)
      context.globalCompositeOperation = 'source-over'
      context.globalAlpha = 1
    },
    clear() {
      context.clearRect(0, 0, width, height)
    },
    dispose() {
      for (const sprite of glows) sprite.width = sprite.height = 0
    },
  }
}
