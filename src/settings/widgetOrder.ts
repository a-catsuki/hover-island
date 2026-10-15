import type { WidgetConfig } from '../lib/ipc'

export function moveWidget(widgets: WidgetConfig[], id: string, direction: number): WidgetConfig[] {
  const next = [...widgets].sort((a, b) => a.order - b.order)
  const index = next.findIndex((widget) => widget.id === id)
  const target = index + direction
  if (index < 0 || target < 0 || target >= next.length) return next
  ;[next[index], next[target]] = [next[target], next[index]]
  return next.map((widget, order) => ({ ...widget, order }))
}

export function moveWidgetBefore(widgets: WidgetConfig[], sourceId: string, targetId: string): WidgetConfig[] {
  const next = [...widgets].sort((a, b) => a.order - b.order)
  if (!sourceId || sourceId === targetId) return next
  const source = next.findIndex((widget) => widget.id === sourceId)
  const target = next.findIndex((widget) => widget.id === targetId)
  if (source < 0 || target < 0) return next
  const [item] = next.splice(source, 1)
  next.splice(source < target ? target - 1 : target, 0, item)
  return next.map((widget, order) => ({ ...widget, order }))
}

/**
 * Move a widget to directly after a target, or to the end of the list when the
 * target is null. Used for "drop onto a panel" and "drop after this card".
 */
export function moveWidgetAfter(widgets: WidgetConfig[], sourceId: string, targetId: string | null): WidgetConfig[] {
  const next = [...widgets].sort((a, b) => a.order - b.order)
  const source = next.findIndex((widget) => widget.id === sourceId)
  if (source < 0) return next
  const [item] = next.splice(source, 1)
  const target = targetId === null ? -1 : next.findIndex((widget) => widget.id === targetId)
  next.splice(target + 1 || next.length, 0, item)
  return next.map((widget, order) => ({ ...widget, order }))
}

/**
 * Swap a widget with its nearest sibling in `direction`, where siblings are the
 * widgets that share a panel. Keeps a single contiguous order across the list.
 */
export function moveWidgetWithin(
  widgets: WidgetConfig[],
  id: string,
  direction: number,
  samePanel: (a: WidgetConfig, b: WidgetConfig) => boolean,
): WidgetConfig[] {
  const next = [...widgets].sort((a, b) => a.order - b.order)
  const self = next.find((widget) => widget.id === id)
  if (!self || !direction) return next
  const siblings = next.filter((widget) => samePanel(widget, self))
  const index = siblings.findIndex((widget) => widget.id === id)
  const neighbour = siblings[index + (direction > 0 ? 1 : -1)]
  if (!neighbour) return next
  const from = next.findIndex((widget) => widget.id === id)
  const to = next.findIndex((widget) => widget.id === neighbour.id)
  ;[next[from], next[to]] = [next[to], next[from]]
  return next.map((widget, order) => ({ ...widget, order }))
}
