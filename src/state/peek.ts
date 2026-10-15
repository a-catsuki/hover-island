import { createSignal, untrack } from 'solid-js'
import type { AiEvent, AppNotification } from '../lib/ipc'
import { settings } from './settings'
import { hovering, pinned as isPinned, open, closing, expandIsland, collapseIsland, temporaryExpansion } from './ui'
import { notificationAllowed } from '../lib/connectionSources'

const PEEK_MS = 3600
const startedAt = Date.now()

const [peek, setPeek] = createSignal<AppNotification | null>(null)
const [pendingAlert, setPendingAlert] = createSignal<AppNotification | null>(null)
let playSound: (() => void) | undefined
let pendingAlertTimer: ReturnType<typeof setTimeout> | undefined
export function configurePeekSound(callback: () => void): () => void {
  playSound = callback
  return () => { if (playSound === callback) playSound = undefined }
}
export function acknowledgePendingAlert(id?: string): void {
  if (!id || pendingAlert()?.id === id) {
    clearTimeout(pendingAlertTimer)
    pendingAlertTimer = undefined
    setPendingAlert(null)
  }
}
export function openPendingAlert(): void { const item=pendingAlert();if(item){acknowledgePendingAlert(item.id);show(item,false);expandIsland(false)} }
const completedTransfers = new Set<string>()
const seen = new Set<string>()
let timer: ReturnType<typeof setTimeout> | undefined

function markSeen(id: string): boolean {
  if (!id || seen.has(id)) return false
  seen.add(id)
  while (seen.size > 500) {
    const oldest = seen.values().next().value
    if (oldest === undefined) break
    seen.delete(oldest)
  }
  return true
}

function show(item: AppNotification, notify = true): void {
  const progressing = ['staging','sending','receiving'].includes(item.phase ?? '')
  const connectedAlert = item.category === 'erp' || item.category === 'website' || item.category === 'transfer' || item.app === 'Phone bucket'
  if (connectedAlert && !progressing && notify) {
    setPendingAlert(item)
    clearTimeout(pendingAlertTimer)
    pendingAlertTimer = setTimeout(() => {
      pendingAlertTimer = undefined
      if (pendingAlert()?.id === item.id) setPendingAlert(null)
    }, PEEK_MS)
    if (untrack(() => settings.notifications.sound) && untrack(() => settings.notifications.sound) !== 'off') playSound?.()
  }
  const userOwnsPanel = (open() && !closing()) || isPinned() || hovering()
  const isTransient = temporaryExpansion() || !userOwnsPanel
  setPeek(item)
  expandIsland(isTransient)
  clearTimeout(timer)
  timer = setTimeout(finish, PEEK_MS)
}

function finish(): void {
  clearTimeout(timer)
  timer = undefined
  setPeek(null)
  if (temporaryExpansion() && !hovering() && !isPinned()) collapseIsland()
}
/** Confirm a deliberate preference change even when it enables DND. */
export function ingestPreferencePeek(title:string,body:string):void {
  show({id:`preference:${Date.now()}`,app:'Do Not Disturb',category:'preference',title,body,timestamp:Date.now()},false)
}

/** Feed the latest notification list; show its newest fresh item without a stale backlog. */
export function ingestNotifications(items: AppNotification[]): void {
  const dnd = untrack(() => settings.dnd)
  const alertsOn = untrack(() => settings.notifications.enabled)
  let latest: AppNotification | undefined
  for (const item of items) {
    if (!markSeen(item.id)) continue
    const allowed = item.app === 'Bluetooth' || item.app === 'Battery' || item.app === 'Volume' || item.app === 'Brightness' || item.app === 'Phone bucket' ||
      (item.app === 'Codex Reset Watch'
        ? untrack(() => settings.widgets.some(widget => widget.kind === 'reset-watch' && widget.enabled))
        : notificationAllowed(item, untrack(() => settings.connections), untrack(() => settings.dock)))
    if (!dnd && alertsOn && item.timestamp >= startedAt && allowed && (!latest || item.timestamp >= latest.timestamp)) {
      latest = item
    }
  }
  if (latest) show(latest)
}

/** Action-completion peeks share DND and notification preferences, without source routing. */
export function ingestActionPeek(item: AppNotification): void {
  if (!markSeen(item.id)) return
  if (untrack(() => settings.dnd) || !untrack(() => settings.notifications.enabled)) return
  show(item)
}

/** AI activity peeks share DND and notification preferences and get a dedicated notch variant. */
export function ingestAiPeek(event: AiEvent): void {
  if (!markSeen(event.id)) return
  if (untrack(() => settings.dnd) || !untrack(() => settings.notifications.enabled)) return
  show({
    id: event.id,
    app: event.provider?.trim() || 'AI',
    title: event.title,
    body: event.body ?? '',
    timestamp: event.timestamp,
    category: 'ai',
    aiKind: event.kind,
  })
}

/** Progress replaces the current transfer peek without a growing alert queue. */
export function ingestTransferPeek(item: AppNotification): void {
  if (untrack(() => settings.dnd) || !untrack(() => settings.notifications.enabled)) return
  const id=item.transferId ?? item.id
  if (completedTransfers.has(id)) return
  if (!['staging','receiving','sending'].includes(item.phase ?? '')) {
    completedTransfers.add(id)
    while(completedTransfers.size>100)completedTransfers.delete(completedTransfers.values().next().value!)
    ingestActionPeek({ ...item, category:'transfer' }); return
  }
  show({ ...item, category:'transfer', progress: typeof item.progress === 'number' && Number.isFinite(item.progress) ? Math.max(0, Math.min(1, item.progress)) : null })
}

/** A deliberate hover, pin, or open gesture adopts a temporary peek. */
export function promotePeek(): void {
  if (!peek() || !temporaryExpansion()) return
  expandIsland(false)
}

/** Called when DND turns on or the user dismisses the visible alert. */
export function dismissPeek(): void {
  clearTimeout(timer)
  timer = undefined
  setPeek(null)
  if (temporaryExpansion() && !hovering() && !isPinned()) collapseIsland()
}

export { peek, pendingAlert, temporaryExpansion as transientPeek }
