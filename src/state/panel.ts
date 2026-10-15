import { createSignal } from 'solid-js'
import { widgetPanel, type PanelId } from '../lib/panels'
import { settings, patchSettings } from './settings'

export const [activePanel, setActivePanel] = createSignal<PanelId>('today')
export const [bucketRequest, setBucketRequest] = createSignal(0)
export const [widgetRequest, setWidgetRequest] = createSignal<{id:string;revision:number}|null>(null)
export const [detailRequest, setDetailRequest] = createSignal<{kind:string;revision:number}|null>(null)
export function requestWidgetDetail(kind:string):void {
  setDetailRequest(previous => ({kind,revision:(previous?.revision??0)+1}))
}

export function showControls(): void {
  const existing = settings.widgets.find(widget => widget.kind === 'controls')
  const id = existing?.id ?? 'pc-controls'
  if (!existing || !existing.enabled) patchSettings({ widgets: existing
    ? settings.widgets.map(widget => widget.id === id ? { ...widget, enabled: true } : widget)
    : [...settings.widgets, { id, kind: 'controls', enabled: true, panel: 'activity', order: settings.widgets.length }],
  })
  setActivePanel(existing ? widgetPanel(existing) : 'activity')
  setWidgetRequest(previous => ({ id, revision: (previous?.revision ?? 0) + 1 }))
}

/** A drop or the Files shortcut opens the same persistent bucket. */
export function showFileBucket(): void {
  const existing = settings.widgets.find(widget => widget.kind === 'nearby')
  if (!existing || !existing.enabled) {
    patchSettings({ widgets: existing
      ? settings.widgets.map(widget => widget.id === existing.id ? { ...widget, enabled: true } : widget)
      : [...settings.widgets, { id: 'phone-bucket', kind: 'nearby', enabled: true, panel: 'desk', order: settings.widgets.length }],
    })
  }
  setActivePanel(existing ? widgetPanel(existing) : 'desk')
  setBucketRequest(value => value + 1)
  setWidgetRequest(previous => ({ id: existing?.id ?? 'phone-bucket', revision: (previous?.revision ?? 0) + 1 }))
}
