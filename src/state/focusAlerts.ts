import { onFocusComplete, FOCUS_MODE_LABEL } from './focus'
import { ingestActionPeek } from './peek'

/**
 * Tells the user when a session ends: a notch alert (which plays the chime and
 * respects Do Not Disturb). Imported once by the Focus widget module, so it is
 * active for the whole app run even while the island is closed.
 */
let started = false
export function startFocusAlerts(): void {
  if (started) return
  started = true
  onFocusComplete(({ finished, next, sessions }) => {
    const nextLabel = FOCUS_MODE_LABEL[next].toLowerCase()
    ingestActionPeek({
      id: `focus:${Date.now()}`,
      app: 'Focus timer',
      title: finished === 'focus' ? 'Focus session done' : 'Break is over',
      body: finished === 'focus'
        ? `${sessions} ${sessions === 1 ? 'session' : 'sessions'} today. Time for a ${nextLabel}.`
        : 'Ready for the next focus session?',
      timestamp: Date.now(),
    })
  })
}
startFocusAlerts()
