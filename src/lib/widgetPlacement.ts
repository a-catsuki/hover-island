import type { WidgetConfig } from './ipc'
import { widgetPages, widgetResolvedSize } from './widgetPages'
import type { WidgetResolvedSize } from './widgetPages'
import { SHAPE_AREA, SHAPE_SHRINK, widgetShapeLocked } from './widgetShapes'

export interface GridCell {
  row: number
  column: number
}

export function widgetCanResize(widget: WidgetConfig): boolean {
  return !['nearby', 'controls', 'calendar'].includes(widget.kind) && !widgetShapeLocked(widget.kind)
}

/** Where a tile of this size may start: wide and large tiles always start in column 1, tall ones keep the chosen column on row 1. */
function cellForSize(size: WidgetResolvedSize, cell: GridCell): GridCell {
  const clamp = (value: number) => Math.min(2, Math.max(1, Math.trunc(value)))
  return {
    row: size === 'full' || size === 'tall' ? 1 : clamp(cell.row),
    column: size === 'compact' || size === 'tall' ? clamp(cell.column) : 1,
  }
}

/** A drop owns its rectangle first. Other tiles flow around it and may become
 * smaller when that lets the complete destination fit on one page. No tile is
 * removed when even the minimum legal sizes need another page. */
export function reflowWidgetDrop(
  widgets: WidgetConfig[], id: string, panel: string, cell: GridCell,
  requestedSize?: WidgetResolvedSize,
): WidgetConfig[] {
  const source = widgets.find(widget => widget.id === id)
  if (!source) return widgets
  const members = widgets.filter(widget => widget.enabled && widget.kind !== 'airdrop' && widget.panel === panel && widget.id !== id)
    .sort((a, b) => a.order - b.order).map(widget => ({ ...widget, size: widgetResolvedSize(widget) }))
  const size = widgetCanResize(source) ? requestedSize ?? widgetResolvedSize(source) : 'full'
  const moved: WidgetConfig = { ...source, panel, size, slot: cellForSize(size, cell) }
  const destination = [moved, ...members]
  // Shrink the largest flexible sibling first, preserving the dropped size
  // until the siblings have reached their own minimums.
  while (widgetPages(destination, 2).length > 1) {
    const candidate = [...destination.slice(1)].filter(widget => widgetCanResize(widget) && widgetResolvedSize(widget) !== 'compact')
      .sort((a, b) => SHAPE_AREA[widgetResolvedSize(b)] - SHAPE_AREA[widgetResolvedSize(a)])[0]
    if (candidate) {
      candidate.size = SHAPE_SHRINK[widgetResolvedSize(candidate)] ?? 'compact'
      candidate.slot = undefined
      continue
    }
    // An ordinary drag may fit the moved tile too, after every flexible
    // sibling reached its minimum. A size-selector request remains explicit.
    if (requestedSize !== undefined || !widgetCanResize(moved) || widgetResolvedSize(moved) === 'compact') break
    const fittedSize = SHAPE_SHRINK[widgetResolvedSize(moved)] ?? 'compact'
    moved.size = fittedSize
    moved.slot = cellForSize(fittedSize, cell)
  }
  // Clear any invalid old pinned cells and save exactly the placement shown.
  for (const page of widgetPages(destination, 2)) for (const slot of page) {
    slot.widget.slot = { row: slot.row, column: slot.column }
  }
  const updated = new Map(destination.map(widget => [widget.id, widget]))
  const ordered = [...widgets].sort((a, b) => a.order - b.order).filter(widget => widget.id !== id)
  const first = ordered.findIndex(widget => widget.panel === panel)
  ordered.splice(first < 0 ? ordered.length : first, 0, moved)
  return ordered.map((widget, order) => ({ ...(updated.get(widget.id) ?? widget), order }))
}

/** Move a widget to `panel` and pin it to the cell the user dropped it on. */
export function placeWidgetAtCell(widgets: WidgetConfig[], id: string, panel: string, cell: GridCell): WidgetConfig[] {
  const row = Math.min(2, Math.max(1, Math.trunc(cell.row)))
  const column = Math.min(2, Math.max(1, Math.trunc(cell.column)))
  // A tall tile always starts on the first row; the other shapes keep the exact cell.
  return widgets.map(widget => widget.id === id ? { ...widget, panel, slot: { row: widgetResolvedSize(widget) === 'tall' ? 1 : row, column } } : widget)
}

/** Forget a widget's pinned cell so it flows again from its order. */
export function clearWidgetSlot(widgets: WidgetConfig[], id: string): WidgetConfig[] {
  return widgets.map(widget => widget.id === id ? { ...widget, slot: undefined } : widget)
}

/**
 * When a widget is dropped onto another widget of the same panel and both take
 * the same amount of room, the two trade places so the dropped widget lands
 * exactly where the pointer was released. Widgets the user never sized or
 * placed keep the legacy full-column look, so for that pair the flow order
 * trades instead of the cells. Returns null when the pair cannot swap and the
 * caller should fall back to inserting before the target.
 */
export function swapWidgetCells(members: WidgetConfig[], sourceId: string, targetId: string): WidgetConfig[] | null {
  if (sourceId === targetId) return null
  const source = members.find(widget => widget.id === sourceId)
  const target = members.find(widget => widget.id === targetId)
  if (!source || !target || widgetResolvedSize(source) !== widgetResolvedSize(target)) return null
  if (source.size == null && source.slot == null && target.size == null && target.slot == null) {
    return members.map(widget =>
      widget.id === sourceId ? { ...widget, order: target.order }
        : widget.id === targetId ? { ...widget, order: source.order }
          : widget)
  }
  let sourceCell: GridCell | null = null
  let targetCell: GridCell | null = null
  for (const page of widgetPages(members, 2)) {
    for (const slot of page) {
      if (slot.widget.id === sourceId) sourceCell = { row: slot.row, column: slot.column }
      if (slot.widget.id === targetId) targetCell = { row: slot.row, column: slot.column }
    }
  }
  if (!sourceCell || !targetCell) return null
  const from: GridCell = sourceCell
  const to: GridCell = targetCell
  return members.map(widget =>
    widget.id === sourceId ? { ...widget, slot: to }
      : widget.id === targetId ? { ...widget, slot: from }
        : widget)
}

/** The first cell of a panel's top page that has no widget on it. */
export function firstFreeCell(members: WidgetConfig[]): GridCell {
  const occupied = new Set<string>()
  for (const slot of (widgetPages(members, 2)[0] ?? [])) {
    for (let row = slot.row; row < slot.row + slot.rows; row++) {
      for (let column = slot.column; column < slot.column + slot.columns; column++) {
        occupied.add(`${row}:${column}`)
      }
    }
  }
  for (let row = 1; row <= 2; row++) {
    for (let column = 1; column <= 2; column++) {
      if (!occupied.has(`${row}:${column}`)) return { row, column }
    }
  }
  return { row: 1, column: 1 }
}
