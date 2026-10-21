import type { WidgetConfig } from './ipc'

export interface WidgetSlot {
  widget: WidgetConfig
  column: number
  row: number
  columns: number
  rows: number
}

export type WidgetResolvedSize = 'compact' | 'wide' | 'tall' | 'full'

/** Columns and rows each shape covers on a two-column page (kept here so this file has no imports to resolve). */
export const SHAPE_SPAN: Record<WidgetResolvedSize, readonly [columns: number, rows: number]> = {
  compact: [1, 1],
  wide: [2, 1],
  tall: [1, 2],
  full: [2, 2],
}

/** The size a widget occupies once kind minimums and the user's choice are applied. */
export function widgetResolvedSize(widget: WidgetConfig): WidgetResolvedSize {
  if (['nearby', 'controls', 'calendar'].includes(widget.kind)) return 'full'
  const inferred = ['usage', 'web-alerts', 'clock'].includes(widget.kind)
    ? 'full'
    : widget.kind === 'dock' ? 'wide' : 'compact'
  return (widget.size ?? inferred) as WidgetResolvedSize
}

/** The 0-based grid cell a widget asks for, or null when it should flow. */
function explicitCell(widget: WidgetConfig) {
  const slot = widget.slot
  if (!slot || !Number.isInteger(slot.row) || !Number.isInteger(slot.column)) return null
  return { row: slot.row - 1, column: slot.column - 1 }
}

/**
 * Pack widgets into the first free rectangle so later compact tiles can fill holes left by wide ones.
 * A widget the user dropped onto a specific cell keeps that cell as long as it still fits.
 */
export function widgetPages(widgets: WidgetConfig[], columns = 2): WidgetSlot[][] {
  const width = columns === 1 ? 1 : 2
  const height = 2
  const pages: WidgetSlot[][] = []
  let page: WidgetSlot[] = []
  let occupied = Array.from({ length: height }, () => Array<boolean>(width).fill(false))

  const resetPage = () => {
    page = []
    occupied = Array.from({ length: height }, () => Array<boolean>(width).fill(false))
  }
  const isFree = (row: number, column: number, spanX: number, spanY: number) => {
    if (row < 0 || column < 0 || row + spanY > height || column + spanX > width) return false
    for (let y = row; y < row + spanY; y++) {
      for (let x = column; x < column + spanX; x++) {
        if (occupied[y][x]) return false
      }
    }
    return true
  }
  const emptyCell = (spanX: number, spanY: number) => {
    for (let row = 0; row <= height - spanY; row++) {
      for (let column = 0; column <= width - spanX; column++) {
        if (isFree(row, column, spanX, spanY)) return { row, column }
      }
    }
    return null
  }
  const targetCell = (widget: WidgetConfig, spanX: number, spanY: number) => {
    const requested = explicitCell(widget)
    if (requested && isFree(requested.row, requested.column, spanX, spanY)) return requested
    return emptyCell(spanX, spanY)
  }
  const finishPage = () => {
    if (!page.length) return
    // Unspecified legacy layouts historically filled their first row vertically.
    // Keep that saved appearance; explicit sizes and dropped cells use exact placement.
    if (page.every(slot => slot.widget.size == null && !slot.widget.slot) && page.every(slot => slot.row === 1)) {
      for (const slot of page) slot.rows = height
      if (page.length === 1) page[0].columns = width
    }
    pages.push(page)
    resetPage()
  }

  for (const widget of widgets) {
    if (!widget.enabled || widget.kind === 'airdrop') continue
    const size = widgetResolvedSize(widget)
    const [shapeX, shapeY] = SHAPE_SPAN[size] ?? SHAPE_SPAN.compact
    const spanX = Math.min(width, shapeX)
    const spanY = Math.min(height, shapeY)

    let target = targetCell(widget, spanX, spanY)
    if (!target && page.length) {
      finishPage()
      target = targetCell(widget, spanX, spanY)
    }
    if (!target) continue

    page.push({ widget, column: target.column + 1, row: target.row + 1, columns: spanX, rows: spanY })
    for (let row = target.row; row < target.row + spanY; row++) {
      for (let column = target.column; column < target.column + spanX; column++) occupied[row][column] = true
    }
    if (occupied.every(row => row.every(Boolean))) finishPage()
  }
  finishPage()
  return pages.length ? pages : [[]]
}
