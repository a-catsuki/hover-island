import { createEffect, onCleanup, onMount } from 'solid-js'
import { ambientSurfaceSize } from '../lib/ambientSurface'

/** One bounded bitmap replaces several full-screen blur/filter/compositing surfaces. */
export default function AmbientBackdrop(props: { colors: [string,string,string]; artwork: string | null; dim: boolean; energy: number }) {
  let canvas!: HTMLCanvasElement
  let context: CanvasRenderingContext2D | null = null
  let artwork: HTMLCanvasElement | null = null
  let paint: (time: number) => void = () => {}

  createEffect(() => {
    const source = props.artwork
    artwork = null
    if (!source) return
    const image = new Image()
    let stale = false
    const settle = () => { image.onload = image.onerror = null; image.removeAttribute('src') }
    image.onload = () => {
      if (stale) return
      const small = document.createElement('canvas'); small.width = 64; small.height = 40
      const ctx = small.getContext('2d')
      if (ctx && image.naturalWidth && image.naturalHeight) {
        const scale = Math.max(64/image.naturalWidth,40/image.naturalHeight)
        const w = image.naturalWidth*scale, h = image.naturalHeight*scale
        ctx.drawImage(image,(64-w)/2,(40-h)/2,w,h)
        artwork = small
      }
      settle(); paint(performance.now())
    }
    image.onerror = settle
    image.src = source
    onCleanup(() => { stale = true; settle(); if (artwork) artwork.width = artwork.height = 0; artwork = null })
  })

  onMount(() => {
    context = canvas.getContext('2d', { alpha: false })
    if (!context) return
    const ctx = context
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    paint = time => {
      const w = canvas.width, h = canvas.height
      const seconds = reduced.matches ? 0 : time/1000
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = '#05060a'; ctx.fillRect(0,0,w,h)
      if (artwork) {
        ctx.globalAlpha = props.dim ? .46 : .62
        ctx.imageSmoothingEnabled = true
        ctx.drawImage(artwork,-w*.05,-h*.05,w*1.1,h*1.1)
      } else {
        ctx.globalCompositeOperation = 'screen'
        ctx.globalAlpha = props.dim ? .38 : .55
        const glow = (x:number,y:number,r:number,color:string) => {
          const gradient = ctx.createRadialGradient(x*w,y*h,0,x*w,y*h,r*Math.max(w,h))
          gradient.addColorStop(0,color); gradient.addColorStop(1,'transparent')
          ctx.fillStyle = gradient; ctx.fillRect(0,0,w,h)
        }
        const pulse = props.energy*.08
        glow(.22+Math.sin(seconds/42)*.08,.2+Math.cos(seconds/47)*.08,.68+pulse,props.colors[0])
        glow(.83+Math.sin(seconds/48)*.06,.48+Math.cos(seconds/38)*.09,.6+pulse,props.colors[1])
        glow(.48+Math.sin(seconds/51)*.08,.92,.58,props.colors[2])
      }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'
      const shade = ctx.createRadialGradient(w/2,h/2,0,w/2,h/2,Math.hypot(w,h)/2)
      shade.addColorStop(.35,'transparent'); shade.addColorStop(1,'rgba(0,0,0,.72)')
      ctx.fillStyle = shade; ctx.fillRect(0,0,w,h)
    }
    const resize = () => {
      const size = ambientSurfaceSize(innerWidth,innerHeight)
      canvas.width = size.width; canvas.height = size.height
      paint(performance.now())
    }
    resize()
    let frame = 0, last = 0
    const loop = (time:number) => {
      if (time-last >= 100) { last = time; paint(time) }
      if (!reduced.matches) frame = requestAnimationFrame(loop)
    }
    const restart = () => { cancelAnimationFrame(frame); paint(performance.now()); if (!reduced.matches) frame = requestAnimationFrame(loop) }
    restart()
    addEventListener('resize',resize); reduced.addEventListener('change',restart)
    onCleanup(() => { cancelAnimationFrame(frame); removeEventListener('resize',resize); reduced.removeEventListener('change',restart); paint = () => {}; context = null; canvas.width = canvas.height = 1 })
  })
  return <canvas ref={canvas} class="ambient__backdrop" aria-hidden="true" />
}
