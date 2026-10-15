import type { WidgetConfig } from './ipc'
export type PanelId = 'today' | 'desk' | 'activity'
export const PANELS: PanelId[] = ['today', 'desk', 'activity']
export const SIZE_PRESETS = {
  small: { label: 'Small', collapsed: { w: 256, h: 36 }, expanded: { w: 640, h: 440 } },
  medium: { label: 'Medium', collapsed: { w: 320, h: 38 }, expanded: { w: 800, h: 560 } },
  large: { label: 'Large', collapsed: { w: 384, h: 42 }, expanded: { w: 960, h: 640 } },
} as const
export function widgetPanel(widget: WidgetConfig): PanelId {
  if (widget.panel && PANELS.includes(widget.panel)) return widget.panel
  if (['media', 'weather', 'calendar'].includes(widget.kind)) return 'today'
  if (['notes', 'dock', 'focus', 'clock', 'nearby'].includes(widget.kind)) return 'desk'
  return 'activity'
}
export function moveToPanel(widgets: WidgetConfig[], id: string, panel: PanelId): WidgetConfig[] {
  return widgets.map(widget => widget.id === id ? { ...widget, panel } : widget)
}
