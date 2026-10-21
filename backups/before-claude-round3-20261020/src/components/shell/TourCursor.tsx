import { createEffect, createSignal, For, on, onCleanup, onMount } from 'solid-js'
import { dampingFor, springStep } from '../../lib/onboardingConfig'
import { reportTourArrived, tourClickTick, tourGoal } from '../../state/onboarding'
import './TourCursor.css'

/*
 * The virtual cursor, its click ripple and the highlight ring.
 * One rAF loop springs all of them toward the current goal element, so they
 * keep up when the island is still growing. With reduced motion the cursor is
 * not drawn and the ring snaps; the tour reads the same.
 */

const CURSOR_K = 150
const CURSOR_DAMPING = dampingFor(CURSOR_K, 0.8)
const RING_K = 320
const RING_DAMPING = dampingFor(RING_K, 1)

interface Ripple { id: number; x: number; y: number }

export default function TourCursor() {
  let cursor: HTMLDivElement | undefined
  let ring: HTMLDivElement | undefined
  const [ripples, setRipples] = createSignal<Ripple[]>([])
  let rippleId = 0
  let press: ReturnType<typeof setTimeout> | undefined

  // Cursor tip position and velocity.
  const c = { x: 0, y: 0, vx: 0, vy: 0, ready: false, shown: false }
  // Ring rect: x, y, w, h with velocities.
  const r = { x: 0, y: 0, w: 0, h: 0, vx: 0, vy: 0, vw: 0, vh: 0, ready: false, radius: 12, goal: -1 }
  let arrivedFor = -1
  let frame = 0
  let last = performance.now()
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')

  const tick = (now: number) => {
    frame = requestAnimationFrame(tick)
    const dt = Math.min(0.033, Math.max(0.001, (now - last) / 1000))
    last = now
    const goal = tourGoal()
    if (!goal || !goal.el.isConnected) {
      if (cursor) cursor.dataset.shown = 'false'
      if (ring) ring.dataset.shown = 'false'
      c.shown = false
      return
    }
    const rect = goal.el.getBoundingClientRect()
    const tx = rect.left + rect.width * goal.ax
    const ty = rect.top + rect.height * goal.ay
    const reduced = motion.matches

    if (!c.ready) {
      // Enter from the lower right of the target, like a hand coming in.
      c.x = Math.min(window.innerWidth - 16, tx + 150)
      c.y = Math.min(window.innerHeight - 16, ty + 220)
      c.vx = c.vy = 0
      c.ready = true
    }
    if (reduced) { c.x = tx; c.y = ty; c.vx = c.vy = 0 }
    else {
      // Slightly different stiffness per axis bends the path into a soft arc.
      const steps = Math.max(1, Math.ceil(dt / (1 / 240)))
      const h = dt / steps
      for (let i = 0; i < steps; i++) {
        ;[c.x, c.vx] = springStep(c.x, c.vx, tx, h, CURSOR_K, CURSOR_DAMPING)
        ;[c.y, c.vy] = springStep(c.y, c.vy, ty, h, CURSOR_K * 0.82, dampingFor(CURSOR_K * 0.82, 0.8))
      }
    }
    if (cursor) {
      cursor.style.transform = `translate3d(${c.x.toFixed(2)}px, ${c.y.toFixed(2)}px, 0)`
      cursor.dataset.shown = reduced ? 'false' : 'true'
    }

    const pad = 5
    const gx = rect.left - pad, gy = rect.top - pad, gw = rect.width + pad * 2, gh = rect.height + pad * 2
    if (r.goal !== goal.id) {
      r.goal = goal.id
      const radius = parseFloat(getComputedStyle(goal.el).borderTopLeftRadius) || 0
      r.radius = (radius < 4 && rect.height < 56 ? rect.height / 2 : radius) + pad
    }
    if (!r.ready || reduced) {
      r.x = gx; r.y = gy; r.w = gw; r.h = gh
      r.vx = r.vy = r.vw = r.vh = 0
      r.ready = true
    } else {
      const steps = Math.max(1, Math.ceil(dt / (1 / 240)))
      const h = dt / steps
      for (let i = 0; i < steps; i++) {
        ;[r.x, r.vx] = springStep(r.x, r.vx, gx, h, RING_K, RING_DAMPING)
        ;[r.y, r.vy] = springStep(r.y, r.vy, gy, h, RING_K, RING_DAMPING)
        ;[r.w, r.vw] = springStep(r.w, r.vw, gw, h, RING_K, RING_DAMPING)
        ;[r.h, r.vh] = springStep(r.h, r.vh, gh, h, RING_K, RING_DAMPING)
      }
    }
    if (ring) {
      ring.style.transform = `translate3d(${r.x.toFixed(2)}px, ${r.y.toFixed(2)}px, 0)`
      ring.style.width = `${Math.max(0, r.w).toFixed(2)}px`
      ring.style.height = `${Math.max(0, r.h).toFixed(2)}px`
      ring.style.borderRadius = `${r.radius}px`
      ring.dataset.shown = 'true'
    }

    if (arrivedFor !== goal.id) {
      const cursorDone = Math.hypot(c.x - tx, c.y - ty) < 1.2 && Math.hypot(c.vx, c.vy) < 14
      const ringDone = Math.abs(r.x - gx) < 1.5 && Math.abs(r.y - gy) < 1.5 && Math.abs(r.w - gw) < 2 && Math.abs(r.h - gh) < 2
      if (reduced || (cursorDone && ringDone)) {
        arrivedFor = goal.id
        reportTourArrived(goal.id)
      }
    }
  }

  onMount(() => { frame = requestAnimationFrame(tick) })
  onCleanup(() => { cancelAnimationFrame(frame); clearTimeout(press) })

  createEffect(on(tourClickTick, count => {
    if (!count) return
    const reduced = motion.matches
    if (!reduced) {
      const id = ++rippleId
      setRipples(list => [...list, { id, x: c.x, y: c.y }])
      setTimeout(() => setRipples(list => list.filter(item => item.id !== id)), 720)
      if (cursor) {
        cursor.dataset.press = 'true'
        clearTimeout(press)
        press = setTimeout(() => { if (cursor) cursor.dataset.press = 'false' }, 170)
      }
    }
    if (ring) {
      ring.dataset.flash = 'true'
      setTimeout(() => { if (ring) ring.dataset.flash = 'false' }, 420)
    }
  }, { defer: true }))

  return <>
    <div ref={ring} class="tour-ring" data-shown="false" aria-hidden="true"/>
    <For each={ripples()}>{item => <span class="tour-ripple" aria-hidden="true" style={{ left: `${item.x}px`, top: `${item.y}px` }}/>}</For>
    <div ref={cursor} class="tour-cursor" data-shown="false" data-press="false" aria-hidden="true">
      <svg class="tour-cursor__arrow" width="22" height="28" viewBox="0 0 22 28" fill="none">
        <path d="M3.2 2.4 3.2 21.6 7.7 17.5 10.7 24.6 14.2 23.1 11.2 16.2 17.3 16.2Z" fill="#000" stroke="#fff" stroke-width="1.7" stroke-linejoin="round" paint-order="stroke"/>
      </svg>
    </div>
  </>
}
