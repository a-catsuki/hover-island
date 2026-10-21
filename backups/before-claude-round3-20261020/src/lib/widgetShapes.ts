import type { WidgetConfig, WidgetKind } from './ipc'

/**
 * A widget shape is the rectangle it takes on the notch's 2x2 widget grid.
 * It is stored in the widget's existing `size` field, so older settings keep
 * working: compact, wide and full were already valid values.
 */
export type WidgetShape = NonNullable<WidgetConfig['size']>

export interface WidgetShapeOption {
  id: WidgetShape
  label: string
  detail: string
}

export { SHAPE_SPAN } from './widgetPages'

/** Rough area, used to decide which sibling to shrink first. */
export const SHAPE_AREA: Record<WidgetShape, number> = { compact: 1, wide: 2, tall: 2, full: 4 }

/** The next smaller shape, used when a drop needs room. */
export const SHAPE_SHRINK: Partial<Record<WidgetShape, WidgetShape>> = { full: 'wide', wide: 'compact', tall: 'compact' }

export const SHAPE_ORDER: WidgetShape[] = ['compact', 'wide', 'tall', 'full']

const COMPACT: WidgetShapeOption = { id: 'compact', label: 'Compact', detail: 'One tile' }
const WIDE: WidgetShapeOption = { id: 'wide', label: 'Wide', detail: 'Two tiles across' }
const TALL: WidgetShapeOption = { id: 'tall', label: 'Tall', detail: 'One tile wide, two high' }
const FULL: WidgetShapeOption = { id: 'full', label: 'Large', detail: 'The whole page' }

const ALL = [COMPACT, WIDE, TALL, FULL]

/**
 * Which shapes each widget looks good in, first entry is the smallest. Every
 * widget lays itself out from the size of its tile (container queries), so each
 * listed shape has a layout made for it. Widgets that need the whole page only
 * list `full`.
 */
export const WIDGET_SHAPES: Record<WidgetKind, WidgetShapeOption[]> = {
  media: ALL,
  weather: ALL,
  clock: ALL,
  notes: ALL,
  focus: [COMPACT, WIDE, TALL],
  system: ALL,
  ai: ALL,
  network: ALL,
  bluetooth: [COMPACT, WIDE, TALL],
  usage: [WIDE, TALL, FULL],
  notifications: ALL,
  dock: ALL,
  'reset-watch': [COMPACT, WIDE, TALL],
  'web-alerts': [WIDE, TALL, FULL],
  calendar: [FULL],
  nearby: [FULL],
  controls: [FULL],
  airdrop: [COMPACT],
}

/** Shapes the picker offers for a widget, keeping a saved shape selectable even if it is no longer recommended. */
export function widgetShapeOptions(kind: WidgetKind, current?: WidgetShape): WidgetShapeOption[] {
  const list = WIDGET_SHAPES[kind] ?? ALL
  if (!current || list.some(option => option.id === current)) return list
  const extra = ALL.find(option => option.id === current)
  return extra ? [...list, extra].sort((a, b) => SHAPE_ORDER.indexOf(a.id) - SHAPE_ORDER.indexOf(b.id)) : list
}

/** True when the widget may be resized at all. */
export function widgetShapeLocked(kind: WidgetKind): boolean {
  return (WIDGET_SHAPES[kind] ?? ALL).length <= 1
}

/** The shape a widget gets when it is first added. */
export function defaultWidgetShape(kind: WidgetKind): WidgetShape {
  switch (kind) {
    case 'nearby': case 'controls': case 'calendar': case 'usage': case 'web-alerts': return 'full'
    case 'clock': return 'full'
    case 'dock': return 'wide'
    default: return 'compact'
  }
}
