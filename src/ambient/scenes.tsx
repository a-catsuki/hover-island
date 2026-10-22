import { onCleanup, onMount } from 'solid-js'

/** Generative ambient backdrops. Both draw at 30 fps or less and stop with the page. */

type Colors = () => [string, string, string]
interface SceneProps { colors: Colors; dim: () => boolean }

const FRAME_MS = 1000 / 30

/** Sizes a canvas to its box at up to 1.5x, runs `draw` at 30 fps, and cleans up after itself. */
function useCanvas(canvas: () => HTMLCanvasElement | undefined, setup: (width: number, height: number) => void, draw: (context: CanvasRenderingContext2D, time: number, width: number, height: number) => void) {
  onMount(() => {
    const element = canvas()
    const context = element?.getContext('2d', { alpha: false })
    if (!element || !context) return
    let width = 0
    let height = 0
    const resize = () => {
      const scale = Math.min(window.devicePixelRatio || 1, 1.5)
      width = Math.max(1, Math.round(element.clientWidth * scale))
      height = Math.max(1, Math.round(element.clientHeight * scale))
      element.width = width
      element.height = height
      setup(width, height)
    }
    resize()
    let frame = 0
    let last = 0
    const loop = (time: number) => {
      frame = requestAnimationFrame(loop)
      if (time - last < FRAME_MS) return
      last = time
      draw(context, time, width, height)
    }
    frame = requestAnimationFrame(loop)
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    onCleanup(() => { cancelAnimationFrame(frame); observer.disconnect() })
  })
}

const rgb = (hex: string): [number, number, number] => {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map(part => part + part).join('') : value.padEnd(6, '0')
  return [0, 2, 4].map(start => parseInt(full.slice(start, start + 2), 16) || 0) as [number, number, number]
}
const rgba = (hex: string, alpha: number) => `rgba(${rgb(hex).join(',')},${alpha})`

interface Star { angle: number; radius: number; size: number; phase: number; speed: number; warm: boolean }
interface Meteor { x: number; y: number; dx: number; dy: number; start: number }

/**
 * A night sky turning slowly about a point above the screen, like a long exposure, with a faint
 * nebula in the palette colours and the odd shooting star.
 */
export function StarsScene(props: SceneProps) {
  let canvas: HTMLCanvasElement | undefined
  let stars: Star[] = []
  let meteor: Meteor | null = null
  let nextMeteor = 6000
  useCanvas(() => canvas, (width, height) => {
    const reach = Math.hypot(width, height)
    const count = Math.round(Math.min(520, (width * height) / 5200))
    stars = Array.from({ length: count }, () => ({
      angle: Math.random() * Math.PI * 2,
      radius: Math.sqrt(Math.random()) * reach,
      size: Math.random() < 0.08 ? 1.4 + Math.random() * 1.2 : 0.5 + Math.random() * 0.9,
      phase: Math.random() * Math.PI * 2,
      speed: 0.0006 + Math.random() * 0.0018,
      warm: Math.random() < 0.18,
    }))
  }, (context, time, width, height) => {
    const [c1, c2] = props.colors()
    const dim = props.dim() ? 0.7 : 1
    context.fillStyle = '#03040a'
    context.fillRect(0, 0, width, height)
    // Nebula: two soft clouds that drift over minutes.
    for (const [color, ox, oy, size] of [[c1, 0.28, 0.35, 0.6], [c2, 0.74, 0.62, 0.55]] as const) {
      const x = width * (ox + Math.sin(time / 41000 + ox * 9) * 0.06)
      const y = height * (oy + Math.cos(time / 53000 + oy * 7) * 0.05)
      const radius = Math.max(width, height) * size
      const cloud = context.createRadialGradient(x, y, 0, x, y, radius)
      cloud.addColorStop(0, rgba(color, 0.2 * dim))
      cloud.addColorStop(1, rgba(color, 0))
      context.fillStyle = cloud
      context.fillRect(0, 0, width, height)
    }
    // The sky turns about a pole above the top of the screen.
    const poleX = width * 0.5
    const poleY = -height * 0.35
    const turn = time * 0.0000035
    for (const star of stars) {
      const angle = star.angle + turn
      const x = poleX + Math.cos(angle) * star.radius
      const y = poleY + Math.sin(angle) * star.radius
      if (x < -4 || y < -4 || x > width + 4 || y > height + 4) continue
      const twinkle = 0.55 + 0.45 * Math.sin(time * star.speed + star.phase)
      context.fillStyle = star.warm ? `rgba(255,214,170,${twinkle * dim})` : `rgba(235,242,255,${twinkle * dim})`
      context.beginPath()
      context.arc(x, y, star.size, 0, Math.PI * 2)
      context.fill()
    }
    // A shooting star every so often.
    if (!meteor && time > nextMeteor) {
      const fromLeft = Math.random() < 0.5
      meteor = { x: width * (fromLeft ? 0.1 + Math.random() * 0.4 : 0.5 + Math.random() * 0.4), y: height * Math.random() * 0.4, dx: (fromLeft ? 1 : -1) * width * 0.0011, dy: height * 0.0006, start: time }
    }
    if (meteor) {
      const age = time - meteor.start
      if (age > 1100) {
        meteor = null
        nextMeteor = time + 7000 + Math.random() * 12000
      } else {
        const fade = Math.sin((age / 1100) * Math.PI)
        const headX = meteor.x + meteor.dx * age
        const headY = meteor.y + meteor.dy * age
        const tail = context.createLinearGradient(headX, headY, headX - meteor.dx * 220, headY - meteor.dy * 220)
        tail.addColorStop(0, `rgba(255,255,255,${0.9 * fade * dim})`)
        tail.addColorStop(1, 'rgba(255,255,255,0)')
        context.strokeStyle = tail
        context.lineWidth = 1.6
        context.beginPath()
        context.moveTo(headX, headY)
        context.lineTo(headX - meteor.dx * 220, headY - meteor.dy * 220)
        context.stroke()
      }
    }
  })
  return <canvas ref={canvas} class="ambient__canvas" aria-hidden="true" />
}

interface Particle { x: number; y: number; life: number; tint: number }

/** Silky lines that follow a slowly changing current, in the palette colours. */
export function FlowScene(props: SceneProps) {
  let canvas: HTMLCanvasElement | undefined
  let particles: Particle[] = []
  let cleared = false
  let frames = 0
  const spawn = (width: number, height: number): Particle => ({ x: Math.random() * width, y: Math.random() * height, life: 200 + Math.random() * 400, tint: Math.floor(Math.random() * 3) })
  useCanvas(() => canvas, (width, height) => {
    const count = Math.round(Math.min(700, (width * height) / 3600))
    particles = Array.from({ length: count }, () => spawn(width, height))
    cleared = false
  }, (context, time, width, height) => {
    const colors = props.colors()
    const dim = props.dim() ? 0.8 : 1
    if (!cleared) {
      context.fillStyle = '#04050a'
      context.fillRect(0, 0, width, height)
      cleared = true
    }
    // Fade old strokes slowly, so each line leaves a long, soft trail.
    if (++frames % 2 === 0) {
      context.fillStyle = 'rgba(4,5,10,0.03)'
      context.fillRect(0, 0, width, height)
    }
    const scale = 1 / Math.max(width, height)
    const t = time * 0.00005
    context.lineWidth = 1.1
    for (const tint of [0, 1, 2]) {
      context.strokeStyle = rgba(tint === 2 ? '#ffffff' : colors[tint], (tint === 2 ? 0.18 : 0.42) * dim)
      context.beginPath()
      for (const particle of particles) {
        if (particle.tint !== tint) continue
        const nx = particle.x * scale
        const ny = particle.y * scale
        // A broad, slowly shifting current: low frequencies give long, sweeping curves.
        const angle = (Math.sin(nx * 2.4 + t * 2.1) + Math.cos(ny * 2.1 - t * 1.7) + Math.sin((nx - ny) * 1.3 + t)) * 1.1
        const x = particle.x + Math.cos(angle) * 2.4
        const y = particle.y + Math.sin(angle) * 2.4
        context.moveTo(particle.x, particle.y)
        context.lineTo(x, y)
        particle.x = x
        particle.y = y
        particle.life -= 1
        if (particle.life <= 0 || x < 0 || y < 0 || x > width || y > height) Object.assign(particle, spawn(width, height))
      }
      context.stroke()
    }
  })
  return <canvas ref={canvas} class="ambient__canvas" aria-hidden="true" />
}
