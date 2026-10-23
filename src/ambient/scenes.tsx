import { onCleanup, onMount } from 'solid-js'

/** What a canvas scene reads each frame: its colours and how loud the music is right now. */
export interface SceneInput {
  colors: () => [string, string, string]
  /** 0..1, smoothed. */
  energy: () => number
  /** Changes on each detected beat. */
  beat: () => number
  dim: () => boolean
}

/** Full-screen canvas at CSS pixel size (ambient scenes are soft; device pixels would only cost GPU time). */
function useCanvas(draw: (context: CanvasRenderingContext2D, width: number, height: number, dt: number, time: number) => void) {
  let canvas: HTMLCanvasElement | undefined
  onMount(() => {
    const context = canvas!.getContext('2d')
    if (!context) return
    let width = 0
    let height = 0
    const resize = () => {
      width = canvas!.width = window.innerWidth
      height = canvas!.height = window.innerHeight
    }
    resize()
    window.addEventListener('resize', resize)
    let last = performance.now()
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    const loop = (now: number) => {
      // The first frame time can be a little before `last`.
      const dt = Math.max(0, Math.min(0.1, (now - last) / 1000))
      last = now
      draw(context, width, height, reduced.matches ? 0 : dt, reduced.matches ? 0 : now / 1000)
      if (!reduced.matches) frame = requestAnimationFrame(loop)
    }
    const repaint = () => { cancelAnimationFrame(frame); last = performance.now(); frame = requestAnimationFrame(loop) }
    repaint()
    reduced.addEventListener('change', repaint)
    window.addEventListener('resize', repaint)
    onCleanup(() => { cancelAnimationFrame(frame); reduced.removeEventListener('change', repaint); window.removeEventListener('resize', repaint); window.removeEventListener('resize', resize) })
  })
  return <canvas class="ambient__canvas" ref={canvas} aria-hidden="true" />
}

interface Star { x: number; y: number; z: number; twinkle: number; tint: number }

/** A slow drift through a star field that speeds up with the music, and the odd shooting star. */
export function Starfield(props: SceneInput) {
  const stars: Star[] = []
  let width = window.innerWidth
  let height = window.innerHeight
  /** Places a star at a random point on screen, at a random depth, or far away to drift in. */
  const spawn = (star: Star, far: boolean) => {
    star.z = far ? 0.7 + Math.random() * 0.3 : 0.08 + Math.random() * 0.92
    const scale = Math.max(width, height) * 0.5
    star.x = ((Math.random() - 0.5) * width / scale) * star.z
    star.y = ((Math.random() - 0.5) * height / scale) * star.z
    star.twinkle = Math.random() * Math.PI * 2
    star.tint = Math.random()
  }
  for (let index = 0; index < 600; index++) {
    const star = { x: 0, y: 0, z: 0, twinkle: 0, tint: 0 }
    spawn(star, false)
    stars.push(star)
  }
  let comet: { x: number; y: number; vx: number; vy: number; life: number } | null = null
  let nextComet = 6 + Math.random() * 10
  return useCanvas((context, w, h, dt, time) => {
    width = w
    height = h
    const [c1, c2] = props.colors()
    const speed = (props.dim() ? 0.012 : 0.02) + props.energy() * 0.22
    const scale = Math.max(width, height) * 0.5
    context.clearRect(0, 0, width, height)
    for (const star of stars) {
      star.z -= speed * dt
      if (star.z <= 0.04) spawn(star, true)
      const sx = width / 2 + (star.x / star.z) * scale
      const sy = height / 2 + (star.y / star.z) * scale
      if (sx < -10 || sx > width + 10 || sy < -10 || sy > height + 10) { spawn(star, true); continue }
      const near = 1 - star.z
      const glow = 0.55 + 0.45 * Math.sin(time * (1.2 + star.tint * 2) + star.twinkle)
      context.globalAlpha = Math.min(1, 0.3 + near) * glow
      context.fillStyle = star.tint > 0.86 ? c1 : star.tint > 0.72 ? c2 : '#fff'
      const size = 0.6 + near * near * 2.6
      context.beginPath()
      context.arc(sx, sy, size, 0, Math.PI * 2)
      context.fill()
    }
    nextComet -= dt
    if (!comet && nextComet <= 0) {
      const angle = Math.PI * (0.15 + Math.random() * 0.2)
      comet = { x: Math.random() * width * 0.7, y: Math.random() * height * 0.3, vx: Math.cos(angle) * width * 0.9, vy: Math.sin(angle) * width * 0.9, life: 1 }
      nextComet = 8 + Math.random() * 16
    }
    if (comet) {
      comet.life -= dt * 1.4
      comet.x += comet.vx * dt
      comet.y += comet.vy * dt
      const gradient = context.createLinearGradient(comet.x, comet.y, comet.x - comet.vx * 0.12, comet.y - comet.vy * 0.12)
      gradient.addColorStop(0, '#fff')
      gradient.addColorStop(1, 'transparent')
      context.globalAlpha = Math.max(0, comet.life)
      context.strokeStyle = gradient
      context.lineWidth = 1.6
      context.beginPath()
      context.moveTo(comet.x, comet.y)
      context.lineTo(comet.x - comet.vx * 0.12, comet.y - comet.vy * 0.12)
      context.stroke()
      if (comet.life <= 0) comet = null
    }
    context.globalAlpha = 1
  })
}

/** Rings of light that spread from the middle: one on each beat while music plays, a slow breath otherwise. */
export function Ripples(props: SceneInput) {
  const rings: { radius: number; strength: number; color: number }[] = []
  let lastBeat = props.beat()
  let sinceRing = 99
  let color = 0
  return useCanvas((context, width, height, dt) => {
    const colors = props.colors()
    const energy = props.energy()
    const beat = props.beat()
    sinceRing += dt
    const onBeat = beat !== lastBeat && sinceRing > 0.32
    lastBeat = beat
    if (onBeat || sinceRing > (props.dim() ? 3.4 : 2.6)) {
      rings.push({ radius: 0, strength: onBeat ? 0.55 + energy * 0.45 : 0.45, color: color++ % 2 })
      sinceRing = 0
    }
    const reach = Math.hypot(width, height) / 2
    context.clearRect(0, 0, width, height)
    context.globalCompositeOperation = 'lighter'
    for (let index = rings.length - 1; index >= 0; index--) {
      const ring = rings[index]
      ring.radius += dt * reach * (0.16 + energy * 0.12)
      const fade = 1 - ring.radius / reach
      if (fade <= 0) { rings.splice(index, 1); continue }
      context.strokeStyle = colors[ring.color]
      // A wide faint stroke under a thin bright one reads as glow without a costly blur.
      context.globalAlpha = fade * fade * ring.strength * 0.18
      context.lineWidth = 26
      context.beginPath()
      context.arc(width / 2, height / 2, ring.radius, 0, Math.PI * 2)
      context.stroke()
      context.globalAlpha = fade * ring.strength * 0.7
      context.lineWidth = 1.5 + ring.strength * 1.5
      context.stroke()
    }
    context.globalCompositeOperation = 'source-over'
    context.globalAlpha = 1
  })
}
