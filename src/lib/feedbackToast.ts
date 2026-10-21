/** Short action/feedback toasts: an icon plus two to four words, never a paragraph. */

export type FeedbackToastIcon = 'wifi' | 'bluetooth' | 'volume' | 'muted' | 'brightness' | 'moon' | 'plane' | 'power' | 'memory' | 'check' | 'error'

export const FEEDBACK_TOAST_MS = 1600
export const FEEDBACK_TOAST_ERROR_MS = 2400
/** How long the island must have sat fully collapsed before a queued toast may appear. */
export const FEEDBACK_SETTLE_MS = 350
/** A queued toast older than this is stale and is dropped instead of shown. */
export const FEEDBACK_STALE_MS = 12_000
export const FEEDBACK_QUEUE_MAX = 3
export const FEEDBACK_MAX_WORDS = 4
export const FEEDBACK_MAX_CHARS = 26

/** Apps whose peeks are acknowledgements of something the user just did. */
export const FEEDBACK_APPS = ['Quick settings', 'Volume', 'Brightness', 'Bluetooth', 'Do Not Disturb'] as const

const ERROR_WORDS = /\b(fail(ed|ure)?|couldn'?t|could not|can'?t|error|unable|denied)\b/i

export function isFeedbackError(text: string): boolean {
  return ERROR_WORDS.test(text)
}

/** Trim a sentence down to at most four words and a hard character cap. */
export function shortToastText(raw: string): string {
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').replace(/[.!…]+$/, '').trim()
  const words = clean.split(' ').filter(Boolean).slice(0, FEEDBACK_MAX_WORDS)
  let text = words.join(' ')
  while (text.length > FEEDBACK_MAX_CHARS && words.length > 1) { words.pop(); text = words.join(' ') }
  return text.length > FEEDBACK_MAX_CHARS ? text.slice(0, FEEDBACK_MAX_CHARS - 1).trimEnd() + '…' : text
}

export function feedbackIconFor(app: string, text: string): FeedbackToastIcon {
  const haystack = `${app} ${text}`.toLowerCase()
  if (isFeedbackError(text)) return 'error'
  if (/wi-?fi|wireless/.test(haystack)) return 'wifi'
  if (/bluetooth/.test(haystack)) return 'bluetooth'
  if (/muted/.test(haystack)) return 'muted'
  if (/volume|sound|audio/.test(haystack)) return 'volume'
  if (/brightness|night light/.test(haystack)) return 'brightness'
  if (/do not disturb|focus assist|\bdnd\b/.test(haystack)) return 'moon'
  if (/airplane|flight/.test(haystack)) return 'plane'
  if (/power|battery|energy|efficiency/.test(haystack)) return 'power'
  if (/memory|optimi[sz]/.test(haystack)) return 'memory'
  return 'check'
}

export interface FeedbackToastInput { id: string; app: string; title: string; body?: string; timestamp: number }
export interface FeedbackToast { id: string; key: string; text: string; icon: FeedbackToastIcon; error: boolean; queuedAt: number }

/** One short line from a notification-shaped item. Volume and brightness fold their level in. */
export function toFeedbackToast(item: FeedbackToastInput, now: number): FeedbackToast {
  let text: string
  if (item.app === 'Volume' || item.app === 'Brightness') {
    const level = /\d{1,3}\s?%/.exec(item.body || item.title)?.[0]?.replace(/\s/g, '')
    text = /muted/i.test(`${item.title} ${item.body ?? ''}`) ? 'Muted' : level ? `${item.app} ${level}` : item.app
  } else {
    text = shortToastText(item.title) || shortToastText(item.body ?? '') || 'Done'
  }
  const error = isFeedbackError(`${item.title} ${item.body ?? ''}`)
  return { id: item.id, key: item.app, text, icon: feedbackIconFor(item.app, `${text} ${item.title}`), error, queuedAt: now }
}

export interface FeedbackReadiness {
  /** Island is expanded, opening, closing or pinned. */
  expanded: boolean
  open: boolean
  closing: boolean
  pinned: boolean
  hovering: boolean
  interacting: boolean
  /** Another peek is on screen. */
  peekVisible: boolean
  /** Milliseconds since the island finished collapsing. */
  collapsedForMs: number
}

/** A queued toast may show only when the island is fully collapsed, idle and has been for a moment. */
export function feedbackReady(state: FeedbackReadiness): boolean {
  return !state.expanded && !state.open && !state.closing && !state.pinned && !state.hovering &&
    !state.interacting && !state.peekVisible && state.collapsedForMs >= FEEDBACK_SETTLE_MS
}

/** Insert into the bounded queue: the newest toast per key wins (errors are kept), the queue stays short. */
export function enqueueFeedback(queue: FeedbackToast[], toast: FeedbackToast): FeedbackToast[] {
  const next = queue.filter(entry => entry.key !== toast.key || entry.error)
  if (!next.some(entry => entry.id === toast.id)) next.push(toast)
  while (next.length > FEEDBACK_QUEUE_MAX) next.shift()
  return next
}

export const dropStaleFeedback = (queue: FeedbackToast[], now: number): FeedbackToast[] =>
  queue.filter(entry => now - entry.queuedAt <= FEEDBACK_STALE_MS)
