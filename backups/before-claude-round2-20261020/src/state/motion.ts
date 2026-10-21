export interface SpringState {
  value: number
  velocity: number
}

export interface SpringFrame {
  width: number
  height: number
  radius: number
}

export interface MagneticOffset {
  x: number
  y: number
}

export function clampMagneticOffset(offset: MagneticOffset): MagneticOffset {
  const clamp = (value: number) => Number.isFinite(value) ? Math.max(-6, Math.min(6, value)) : 0
  return { x: clamp(offset.x), y: clamp(offset.y) }
}

export function stepMagneticOffset(
  state: { x: SpringState; y: SpringState },
  target: MagneticOffset,
  deltaSeconds: number,
  reducedMotion = false,
) {
  const bounded = clampMagneticOffset(target)
  if (reducedMotion) return { x: { value: 0, velocity: 0 }, y: { value: 0, velocity: 0 } }
  return {
    x: stepSpring(state.x, bounded.x, deltaSeconds, 300, 0.78),
    y: stepSpring(state.y, bounded.y, deltaSeconds, 300, 0.78),
  }
}

export function createMagneticSpring(onFrame: (offset: MagneticOffset) => void, reducedMotion: () => boolean) {
  let current = { x: { value: 0, velocity: 0 }, y: { value: 0, velocity: 0 } }
  let target: MagneticOffset = { x: 0, y: 0 }
  let raf: number | undefined
  let lastTime: number | undefined
  let disposed = false
  const publish = () => onFrame({ x: current.x.value, y: current.y.value })
  const settled = () => Math.abs(target.x - current.x.value) < 0.08 && Math.abs(target.y - current.y.value) < 0.08
    && Math.abs(current.x.velocity) < 0.8 && Math.abs(current.y.velocity) < 0.8
  const frame = (time: number) => {
    raf = undefined
    if (disposed) return
    if (reducedMotion()) {
      current = stepMagneticOffset(current, { x: 0, y: 0 }, 0, true)
      publish()
      lastTime = time
      return
    }
    const dt = lastTime === undefined ? 1 / 60 : (time - lastTime) / 1000
    lastTime = time
    current = stepMagneticOffset(current, target, dt)
    publish()
    if (!settled()) raf = requestAnimationFrame(frame)
  }
  const schedule = () => {
    if (disposed || raf !== undefined) return
    if (reducedMotion()) {
      current = stepMagneticOffset(current, { x: 0, y: 0 }, 0, true)
      target = { x: 0, y: 0 }
      publish()
      return
    }
    lastTime = undefined
    raf = requestAnimationFrame(frame)
  }
  return {
    impulse(offset: MagneticOffset) {
      if (disposed || reducedMotion()) return
      const bounded = clampMagneticOffset(offset)
      current.x.velocity += bounded.x * 12
      current.y.velocity += bounded.y * 12
      schedule()
    },
    retarget(next: MagneticOffset) {
      if (disposed) return
      target = clampMagneticOffset(next)
      if (reducedMotion()) target = { x: 0, y: 0 }
      schedule()
    },
    snap(next: MagneticOffset = { x: 0, y: 0 }) {
      if (disposed) return
      target = reducedMotion() ? { x: 0, y: 0 } : clampMagneticOffset(next)
      current = { x: { value: target.x, velocity: 0 }, y: { value: target.y, velocity: 0 } }
      if (raf !== undefined) cancelAnimationFrame(raf)
      raf = undefined
      publish()
    },
    dispose() {
      disposed = true
      if (raf !== undefined) cancelAnimationFrame(raf)
      raf = undefined
    },
  }
}

export function stepSpring(
  state: SpringState,
  target: number,
  deltaSeconds: number,
  stiffness = 390,
  dampingRatio = 0.8,
): SpringState {
  let value = state.value
  let velocity = state.velocity
  const total = Math.max(0, Math.min(0.05, Number.isFinite(deltaSeconds) ? deltaSeconds : 0))
  const steps = Math.max(1, Math.ceil(total * 120))
  const dt = total / steps
  const damping = 2 * dampingRatio * Math.sqrt(stiffness)

  for (let index = 0; index < steps; index++) {
    const acceleration = (target - value) * stiffness - damping * velocity
    velocity += acceleration * dt
    value += velocity * dt
  }

  if (Math.abs(target - value) < 0.08 && Math.abs(velocity) < 0.8) {
    return { value: target, velocity: 0 }
  }
  return { value, velocity }
}

/** Apple-style spring: perceived duration (response, seconds) and damping fraction. */
export function springStiffness(responseSeconds: number): number {
  return Math.pow((2 * Math.PI) / responseSeconds, 2)
}

/** Opening feels alive (about 2% overshoot); closing settles a little firmer. */
export const ISLAND_SPRING = {
  open: { stiffness: springStiffness(0.42), damping: 0.78 },
  close: { stiffness: springStiffness(0.34), damping: 0.9 },
} as const

export function createIslandSpring(
  initial: SpringFrame,
  onFrame: (frame: SpringFrame) => void,
  reducedMotion: () => boolean,
) {
  let current = { ...initial }
  let velocity: SpringFrame = { width: 0, height: 0, radius: 0 }
  let target = { ...initial }
  let feel: { stiffness: number; damping: number } = ISLAND_SPRING.open
  let raf: number | undefined
  let lastTime: number | undefined
  let disposed = false

  const publish = () => onFrame({ ...current })
  const settled = () =>
    Math.abs(target.width - current.width) < 0.08 &&
    Math.abs(target.height - current.height) < 0.08 &&
    Math.abs(target.radius - current.radius) < 0.08 &&
    Math.abs(velocity.width) < 0.8 &&
    Math.abs(velocity.height) < 0.8 &&
    Math.abs(velocity.radius) < 0.8

  const frame = (time: number) => {
    raf = undefined
    if (disposed) return
    if (reducedMotion()) {
      current = { ...target }
      velocity = { width: 0, height: 0, radius: 0 }
      publish()
      lastTime = time
      return
    }
    const delta = lastTime === undefined ? 1 / 60 : (time - lastTime) / 1000
    lastTime = time
    const width = stepSpring({ value: current.width, velocity: velocity.width }, target.width, delta, feel.stiffness, feel.damping)
    const height = stepSpring({ value: current.height, velocity: velocity.height }, target.height, delta, feel.stiffness, feel.damping)
    const radius = stepSpring({ value: current.radius, velocity: velocity.radius }, target.radius, delta, feel.stiffness, feel.damping)
    current = { width: width.value, height: height.value, radius: radius.value }
    velocity = { width: width.velocity, height: height.velocity, radius: radius.velocity }
    publish()
    if (!settled()) raf = requestAnimationFrame(frame)
  }

  const schedule = () => {
    if (disposed || raf !== undefined) return
    if (reducedMotion()) {
      current = { ...target }
      velocity = { width: 0, height: 0, radius: 0 }
      publish()
      return
    }
    lastTime = undefined
    raf = requestAnimationFrame(frame)
  }

  return {
    retarget(next: SpringFrame) {
      if (disposed) return
      // Growing uses the livelier spring, shrinking the firmer one.
      // A pure width change (size customization) must never overshoot.
      feel = next.height === current.height
        ? { stiffness: ISLAND_SPRING.open.stiffness, damping: 1 }
        : next.width * next.height >= current.width * current.height ? ISLAND_SPRING.open : ISLAND_SPRING.close
      target = { ...next }
      schedule()
    },
    snap(next: SpringFrame) {
      if (disposed) return
      target = { ...next }
      current = { ...next }
      velocity = { width: 0, height: 0, radius: 0 }
      if (raf !== undefined) cancelAnimationFrame(raf)
      raf = undefined
      publish()
    },
    dispose() {
      disposed = true
      if (raf !== undefined) cancelAnimationFrame(raf)
      raf = undefined
    },
  }
}
