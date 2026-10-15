import { createSignal } from 'solid-js'

/* A failed action's banner should acknowledge the error, then get out of the
   way. It auto-expires, can be dismissed by hand, and clears on collapse so a
   stale message never lingers in the chrome. */
const FEEDBACK_MS = 6000

const [feedback, setFeedback] = createSignal('')
let expiry: ReturnType<typeof setTimeout> | undefined
const recentMessages = new Map<string, number>()

function clearFeedback(): void {
  if (expiry !== undefined) {
    clearTimeout(expiry)
    expiry = undefined
  }
  setFeedback('')
}

export function reportError(context: string, error: unknown): void {
  const message = `${context}: ${error instanceof Error ? error.message : String(error)}`
  // A polling failure must not extend its own banner forever or immediately
  // resurrect it after dismissal. New failures still receive fresh feedback.
  const now = Date.now()
  const previous = recentMessages.get(message)
  if (previous !== undefined && now - previous < 30_000) return
  recentMessages.delete(message)
  recentMessages.set(message, now)
  if (recentMessages.size > 32) recentMessages.delete(recentMessages.keys().next().value!)
  clearTimeout(expiry)
  setFeedback(message)
  expiry = setTimeout(() => {
    expiry = undefined
    setFeedback('')
  }, FEEDBACK_MS)
}

export function dismissFeedback(): void {
  clearFeedback()
}

export { feedback }
