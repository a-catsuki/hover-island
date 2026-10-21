// Pure data and geometry for the first-run tour. No imports on purpose: the
// unit tests load this file on its own.

export type TourStepId = 'pill' | 'open' | 'pages' | 'media' | 'widgets' | 'quick' | 'beam' | 'search' | 'settings' | 'done'

export interface TourStepSpec {
  id: TourStepId
  title: string
  /** `{open}` and `{search}` are replaced with the shortcuts from Settings. */
  body: string
  /** The island state this step needs before its cursor script runs. */
  needs: 'collapsed' | 'expanded'
  /** Selectors tried in order. `tab:N` is the Nth panel tab. */
  target: string[]
  /** Where on the target the cursor tip rests, 0..1. */
  anchor: [number, number]
  /** Shown only when one of these widget kinds is enabled; the first match picks the panel. */
  widgetKinds?: string[]
  /** Shown only when there is more than one panel tab. */
  needsTabs?: boolean
  /** Caption sits in the middle of the island and the cursor rests. */
  center?: boolean
  /** Show the shortcut keycaps under the text. */
  shortcuts?: Array<{ label: string; key: 'open' | 'search' }>
}

export const TOUR_STEPS: readonly TourStepSpec[] = [
  {
    id: 'pill',
    title: 'Meet your island',
    body: 'A small pill at the edge of your screen. It stays quiet until you want it.',
    needs: 'collapsed',
    target: ['.island__bar'],
    anchor: [0.5, 0.5],
    shortcuts: [{ label: 'Open', key: 'open' }, { label: 'Search', key: 'search' }],
  },
  {
    id: 'open',
    title: 'Click to open',
    body: 'Hover it, click it or press {open}. Move away and it tucks itself back in.',
    needs: 'collapsed',
    target: ['.island__bar'],
    anchor: [0.5, 0.5],
  },
  {
    id: 'pages',
    title: 'Switch pages',
    body: 'Widgets live on pages. Click a tab, or drag the tabs to reorder them.',
    needs: 'expanded',
    target: ['tab:1', '.panel-tabs'],
    anchor: [0.5, 0.5],
    needsTabs: true,
  },
  {
    id: 'media',
    title: 'Now playing',
    body: 'Music from any app shows up here, with controls, lyrics and a live visualizer.',
    needs: 'expanded',
    target: ['[data-widget-kind="media"]'],
    anchor: [0.5, 0.3],
    widgetKinds: ['media'],
  },
  {
    id: 'widgets',
    title: 'Your widgets',
    body: 'Weather, calendar, notes and more. Rearrange them from the more menu, or pick them in Settings.',
    needs: 'expanded',
    target: ['.panel-more__trigger'],
    anchor: [0.5, 0.5],
    widgetKinds: ['weather', 'calendar', 'notes', 'system', 'focus', 'clock', 'ai', 'dock'],
  },
  {
    id: 'quick',
    title: 'Quick controls',
    body: 'Wi-Fi, Bluetooth, volume and brightness, without leaving what you are doing.',
    needs: 'expanded',
    target: ['.panel__quick-controls', '[data-tour="quick-controls"]'],
    anchor: [0.5, 0.5],
  },
  {
    id: 'beam',
    title: 'Beam files',
    body: 'Drop files on the island to send them to your phone.',
    needs: 'expanded',
    target: ['.beam-button', '[data-tour="beam"]'],
    anchor: [0.5, 0.5],
  },
  {
    id: 'search',
    title: 'Search anything',
    body: 'Apps, files and quick answers. Press {search} any time.',
    needs: 'expanded',
    target: ['.search-button', '[data-tour="search"]'],
    anchor: [0.5, 0.5],
  },
  {
    id: 'settings',
    title: 'Make it yours',
    body: 'Themes, widgets, shortcuts and alerts live in Settings. You can replay this tour from General.',
    needs: 'expanded',
    target: ['button[aria-label="Open settings"]', '[data-tour="settings"]'],
    anchor: [0.5, 0.5],
  },
  {
    id: 'done',
    title: "You're set",
    body: 'That is everything. The island is all yours.',
    needs: 'expanded',
    target: [],
    anchor: [0.5, 0.5],
    center: true,
  },
]

export const FIRST_RUN_STEP_COUNT = TOUR_STEPS.length

export function shouldShowFirstRun(settingsLoaded: boolean, savedVersion: number | null | undefined): boolean {
  return settingsLoaded && (savedVersion == null || savedVersion === 0)
}

export interface TourContext {
  /** Kinds of widgets that are enabled right now. */
  widgetKinds: readonly string[]
  tabCount: number
}

/** The steps that make sense for this user's layout, in order. */
export function planTour(context: TourContext): TourStepSpec[] {
  const kinds = new Set(context.widgetKinds)
  return TOUR_STEPS.filter(step => {
    if (step.needsTabs && context.tabCount < 2) return false
    if (step.widgetKinds && !step.widgetKinds.some(kind => kinds.has(kind))) return false
    return true
  })
}

/** First of the step's widget kinds that is enabled, or null. */
export function tourWidgetKind(step: Pick<TourStepSpec, 'widgetKinds'>, kinds: readonly string[]): string | null {
  return step.widgetKinds?.find(kind => kinds.includes(kind)) ?? null
}

export function tourText(text: string, shortcuts: { open: string; search: string }): string {
  return text.replace('{open}', shortcuts.open || 'the shortcut').replace('{search}', shortcuts.search || 'the search shortcut')
}

/** "Ctrl+Shift+Space" to keycap labels. */
export function shortcutKeys(shortcut: string): string[] {
  return shortcut.split('+').map(part => part.trim()).filter(Boolean)
    .map(part => ['control', 'ctrl', 'commandorcontrol', 'cmdorctrl'].includes(part.toLowerCase()) ? 'Ctrl' : part)
}

export interface TourRect { x: number; y: number; w: number; h: number }

function overlap(a: TourRect, b: TourRect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** Where the caption card sits: below a collapsed pill, otherwise inside the
 * island on whichever corner covers the target least. */
export function placeCaption(input: {
  viewport: { w: number; h: number }
  island: TourRect
  card: { w: number; h: number }
  target: TourRect | null
  collapsed: boolean
  center?: boolean
}): { x: number; y: number } {
  const { viewport, island, card, target, collapsed } = input
  const margin = 12
  const clamp = (x: number, y: number) => ({
    x: Math.round(Math.max(margin, Math.min(viewport.w - card.w - margin, x))),
    y: Math.round(Math.max(margin, Math.min(viewport.h - card.h - margin, y))),
  })
  const centerX = island.x + island.w / 2 - card.w / 2
  if (collapsed) return clamp(centerX, island.y + island.h + 14)
  if (input.center) return clamp(centerX, island.y + island.h / 2 - card.h / 2)

  const inset = 16
  const bottom = island.y + island.h - inset - card.h
  const top = island.y + 64
  const left = island.x + inset
  const right = island.x + island.w - inset - card.w
  const candidates = [
    { x: centerX, y: bottom },
    { x: left, y: bottom },
    { x: right, y: bottom },
    { x: centerX, y: top },
  ].map(point => clamp(point.x, point.y))
  if (!target) return candidates[0]
  const padded = { x: target.x - 10, y: target.y - 10, w: target.w + 20, h: target.h + 20 }
  let best = candidates[0]
  let bestScore = Infinity
  candidates.forEach((candidate, index) => {
    const score = overlap({ x: candidate.x, y: candidate.y, w: card.w, h: card.h }, padded) + index * 0.001
    if (score < bestScore) { best = candidate; bestScore = score }
  })
  return best
}

/** One semi-implicit Euler step of a damped spring, in px and seconds. */
export function springStep(position: number, velocity: number, target: number, dt: number, stiffness: number, damping: number): [number, number] {
  const nextVelocity = velocity + (-stiffness * (position - target) - damping * velocity) * dt
  return [position + nextVelocity * dt, nextVelocity]
}

export function dampingFor(stiffness: number, ratio: number): number {
  return 2 * Math.sqrt(stiffness) * ratio
}
