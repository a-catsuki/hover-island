import type { ResetAnnouncement } from './ipc'

export function effectiveResetStatus(event: ResetAnnouncement, now = Date.now()): ResetAnnouncement['status'] {
  return event.status === 'expected' && event.landingAt != null && event.landingAt <= now
    ? 'awaiting_confirmation' : event.status
}
