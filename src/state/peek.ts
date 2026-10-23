import { createSignal, untrack } from 'solid-js'
import type { AiActivityEvent, AiEvent, AppNotification, EmailCodeEvent } from '../lib/ipc'
import { settings } from './settings'
import { hovering, pinned as isPinned, open, closing, expanded, collapsedForMs, expandIsland, collapseIsland, temporaryExpansion, surfaceInteractionActive } from './ui'
import { notificationAllowed } from '../lib/connectionSources'
import {
  FEEDBACK_APPS, FEEDBACK_SETTLE_MS, FEEDBACK_TOAST_ERROR_MS, FEEDBACK_TOAST_MS,
  dropStaleFeedback, enqueueFeedback, feedbackReady, toFeedbackToast, type FeedbackToast,
} from '../lib/feedbackToast'

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

/* ------------------------------------------------- action / feedback toasts
   Acknowledgements of something the user just did (a Quick settings toggle, a volume
   change) are tiny icon + few-word toasts. They never appear while the user is on the
   expanded island: they queue and show once the pointer has left and the island has
   sat collapsed for a moment. */
let feedbackQueue: FeedbackToast[] = []
let feedbackTimer: ReturnType<typeof setTimeout> | undefined

/** The user owns the panel (hover, open by intent, pinned, mid-gesture or still closing/settling). */
function userBusy(): boolean {
  return untrack(() =>
    (open() && !temporaryExpansion()) || closing() || hovering() || isPinned() || surfaceInteractionActive() ||
    (!expanded() && collapsedForMs() < FEEDBACK_SETTLE_MS))
}

function isFeedbackItem(item: AppNotification): boolean {
  return item.category === 'preference' || (FEEDBACK_APPS as readonly string[]).includes(item.app)
}

function queueFeedback(toast: FeedbackToast): void {
  feedbackQueue = enqueueFeedback(feedbackQueue, toast)
  scheduleFeedbackDrain()
}

function scheduleFeedbackDrain(delay = 150): void {
  if (feedbackTimer !== undefined || !feedbackQueue.length) return
  feedbackTimer = setTimeout(runFeedbackDrain, delay)
}

function runFeedbackDrain(): void {
  feedbackTimer = undefined
  feedbackQueue = dropStaleFeedback(feedbackQueue, Date.now())
  if (untrack(() => settings.dnd)) feedbackQueue = feedbackQueue.filter(entry => entry.key === 'Do Not Disturb')
  if (!feedbackQueue.length) return
  const ready = untrack(() => feedbackReady({
    expanded: expanded(), open: open(), closing: closing(), pinned: isPinned(), hovering: hovering(),
    interacting: surfaceInteractionActive(), peekVisible: !!peek(), collapsedForMs: collapsedForMs(),
  }))
  if (!ready) { scheduleFeedbackDrain(); return }
  const next = feedbackQueue.shift()!
  presentFeedback(next)
}

function presentFeedback(toast: FeedbackToast): void {
  clearTimeout(timer)
  clearTimeout(aiLeaveTimer)
  setAiToastLeaving(false)
  expandIsland(true)
  setPeek({
    id: toast.id, app: toast.key, title: toast.text, body: '', timestamp: Date.now(),
    category: 'feedback', feedbackIcon: toast.icon, feedbackError: toast.error,
  })
  timer = setTimeout(finish, toast.error ? FEEDBACK_TOAST_ERROR_MS : FEEDBACK_TOAST_MS)
}

/** An explicit short toast (icon plus a few words) for callers that are not notification-shaped. */
export function ingestFeedbackToast(input: { id?: string; app?: string; text: string; error?: boolean }): void {
  if (untrack(() => settings.dnd) || !untrack(() => settings.notifications.enabled)) return
  const id = input.id ?? `feedback:${Date.now()}:${Math.random().toString(16).slice(2)}`
  if (!markSeen(id)) return
  const toast = toFeedbackToast({ id, app: input.app ?? 'Quick settings', title: input.text, timestamp: Date.now() }, Date.now())
  queueFeedback(input.error ? { ...toast, error: true, icon: 'error' } : toast)
}

function show(item: AppNotification, notify = true): void {
  if (item.category !== 'feedback' && isFeedbackItem(item) && (item.app === 'Quick settings' || userBusy())) {
    queueFeedback(toFeedbackToast(item, Date.now()))
    return
  }
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
  // Open first: the island never sees a peek over a closed shape.
  expandIsland(isTransient)
  setPeek(item)
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
  scheduleFeedbackDrain()
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
    // Desktop toasts do not identify the agent or turn. Verified agent events
    // own task-status peeks; the original Windows notification stays in the inbox.
    const aiStatus = /^(claude(?: code| desktop)?|codex)$/i.test(item.app.trim()) &&
      /\b(?:(?:task|agent|turn) (?:complete[ds]?|finished)|(?:needs?|requires?) (?:your )?(?:input|attention|approval|permission)|waiting for (?:your|input|approval)|permission (?:needed|required))\b/i.test(`${item.title} ${item.body ?? ''}`)
    if (untrack(() => settings.aiToastsEnabled) && aiStatus) continue
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

/** Alarms and important reminders: shown even in Do Not Disturb (they are things the user asked to be told about). */
export function ingestUrgentPeek(item: AppNotification): void {
  if (!markSeen(item.id)) return
  if (!untrack(() => settings.notifications.enabled)) return
  show(item)
}

/** AI activity peeks share DND and notification preferences and get a dedicated notch variant. */
export function ingestAiPeek(event: AiEvent): void {
  if (event.kind !== 'complete' && event.kind !== 'needs-input') return
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
  scheduleFeedbackDrain()
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

/** A resumed task must not leave an old question waiting in the toast queue. */
export function retireAiQuestion(event: AiActivityEvent): void {
  if (event.kind !== 'started' && event.kind !== 'progress') return
  for (let i = aiQueue.length - 1; i >= 0; i--) {
    if (sameSession(aiQueue[i], event) && aiQueue[i].kind === 'question') aiQueue.splice(i, 1)
  }
  const current = peek()?.aiActivity
  if (current?.kind === 'question' && sameSession(current, event)) dismissPeek()
}

export { peek, pendingAlert, aiToastLeaving, temporaryExpansion as transientPeek }
