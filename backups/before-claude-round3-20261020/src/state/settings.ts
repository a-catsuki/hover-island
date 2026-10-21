import { createEffect, createSignal } from 'solid-js'
import { createStore, reconcile, unwrap } from 'solid-js/store'
import { cmd, DEFAULT_SETTINGS, onSettingsChanged, type DockItem, type Settings } from '../lib/ipc'
import { applyTemplate } from '../lib/themes'
import { applyAccent } from './ui'
import { dismissFeedback, reportError } from './feedback'
import { fitPanelLayout } from '../lib/panels'

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const [settings, setSettings] = createStore<Settings>(clone(DEFAULT_SETTINGS))
const [savingSettings, setSavingSettings] = createSignal(false)
let confirmed = clone(DEFAULT_SETTINGS)
let pending: Partial<Settings> = {}
let timer: ReturnType<typeof setTimeout> | undefined
let writeQueue: Promise<void> = Promise.resolve()
let revision = 0
let syncRevision = 0
let settingsListener: Promise<void> | undefined
let writeFailureRevision = 0
let lastWriteFailure: unknown

function merge(current: Settings, patch: Partial<Settings>): Settings {
  const merged: Settings = { ...current, ...patch,
    collapsed: { ...current.collapsed, ...patch.collapsed },
    expanded: { ...current.expanded, ...patch.expanded },
    modules: { ...current.modules, ...patch.modules },
    visualizer: { ...current.visualizer, ...patch.visualizer },
    notifications: { ...current.notifications, ...patch.notifications },
    interaction: { ...current.interaction, ...patch.interaction },
    panels: patch.panels ?? current.panels,
    panelOrder: Array.isArray(patch.panelOrder) ? patch.panelOrder : current.panelOrder,
    placement: { ...current.placement, ...patch.placement },
    usage: { ...current.usage, ...patch.usage,
      manualConfig: { ...current.usage.manualConfig, ...patch.usage?.manualConfig } },
    widgets: Array.isArray(patch.widgets) ? patch.widgets : current.widgets,
    compactItems: Array.isArray(patch.compactItems) ? patch.compactItems : current.compactItems,
    connections: Array.isArray(patch.connections) ? patch.connections : current.connections,
    weatherLat: patch.weatherLat !== undefined ? patch.weatherLat : current.weatherLat,
    weatherLon: patch.weatherLon !== undefined ? patch.weatherLon : current.weatherLon,
    weatherCity: patch.weatherCity !== undefined ? patch.weatherCity : current.weatherCity,
    dock: patch.dock ?? current.dock,
  }
  const layout = fitPanelLayout(merged.panels, merged.panelOrder, merged.widgets)
  return { ...merged, ...layout }
}
function mergePending(older: Partial<Settings>, newer: Partial<Settings>): Partial<Settings> {
  const combined = { ...older, ...newer }
  for (const key of ['collapsed', 'expanded', 'placement', 'modules', 'visualizer', 'notifications', 'interaction', 'usage'] as const) {
    const before = older[key]
    const after = newer[key]
    if (before && after) {
      ;(combined as Record<string, unknown>)[key] = { ...before, ...after }
    }
  }
  if (older.usage?.manualConfig && newer.usage?.manualConfig) {
    combined.usage = {
      ...older.usage,
      ...newer.usage,
      manualConfig: { ...older.usage.manualConfig, ...newer.usage.manualConfig },
    }
  }
  return combined
}
createEffect(() => {
  applyTemplate(settings.theme)
  applyAccent(settings.accent)
  const root = document.documentElement.style
  root.setProperty('--island-opacity', String(settings.opacity))
  root.setProperty('--collapsed-w', `${settings.collapsed.w}px`)
  root.setProperty('--collapsed-h', `${settings.collapsed.h}px`)
  root.setProperty('--expanded-w', `${settings.expanded.w}px`)
  root.setProperty('--expanded-h', `${settings.expanded.h}px`)
  root.setProperty('--clock-font',settings.clockTypography==='serif'?'Georgia,serif':settings.clockTypography==='mono'?'Consolas,monospace':'"Segoe UI Variable",Inter,system-ui,sans-serif')
})
export async function loadSettings(): Promise<boolean> {
  const startRevision = revision
  if (!settingsListener) {
    settingsListener = onSettingsChanged((value) => {
      syncRevision++
      confirmed = merge(clone(DEFAULT_SETTINGS), value)
      setSettings(reconcile(merge(confirmed, pending)))
    }).then((unlisten) => {
      // The store is process-wide and intentionally lives as long as this window.
      void unlisten
    }).catch((error) => {
      settingsListener = undefined
      reportError('Could not sync preferences across windows', error)
    })
  }
  try {
    // Install the event listener before reading the snapshot so changes cannot
    // slip between the initial read and subscription.
    await settingsListener
    const startSyncRevision = syncRevision
    const loaded = merge(clone(DEFAULT_SETTINGS), await cmd.settingsGet())
    if (startRevision === revision && startSyncRevision === syncRevision) {
      confirmed = loaded
      setSettings(reconcile(confirmed))
    }
    return true
  } catch (error) { reportError('Could not load preferences', error); return false }
}
function enqueueSave(): void {
  if (!Object.keys(pending).length) return
  const patch = pending
  pending = {}
  const currentRevision = revision
  setSavingSettings(true)
  writeQueue = writeQueue.then(async () => {
    try {
      const startSyncRevision = syncRevision
      const saved = merge(clone(DEFAULT_SETTINGS), await cmd.settingsSet(patch))
      // The command emits the canonical snapshot before it resolves. If a
      // newer cross-window event arrived while awaiting the IPC response, keep
      // that event's snapshot instead of replacing it with an older response.
      if (syncRevision === startSyncRevision) confirmed = saved
      if (currentRevision === revision) setSettings(reconcile(merge(confirmed, pending)))
      if (patch.usage) void cmd.usageRefresh().catch(error => reportError('Could not refresh usage', error))
    } catch (error) {
      writeFailureRevision++
      lastWriteFailure = error
      pending = mergePending(patch, pending)
      reportError('Preferences were not saved', error)
      if (currentRevision === revision) setSettings(reconcile(confirmed))
    }
  }).finally(() => { if (currentRevision === revision) setSavingSettings(false) })
}
export function patchSettings(patch: Partial<Settings>): void {
  revision++
  setSettings(reconcile(merge(clone(unwrap(settings)), patch)))
  for (const key of Object.keys(patch) as (keyof Settings)[]) {
    const value = patch[key]
    const old = pending[key]
    ;(pending as Record<string, unknown>)[key] = value && old && typeof value === 'object' && !Array.isArray(value)
      ? { ...old as object, ...value as object } : value
  }
  clearTimeout(timer)
  timer = setTimeout(enqueueSave, 180)
}
export async function flushSettings(): Promise<void> {
  const startingFailureRevision = writeFailureRevision
  do {
    clearTimeout(timer)
    enqueueSave()
    const currentQueue = writeQueue
    await currentQueue
    if (writeFailureRevision > startingFailureRevision) throw lastWriteFailure
    if (currentQueue === writeQueue && !Object.keys(pending).length) break
  } while (true)
}
/**
 * Save a patch right now and wait for the native side to accept it (for example
 * a global shortcut that must be registered). If it is refused, the patch is
 * dropped, the store goes back to the last saved values, and the error is thrown
 * so the caller can show it next to the control instead of in the page banner.
 */
export async function applySettings(patch: Partial<Settings>): Promise<void> {
  patchSettings(patch)
  try {
    await flushSettings()
  } catch (error) {
    for (const key of Object.keys(patch)) delete (pending as Record<string, unknown>)[key]
    setSettings(reconcile(merge(confirmed, pending)))
    dismissFeedback()
    throw error
  }
}
export async function resetSettings(): Promise<void> {
  try {
    await flushSettings()
  } catch (error) {
    reportError('Could not reset preferences', error)
    return
  }
  const currentRevision = ++revision
  setSavingSettings(true)
  try {
    confirmed = merge(clone(DEFAULT_SETTINGS), await cmd.settingsReset())
    if (currentRevision === revision) setSettings(reconcile(confirmed))
  } catch (error) { reportError('Could not reset preferences', error) }
  finally { if (currentRevision === revision) setSavingSettings(false) }
}
export function addDock(item: DockItem | (Omit<DockItem, 'id'> & { id?: string })): void {
  if (settings.dock.some(d => d.target.toLowerCase() === item.target.toLowerCase())) return
  patchSettings({ dock: [...settings.dock, { ...item, id: item.id ?? crypto.randomUUID() }] })
}
export function removeDock(id: string): void {
  patchSettings({ dock: settings.dock.filter(d => d.id !== id) })
}
export { settings, savingSettings, merge as mergeSettings }
