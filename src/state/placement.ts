import { createSignal } from 'solid-js'
import { browserPreview, cmd } from '../lib/ipc'
import { reportError } from './feedback'
import { flushSettings, patchSettings } from './settings'
import { crossedIslandPlacementThreshold, type PlacementPointerPoint } from '../lib/placementPointerDrag'

type ActiveDrag = {
  pointerId: number
  target: HTMLElement
  ready: Promise<void>
}
type PendingDrag = {
  pointerId: number
  target: HTMLElement
  start: PlacementPointerPoint
}

const [placementDragging, setPlacementDragging] = createSignal(false)
const [placementGesturePending, setPlacementGesturePending] = createSignal(false)
let active: ActiveDrag | undefined
let pending: PendingDrag | undefined
let suppressNextClick = false
let suppressClickTimer: ReturnType<typeof setTimeout> | undefined
let animationFrame: number | undefined
let movePending = false
let moveInFlight: Promise<void> | undefined
let moveFailure: unknown

function queueNativeMove(): void {
  movePending = true
  if (moveInFlight) return
  movePending = false
  moveInFlight = cmd.placementMove()
    .catch(error => {
      moveFailure = error
      reportError('Could not move Hover Island', error)
    })
    .finally(() => {
      moveInFlight = undefined
      if (movePending) queueNativeMove()
    })
}

async function drainNativeMoves(): Promise<void> {
  if (animationFrame !== undefined) {
    cancelAnimationFrame(animationFrame)
    animationFrame = undefined
    queueNativeMove()
  }
  while (moveInFlight || movePending) {
    if (movePending && !moveInFlight) queueNativeMove()
    if (moveInFlight) await moveInFlight
  }
  if (moveFailure) {
    const error = moveFailure
    moveFailure = undefined
    throw error
  }
}

export function isPlacementDragging(): boolean {
  return placementDragging()
}

export function isPlacementGesturePending(): boolean {
  return placementGesturePending()
}

export function beginIslandPlacementDrag(event: PointerEvent, captureTarget: HTMLElement): boolean {
  if (browserPreview || active || pending || event.button !== 0 || !event.isPrimary) return false
  try { captureTarget.setPointerCapture(event.pointerId) } catch { return false }
  pending = {
    pointerId: event.pointerId,
    target: captureTarget,
    start: { x: event.clientX, y: event.clientY },
  }
  setPlacementGesturePending(true)
  return true
}

function startNativePlacementDrag(pointerId: number, target: HTMLElement): ActiveDrag {
  setPlacementDragging(true)
  moveFailure = undefined
  const drag: ActiveDrag = {
    pointerId,
    target,
    ready: cmd.placementBeginDrag().catch(error => {
      reportError('Could not start moving Hover Island', error)
      throw error
    }),
  }
  active = drag
  void drag.ready.catch(() => {
    if (active === drag) {
      active = undefined
      setPlacementDragging(false)
      try { target.releasePointerCapture(pointerId) } catch { /* Capture may already be gone. */ }
    }
  })
  return drag
}

export function moveIslandPlacementDrag(event: PointerEvent): void {
  if (!active) {
    const wait = pending
    if (!wait || wait.pointerId !== event.pointerId || !crossedIslandPlacementThreshold(wait.start, { x: event.clientX, y: event.clientY })) return
    event.preventDefault()
    pending = undefined
    setPlacementGesturePending(false)
    startNativePlacementDrag(wait.pointerId, wait.target)
  }
  if (!active || active.pointerId !== event.pointerId) return
  event.preventDefault()
  if (animationFrame !== undefined) return
  animationFrame = requestAnimationFrame(() => {
    animationFrame = undefined
    const drag = active
    if (drag) {
      void drag.ready.then(() => {
        if (active === drag) queueNativeMove()
      }).catch(() => {})
    }
  })
}

export async function finishIslandPlacementDrag(event: PointerEvent): Promise<boolean> {
  const waiting = pending
  if (waiting?.pointerId === event.pointerId) {
    pending = undefined
    setPlacementGesturePending(false)
    try { waiting.target.releasePointerCapture(event.pointerId) } catch { /* Capture may already be gone. */ }
    return false
  }
  const drag = active
  if (!drag || drag.pointerId !== event.pointerId) return false
  suppressPlacementClick()
  event.preventDefault()
  try {
    await drag.ready
    if (animationFrame !== undefined) {
      cancelAnimationFrame(animationFrame)
      animationFrame = undefined
    }
    queueNativeMove()
    await drainNativeMoves()
    const placement = await cmd.placementSnap()
    patchSettings({ placement })
    await flushSettings()
    await cmd.applyGeometry()
    return true
  } catch (error) {
    reportError('Could not save Hover Island position', error)
    // Return to the last persisted anchor if saving or applying the new one failed.
    await cmd.applyGeometry().catch(restoreError => reportError('Could not restore Hover Island position', restoreError))
    return false
  } finally {
    await cmd.placementEndDrag().catch(error => reportError('Could not finish moving Hover Island', error))
    if (active === drag) active = undefined
    setPlacementDragging(false)
    try { drag.target.releasePointerCapture(drag.pointerId) } catch { /* Pointer capture may already be gone. */ }
  }
}

export async function cancelIslandPlacementDrag(pointerId: number): Promise<void> {
  const waiting = pending
  if (waiting?.pointerId === pointerId) {
    pending = undefined
    setPlacementGesturePending(false)
    try { waiting.target.releasePointerCapture(pointerId) } catch { /* Capture may already be gone. */ }
    return
  }
  const drag = active
  if (!drag || drag.pointerId !== pointerId) return
  suppressPlacementClick()
  if (animationFrame !== undefined) {
    cancelAnimationFrame(animationFrame)
    animationFrame = undefined
  }
  try { await drag.ready } catch { /* Start failure already reported. */ }
  await drainNativeMoves().catch(error => reportError('Could not stop moving Hover Island', error))
  await cmd.placementEndDrag().catch(error => reportError('Could not finish moving Hover Island', error))
  await cmd.applyGeometry().catch(error => reportError('Could not restore Hover Island position', error))
  if (active === drag) active = undefined
  setPlacementDragging(false)
  try { drag.target.releasePointerCapture(pointerId) } catch { /* Pointer capture may already be gone. */ }
}

function suppressPlacementClick(): void {
  suppressNextClick = true
  clearTimeout(suppressClickTimer)
  suppressClickTimer = setTimeout(() => { suppressNextClick = false }, 500)
}

/** Consume the synthetic click that browsers can emit after a completed drag. */
export function consumePlacementClick(): boolean {
  if (!suppressNextClick) return false
  suppressNextClick = false
  clearTimeout(suppressClickTimer)
  suppressClickTimer = undefined
  return true
}
