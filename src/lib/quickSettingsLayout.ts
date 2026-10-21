/** Pure layout maths for the Quick settings view. Everything is derived from the box the view is given, so nothing can scroll or overflow. */

export type QuickLayoutForce = 'auto' | 'wide' | 'tall' | 'compact'
export interface QuickLayout {
  /** `side`: tiles left, vertical sliders right. `below`: tiles on top, vertical sliders underneath. */
  mode: 'side' | 'below'
  cols: number
  rows: number
  /** Circle diameter in px. */
  disc: number
  /** Whether the 11px caption under each circle fits. */
  captions: boolean
  gap: number
  /** Slider column width (side) or slider row height (below), in px. */
  slider: number
}

export const MAX_DISC = 52
const MIN_DISC = 34
const CAPTION = 15

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

interface Grid { cols: number; rows: number; disc: number; captions: boolean; score: number }

/** Picks the column count that gives the biggest circles for `count` tiles in an `aw` x `ah` area. */
export function bestGrid(count: number, aw: number, ah: number, gap: number, allowCaptions = true): Grid {
  let best: Grid | undefined
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols)
    const cellW = (aw - gap * (cols - 1)) / cols
    const cellH = (ah - gap * (rows - 1)) / rows
    const withCaption = Math.min(MAX_DISC, cellW - 2, cellH - CAPTION)
    const without = Math.min(MAX_DISC, cellW - 2, cellH - 2)
    const captions = allowCaptions && withCaption >= 40
    const disc = Math.max(0, Math.floor(captions ? withCaption : without))
    // Bigger circles first, then rounder cells, then a small bonus for keeping captions.
    const score = disc * 1000 + Math.min(cellW, cellH) + (captions ? 300 : 0)
    if (!best || score > best.score) best = { cols, rows, disc, captions, score }
  }
  return best ?? { cols: 1, rows: 1, disc: 0, captions: false, score: 0 }
}

export function quickLayout(width: number, height: number, tileCount: number, force: QuickLayoutForce = 'auto'): QuickLayout {
  const w = Math.max(0, width)
  const h = Math.max(0, height)
  const gap = w < 340 || h < 280 ? 8 : 10
  const allowCaptions = force !== 'compact'

  const sideSlider = Math.round(clamp(w * 0.14, 52, 84))
  const side = (() => {
    const aw = w - (sideSlider * 2 + gap) - gap
    return { mode: 'side' as const, slider: sideSlider, grid: bestGrid(tileCount, aw, h, gap, allowCaptions) }
  })()

  const belowSlider = Math.round(clamp(h * 0.38, 92, 190))
  const below = (() => {
    const ah = h - belowSlider - gap
    return { mode: 'below' as const, slider: belowSlider, grid: bestGrid(tileCount, w, ah, gap, allowCaptions) }
  })()

  const pick = force === 'wide' ? side : force === 'tall' ? below
    : // Vertical sliders need at least ~92px of height below the tiles to feel like sliders.
      h < 92 + gap + MIN_DISC ? side
        : side.grid.score >= below.grid.score ? side : below
  return { mode: pick.mode, cols: pick.grid.cols, rows: pick.grid.rows, disc: pick.grid.disc, captions: pick.grid.captions, gap, slider: pick.slider }
}

/** How many whole rows of `rowHeight` fit in `available` px (with `gap` between rows). */
export function rowsThatFit(available: number, rowHeight: number, gap = 6): number {
  if (available <= 0) return 0
  return Math.max(0, Math.floor((available + gap) / (rowHeight + gap)))
}

export const clampPercent = (value: number) => Math.round(clamp(value, 0, 100))
