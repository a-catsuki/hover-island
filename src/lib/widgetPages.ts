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
      page[page.length - 1].columns = width
      cursor++
    }
  }
  const flush = () => {
    finishRow()
    // A single occupied row fills the page, giving each tool room to breathe.
    if (cursor <= width) for (const slot of page) slot.rows = 2
    if (page.length) pages.push(page)
    page = []; cursor = 0
  }
  for (const widget of widgets) {
    if (!widget.enabled || widget.kind === 'airdrop') continue
    const full = ['nearby', 'controls', 'usage', 'web-alerts', 'clock', 'calendar'].includes(widget.kind)
    const span = full || ['calendar', 'dock'].includes(widget.kind) ? width : 1
    const rows = full ? 2 : 1
    if (full && page.length) flush()
    if (span === width && cursor % width) finishRow()
    if (cursor + span * rows > width * 2) flush()
    page.push({ widget, column: cursor % width + 1, row: Math.floor(cursor / width) + 1, columns: span, rows })
    cursor += span * rows
    if (cursor === width * 2) flush()
  }
  flush()
  return pages.length ? pages : [[]]
}
