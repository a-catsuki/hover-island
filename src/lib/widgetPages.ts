import type { WidgetConfig } from './ipc'

export interface WidgetSlot {
  widget: WidgetConfig
  column: number
  row: number
  columns: number
  rows: number
}

/** Two rows per page preserve readable controls rather than shrinking forever. */
export function widgetPages(widgets: WidgetConfig[], columns = 2): WidgetSlot[][] {
  const width = columns === 1 ? 1 : 2
  const pages: WidgetSlot[][] = []
  let page: WidgetSlot[] = [], cursor = 0
  const finishRow = () => {
    if (width === 2 && cursor % width && page.length) {
      if (page.every((slot) => slot.widget.size == null)) page[page.length - 1].columns = width
      cursor++
    }
  }
  const flush = () => {
    finishRow()
    // Preserve the established full-row look for saved, unsized layouts. Any
    // explicit size opts into the new geometry, including Compact.
    if (cursor <= width && page.length > 0 && page.every((slot) => slot.widget.size == null)) {
      for (const slot of page) slot.rows = 2
    }
    if (page.length) pages.push(page)
    page = []; cursor = 0
  }
  for (const widget of widgets) {
    if (!widget.enabled || widget.kind === 'airdrop') continue
    const minimumFull = ['nearby', 'controls', 'calendar'].includes(widget.kind)
    // An unset size keeps the established layout for saved configurations.
    const inferred = minimumFull || ['usage', 'web-alerts', 'clock'].includes(widget.kind)
      ? 'full'
      : widget.kind === 'dock' ? 'wide' : 'compact'
    const size = minimumFull ? 'full' : widget.size ?? inferred
    const span = size === 'compact' ? 1 : width
    const rows = size === 'full' ? 2 : 1
    if (rows === 2 && page.length) flush()
    if (span === width && cursor % width) finishRow()
    if (cursor + span * rows > width * 2) flush()
    page.push({ widget, column: cursor % width + 1, row: Math.floor(cursor / width) + 1, columns: span, rows })
    cursor += span * rows
    if (cursor === width * 2) flush()
  }
  flush()
  return pages.length ? pages : [[]]
}
