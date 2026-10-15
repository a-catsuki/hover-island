export interface PlacementPointerPoint { x: number; y: number }

export const ISLAND_PLACEMENT_DRAG_THRESHOLD = 5

/** Keep compact-surface clicks and secondary pointers distinct from a move. */
export function canStartIslandPlacementDrag(input: {
  button: number
  isPrimary: boolean
  insideDraggableSurface: boolean
  onInteractiveControl: boolean
}): boolean {
  return input.button === 0 && input.isPrimary && input.insideDraggableSurface && !input.onInteractiveControl
}

/** Measure in CSS pixels; the native command takes over only after a deliberate move. */
export function crossedIslandPlacementThreshold(
  start: PlacementPointerPoint,
  current: PlacementPointerPoint,
  threshold = ISLAND_PLACEMENT_DRAG_THRESHOLD,
): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= Math.max(0, threshold)
}
