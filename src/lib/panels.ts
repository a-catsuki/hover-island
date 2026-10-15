import type { WidgetConfig } from './ipc'
import { widgetPages } from './widgetPages'

export type PanelId = string
export const DEFAULT_PANEL_ORDER: PanelId[] = ['today', 'desk', 'activity']
export const MAX_PANEL_COUNT = 128

export const SIZE_PRESETS = {
  small: { label: 'Small', collapsed: { w: 256, h: 36 }, expanded: { w: 640, h: 440 } },
  medium: { label: 'Medium', collapsed: { w: 320, h: 38 }, expanded: { w: 800, h: 560 } },
  large: { label: 'Large', collapsed: { w: 384, h: 42 }, expanded: { w: 960, h: 640 } },
} as const

export interface PanelLayout {
  panels: Record<PanelId, string>
  panelOrder: PanelId[]
  widgets: WidgetConfig[]
}

const validPanelId = (id: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)
const cleanTitle = (title: string, fallback: string) => title.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24) || fallback

export function defaultPanelForKind(kind: string, panelOrder: PanelId[] = DEFAULT_PANEL_ORDER): PanelId {
  const preferred = ['media', 'weather', 'calendar'].includes(kind) ? 'today'
    : ['notes', 'dock', 'focus', 'clock', 'nearby'].includes(kind) ? 'desk' : 'activity'
  return panelOrder.includes(preferred) ? preferred : panelOrder[0] ?? 'today'
}

export function widgetPanel(widget: WidgetConfig, panelOrder: PanelId[] = DEFAULT_PANEL_ORDER): PanelId {
  return widget.panel && panelOrder.includes(widget.panel) ? widget.panel : defaultPanelForKind(widget.kind, panelOrder)
}

export function moveToPanel(widgets: WidgetConfig[], id: string, panel: PanelId): WidgetConfig[] {
  return widgets.map(widget => widget.id === id ? { ...widget, panel } : widget)
}

function generatedOverflowId(base: string, suffix: number, panels: Record<string, string>): string {
  const stem = `overflow-${base.slice(0, 48)}-${suffix}`
  let id = stem
  let serial = 2
  while (panels[id]) id = `${stem}-${serial++}`
  return id
}

/**
 * Normalize saved panels and turn legacy overflow pages into ordinary panels.
 * A one-column layout is the conservative fit, so a panel also fits on narrow
 * windows without creating another hidden page when the island is resized.
 */
export function fitPanelLayout(
  sourcePanels: Record<string, string> | null | undefined,
  sourceOrder: string[] | null | undefined,
  sourceWidgets: WidgetConfig[],
): PanelLayout {
  const panels: Record<string, string> = {}
  for (const [rawId, rawTitle] of Object.entries(sourcePanels ?? {}).slice(0, MAX_PANEL_COUNT)) {
    const id = rawId.trim()
    if (validPanelId(id) && typeof rawTitle === 'string') panels[id] = cleanTitle(rawTitle, 'Panel')
  }
  if (!Object.keys(panels).length) panels.today = 'Today'

  const panelOrder: string[] = []
  for (const id of sourceOrder ?? []) {
    if (typeof id === 'string' && panels[id] && !panelOrder.includes(id)) panelOrder.push(id)
  }
  for (const id of Object.keys(panels)) if (!panelOrder.includes(id)) panelOrder.push(id)

  let widgets = sourceWidgets.map(widget => ({ ...widget }))
  // Preserve a valid panel assignment even when the old file lacks its label.
  for (const widget of widgets) {
    if (!widget.panel || !validPanelId(widget.panel) || panels[widget.panel]) continue
    if (Object.keys(panels).length >= MAX_PANEL_COUNT) {
      widget.panel = panelOrder[0]
      continue
    }
    panels[widget.panel] = `Recovered ${panelOrder.length + 1}`
    panelOrder.push(widget.panel)
  }
  widgets = widgets.map(widget => ({ ...widget, panel: widgetPanel(widget, panelOrder) }))

  const roots = [...panelOrder]
  for (const root of roots) {
    const members = widgets.filter(widget => widget.panel === root).sort((a, b) => a.order - b.order)
    const pages = widgetPages(members, 1)
    let insertAt = panelOrder.indexOf(root) + 1
    for (let pageIndex = 1; pageIndex < pages.length && panelOrder.length < MAX_PANEL_COUNT; pageIndex++) {
      const suffix = pageIndex + 1
      const id = generatedOverflowId(root, suffix, panels)
      panels[id] = cleanTitle(`${panels[root]} ${suffix}`, `Panel ${suffix}`)
      panelOrder.splice(insertAt++, 0, id)
      const pageIds = new Set(pages[pageIndex].map(slot => slot.widget.id))
      widgets = widgets.map(widget => pageIds.has(widget.id) ? { ...widget, panel: id } : widget)
    }
  }

  // Overflow pages are derived from capacity. Remove them again when a resize
  // or move leaves them empty, while retaining user-created and disabled-only pages.
  for (const id of [...panelOrder]) {
    if (!id.startsWith('overflow-') || widgets.some(widget => widget.panel === id)) continue
    delete panels[id]
    panelOrder.splice(panelOrder.indexOf(id), 1)
  }
  return { panels, panelOrder, widgets }
}

export function createPanelLayout(layout: PanelLayout, title = 'New panel'): PanelLayout {
  if (layout.panelOrder.length >= MAX_PANEL_COUNT) return layout
  const panels = { ...layout.panels }
  let id = `panel-${crypto.randomUUID()}`
  while (panels[id]) id = `panel-${crypto.randomUUID()}`
  const normalized = fitPanelLayout({ ...panels, [id]: cleanTitle(title, 'New panel') }, [...layout.panelOrder, id], layout.widgets)
  return normalized
}

export function renamePanelLayout(layout: PanelLayout, id: PanelId, title: string): PanelLayout {
  if (!layout.panels[id]) return layout
  return { ...layout, panels: { ...layout.panels, [id]: cleanTitle(title, layout.panels[id]) } }
}

export function removePanelLayout(layout: PanelLayout, id: PanelId): PanelLayout {
  if (!layout.panels[id] || layout.panelOrder.length <= 1) return layout
  const panelOrder = layout.panelOrder.filter(panel => panel !== id)
  const panels = { ...layout.panels }
  delete panels[id]
  let widgets = layout.widgets.map(widget => ({ ...widget }))
  const displaced = widgets.filter(widget => widget.panel === id).sort((a, b) => a.order - b.order)
  widgets = widgets.filter(widget => widget.panel !== id)
  for (const widget of displaced) {
    const destination = [...panelOrder].sort((a, b) =>
      widgets.filter(item => item.panel === a && item.enabled && item.kind !== 'airdrop').length -
      widgets.filter(item => item.panel === b && item.enabled && item.kind !== 'airdrop').length,
    )[0]
    widgets.push({ ...widget, panel: destination })
  }
  return fitPanelLayout(panels, panelOrder, widgets)
}
