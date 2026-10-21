/** Every setting that changes how the island looks. A change to any of them must reach an open island. */
export interface AppearanceSource {
  theme: string
  accent: string
  background: string
  opacity: number
  sizePreset: string
  collapsed: { w: number; h: number }
  expanded: { w: number; h: number }
  clockTypography: string
  clockHourCycle: string
  clockSeconds: boolean
  compactClockStyle: string
  compactItems: readonly string[]
  placement: { mode: string; edge: string }
  panelNames?: Record<string, string>
}

export function appearanceKey(s: AppearanceSource): string {
  return JSON.stringify([
    s.theme, s.accent, s.background, s.opacity, s.sizePreset, s.collapsed.w, s.collapsed.h, s.expanded.w, s.expanded.h,
    s.clockTypography, s.clockHourCycle, s.clockSeconds, s.compactClockStyle, [...s.compactItems], s.placement.mode, s.placement.edge,
    Object.entries(s.panelNames ?? {}),
  ])
}
