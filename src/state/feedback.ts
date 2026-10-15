import { createSignal } from 'solid-js'

/* A failed action's banner should acknowledge the error, then get out of the
   way. It auto-expires, can be dismissed by hand, and clears on collapse so a
   stale message never lingers in the chrome. */
const FEEDBACK_MS = 6000

const [feedback, setFeedback] = createSignal('')
let expiry: ReturnType<typeof setTimeout> | undefined

function clearFeedback(): void {
  if (expiry !== undefined) {
    clearTimeout(expiry)
    expiry = undefined
  }
  setFeedback('')
}

export function reportError(context: string, error: unknown): void {
  // Re-arm the expiry on every report so a repeated identical failure cannot
  // pin stale text on screen forever.
  clearTimeout(expiry)
  setFeedback(`${context}: ${error instanceof Error ? error.message : String(error)}`)
  expiry = setTimeout(() => {
    expiry = undefined
    setFeedback('')
  }, FEEDBACK_MS)
}

export function dismissFeedback(): void {
  clearFeedback()
}

export { feedback }
