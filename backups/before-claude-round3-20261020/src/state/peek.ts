import { createSignal, untrack } from 'solid-js'
import type { AiActivityEvent, AiEvent, AppNotification, EmailCodeEvent } from '../lib/ipc'
import { settings } from './settings'
import { hovering, pinned as isPinned, open, closing, expandIsland, collapseIsland, temporaryExpansion, surfaceInteractionActive } from './ui'
import { notificationAllowed } from '../lib/connectionSources'

const PEEK_MS = 3600
/** How long each kind of AI agent toast stays. Questions wait longest. */
const AI_TOAST_MS: Record<AiActivityEvent['kind'], number> = { started: 2800, progress: 2600, question: 9000, completed: 4800, failed: 6500 }
const AI_LEAVE_MS = 260
const AI_QUEUE_MAX = 6
const startedAt = Date.now()

const [peek, setPeek] = createSignal<AppNotification | null>(null)
const [pendingAlert, setPendingAlert] = createSignal<AppNotification | null>(null)
/** True for the last moments of an AI toast so it can spring out. */
const [aiToastLeaving, setAiToastLeaving] = createSignal(false)
const aiQueue: AiActivityEvent[] = []
let aiLeaveTimer: ReturnType<typeof setTimeout> | undefined
let aiDrainTimer: ReturnType<typeof setTimeout> | undefined
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
export function openPendingAlert(): void { const item=pendingAlert();if(item){acknowledgePendingAlert(item.id);if(item.category==='auth'&&item.expiresAt!=null&&item.expiresAt<=Date.now())return;show(item,false);expandIsland(false)} }
const completedTransfers = new Set<string>()
const seen = new Set<string>()
let timer: ReturnType<typeof setTimeout> | undefined
let deferredAlert: { item: AppNotification; notify: boolean } | undefined
let deferredTimer: ReturnType<typeof setTimeout> | undefined

function flushDeferredAlert(): void {
  deferredTimer = undefined
  if (!deferredAlert) return
  if (surfaceInteractionActive()) {
    deferredTimer = setTimeout(flushDeferredAlert, 120)
    return
  }
  const { item, notify } = deferredAlert
  deferredAlert = undefined
  if ((untrack(() => settings.dnd) && item.category !== 'preference') || !untrack(() => settings.notifications.enabled)) return
  if (item.expiresAt != null && item.expiresAt <= Date.now()) return
  show(item, notify)
}

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
  if (surfaceInteractionActive()) {
    // Keep only the newest value/event; never replay every slider step later.
    deferredAlert = { item, notify }
    clearTimeout(deferredTimer)
    deferredTimer = setTimeout(flushDeferredAlert, 120)
    return
  }
  clearTimeout(deferredTimer)
  deferredTimer = undefined
  deferredAlert = undefined
  const visible = peek()
  if (item.category !== 'ai-activity' && visible?.category === 'ai-activity' && visible.aiActivity && (visible.aiActivity.kind === 'question' || visible.aiActivity.kind === 'completed' || visible.aiActivity.kind === 'failed')) {
    // A notification never overlaps an AI toast: the toast steps aside and returns afterwards.
    queueAiToast(visible.aiActivity, true)
  }
  const progressing = ['staging','sending','receiving'].includes(item.phase ?? '')
  const connectedAlert = item.category === 'erp' || item.category === 'website' || item.category === 'transfer' || item.category === 'auth' || item.app === 'Phone bucket'
  if (connectedAlert && !progressing && notify) {
    setPendingAlert(item)
    clearTimeout(pendingAlertTimer)
    pendingAlertTimer = setTimeout(() => {
      pendingAlertTimer = undefined
      if (pendingAlert()?.id === item.id) setPendingAlert(null)
    }, item.category === 'auth' && item.expiresAt ? Math.max(0, item.expiresAt - Date.now()) : PEEK_MS)
    if (untrack(() => settings.notifications.sound) && untrack(() => settings.notifications.sound) !== 'off') playSound?.()
  }
  const userOwnsPanel = (open() && !closing()) || isPinned() || hovering()
  const isTransient = temporaryExpansion() || !userOwnsPanel
  setPeek(item)
  expandIsland(isTransient)
  clearTimeout(timer)
  clearTimeout(aiLeaveTimer)
  setAiToastLeaving(false)
  const lifetime = item.category === 'ai-activity' && item.aiActivity ? AI_TOAST_MS[item.aiActivity.kind] : PEEK_MS
  if (item.category === 'ai-activity') aiLeaveTimer = setTimeout(() => setAiToastLeaving(true), Math.max(0, lifetime - AI_LEAVE_MS))
  timer = setTimeout(finish, lifetime)
}

/** A provider-detected new sign-in code follows the same DND and notification rules as other alerts. */
export function ingestTwoFactorPeek(event: EmailCodeEvent): void {
  if (!event.id || !/^(?=.{4,8}$)(?=.*\d)[A-Za-z0-9]+$/.test(event.code) || !Number.isFinite(event.expiresAt) || event.expiresAt <= Date.now()) return
  if (!markSeen(event.id) || untrack(() => settings.dnd) || !untrack(() => settings.notifications.enabled) || !untrack(() => settings.modules.notifications)) return
  const sender = event.sender.replace(/[\r\n\u0000-\u001f]/g, '').slice(0, 160)
  const subject = event.subject.replace(/[\r\n\u0000-\u001f]/g, '').slice(0, 120)
  show({
    id: event.id, app: 'Verification code', title: event.code,
    body: [sender, subject, event.account].filter(Boolean).join(' · '),
    timestamp: event.receivedAt, category: 'auth', code: event.code, sender,
    subject, account: event.account, expiresAt: event.expiresAt,
  })
}

function finish(): void {
  clearTimeout(timer)
  clearTimeout(aiLeaveTimer)
  timer = undefined
  setAiToastLeaving(false)
  setPeek(null)
  if (temporaryExpansion() && !hovering() && !isPinned()) collapseIsland()
  scheduleAiDrain()
}
/** Confirm a deliberate preference change even when it enables DND. */
export function ingestPreferencePeek(title:string,body:string):void {
  show({id:`preference:${Date.now()}`,app:'Do Not Disturb',category:'preference',title,body,timestamp:Date.now()},false)
}

/** A toast is live if it appeared after startup (small skew allowed) or is only moments old. */
function isLive(item: AppNotification): boolean {
  return item.timestamp >= startedAt - 5000 || Date.now() - item.timestamp < 90_000
}

/** Mark the inbox that already exists at startup as seen so it never replays as peeks. */
export function primeNotificationBaseline(items: AppNotification[]): void {
  for (const item of items) markSeen(item.id)
}

/** A native popup event is a genuinely new toast (the native side suppresses its baseline poll). */
export function ingestPopupNotification(item: AppNotification): void {
  ingestNotifications([item], true)
}

/** Feed the latest notification list; show its newest fresh item without a stale backlog. */
export function ingestNotifications(items: AppNotification[], trusted = false): void {
  const dnd = untrack(() => settings.dnd)
  const alertsOn = untrack(() => settings.notifications.enabled)
  let latest: AppNotification | undefined
  for (const item of items) {
    if (!markSeen(item.id)) continue
    const allowed = item.app === 'Bluetooth' || item.app === 'Battery' || item.app === 'Volume' || item.app === 'Brightness' || item.app === 'Phone bucket' ||
      (item.app === 'Codex Reset Watch'
        ? untrack(() => settings.widgets.some(widget => widget.kind === 'reset-watch' && widget.enabled))
        : notificationAllowed(item, untrack(() => settings.connections), untrack(() => settings.dock)))
    if (!dnd && alertsOn && (trusted || isLive(item)) && allowed && (!latest || item.timestamp >= latest.timestamp)) {
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
  clearTimeout(deferredTimer)
  deferredTimer = undefined
  deferredAlert = undefined
  clearTimeout(timer)
  clearTimeout(aiLeaveTimer)
  timer = undefined
  setAiToastLeaving(false)
  setPeek(null)
  if (temporaryExpansion() && !hovering() && !isPinned()) collapseIsland()
  scheduleAiDrain()
}

/* ------------------------------------------------------------- AI agent toasts */

const sameSession = (a: AiActivityEvent, b: AiActivityEvent) => a.provider === b.provider && (a.sessionId ?? '') === (b.sessionId ?? '')

function queueAiToast(event: AiActivityEvent, front = false): void {
  // A newer event for the same session replaces an older queued one; a final result drops stale steps.
  for (let i = aiQueue.length - 1; i >= 0; i--) {
    const queued = aiQueue[i]
    if (!sameSession(queued, event)) continue
    if (queued.kind === event.kind || event.kind === 'completed' || event.kind === 'failed' || queued.kind === 'progress') aiQueue.splice(i, 1)
  }
  if (front) aiQueue.unshift(event)
  else aiQueue.push(event)
  while (aiQueue.length > AI_QUEUE_MAX) aiQueue.splice(front ? aiQueue.length - 1 : 0, 1)
}

function presentAiToast(event: AiActivityEvent): void {
  show({
    id: `ai-activity:${event.provider}:${event.sessionId ?? ''}:${event.kind}:${event.ts}`,
    app: event.provider,
    title: event.title,
    body: event.detail,
    timestamp: event.ts,
    category: 'ai-activity',
    aiActivity: event,
    progress: event.percent == null ? null : event.percent / 100,
  }, false)
}

function scheduleAiDrain(): void {
  clearTimeout(aiDrainTimer)
  if (!aiQueue.length) return
  aiDrainTimer = setTimeout(() => {
    aiDrainTimer = undefined
    if (untrack(() => settings.dnd)) { aiQueue.length = 0; return }
    if (peek() || surfaceInteractionActive()) { scheduleAiDrain(); return }
    const next = aiQueue.shift()
    if (next) presentAiToast(next)
  }, 380)
}

/**
 * Show an AI agent toast. Toasts queue behind notification peeks and each other, so two
 * things never share the notch. Updates for the session that is already on screen change
 * it in place.
 */
export function showAiToast(event: AiActivityEvent): void {
  if (untrack(() => settings.dnd)) return
  const current = peek()
  if (current?.category === 'ai-activity' && current.aiActivity && sameSession(current.aiActivity, event) && event.kind !== 'started') {
    const lifetime = AI_TOAST_MS[event.kind]
    setPeek({ ...current, title: event.title || current.title, body: event.detail, aiActivity: event, progress: event.percent == null ? null : event.percent / 100 })
    clearTimeout(timer)
    clearTimeout(aiLeaveTimer)
    setAiToastLeaving(false)
    aiLeaveTimer = setTimeout(() => setAiToastLeaving(true), Math.max(0, lifetime - AI_LEAVE_MS))
    timer = setTimeout(finish, lifetime)
    return
  }
  if (current || surfaceInteractionActive() || aiQueue.length) {
    queueAiToast(event)
    scheduleAiDrain()
    return
  }
  presentAiToast(event)
}

export { peek, pendingAlert, aiToastLeaving, temporaryExpansion as transientPeek }
