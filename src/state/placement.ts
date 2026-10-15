import { createSignal } from 'solid-js'
import { browserPreview, cmd } from '../lib/ipc'
import { reportError } from './feedback'
import { flushSettings, patchSettings } from './settings'

type ActiveDrag = {
  pointerId: number
  target: HTMLElement
  ready: Promise<void>
}

const [placementDragging, setPlacementDragging] = createSignal(false)
let active: ActiveDrag | undefined
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

export function beginIslandPlacementDrag(event: PointerEvent): boolean {
  if (browserPreview || active || event.button !== 0) return false
  const target = event.currentTarget
  if (!(target instanceof HTMLElement)) return false
  event.preventDefault()
  target.setPointerCapture(event.pointerId)
  setPlacementDragging(true)
  moveFailure = undefined
  const drag: ActiveDrag = {
    pointerId: event.pointerId,
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
      try { target.releasePointerCapture(event.pointerId) } catch { /* Capture may already be gone. */ }
    }
  })
  return true
}

export function moveIslandPlacementDrag(event: PointerEvent): void {
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
  const drag = active
  if (!drag || drag.pointerId !== event.pointerId) return false
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
  const drag = active
  if (!drag || drag.pointerId !== pointerId) return
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
