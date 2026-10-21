import { createSignal } from 'solid-js'
import { dedicatePanelLayout, specialPanelForKind, type PanelId } from '../lib/panels'
import { settings, patchSettings } from './settings'

export const [activePanel, setActivePanel] = createSignal<PanelId>('today')
export const [bucketRequest, setBucketRequest] = createSignal(0)
export const [widgetRequest, setWidgetRequest] = createSignal<{id:string;revision:number}|null>(null)
export const [detailRequest, setDetailRequest] = createSignal<{kind:string;revision:number}|null>(null)
export function requestWidgetDetail(kind:string):void {
  setDetailRequest(previous => ({kind,revision:(previous?.revision??0)+1}))
}

/** Move a widget kind onto its dedicated page (creating the page and widget if needed) and switch to it. */
function revealOnOwnPage(kind: 'controls' | 'nearby', fallbackId: string): string {
  const spec = specialPanelForKind(kind)!
  const existing = settings.widgets.find(widget => widget.kind === kind)
  const widgets = (existing ? settings.widgets : [...settings.widgets, { id: fallbackId, kind, enabled: true, panel: spec.id, order: settings.widgets.length }])
    .map(widget => ({ ...widget }))
  const layout = dedicatePanelLayout({ panels: { ...settings.panels }, panelOrder: [...settings.panelOrder], widgets }, kind)
  patchSettings(layout)
  setActivePanel(spec.id)
  return existing?.id ?? fallbackId
}

export function showControls(): void {
  const id = revealOnOwnPage('controls', 'pc-controls')
  setWidgetRequest(previous => ({ id, revision: (previous?.revision ?? 0) + 1 }))
}

/** A drop or the Files shortcut opens the same persistent bucket. */
export function showFileBucket(): void {
  const id = revealOnOwnPage('nearby', 'phone-bucket')
  setBucketRequest(value => value + 1)
  setWidgetRequest(previous => ({ id, revision: (previous?.revision ?? 0) + 1 }))
}
