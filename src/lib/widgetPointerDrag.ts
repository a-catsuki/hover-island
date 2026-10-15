export interface PointerPoint { x: number; y: number }
export type WidgetPointerDropTarget = { kind: 'widget' | 'panel'; id: string } | null

/** Keep a normal click distinct from an intentional arranger drag. */
export function crossedWidgetDragThreshold(start: PointerPoint, current: PointerPoint, threshold = 5): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= Math.max(0, threshold)
}

/** Resolve only the explicit widget and panel targets exposed by the UI. */
export function widgetPointerDropTarget(widgetId: string | null, panelId: string | null, sourceId: string): WidgetPointerDropTarget {
  if (widgetId && widgetId !== sourceId) return { kind: 'widget', id: widgetId }
  if (panelId) return { kind: 'panel', id: panelId }
  return null
}

/** A target is inert until the pointer crossed the movement threshold. */
export function widgetPointerReleaseTarget(started: boolean, target: WidgetPointerDropTarget): WidgetPointerDropTarget {
  return started ? target : null
}
