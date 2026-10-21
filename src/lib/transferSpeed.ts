/** Shared formatting and speed sampling for Beam transfer rows. Pure so it can be tested without the DOM. */

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1 }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function formatSpeed(bytesPerSecond: number | undefined): string {
  return bytesPerSecond && Number.isFinite(bytesPerSecond) && bytesPerSecond >= 1024 ? `${formatBytes(bytesPerSecond)}/s` : ''
}

export function formatRemaining(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 5) return 'a few seconds left'
  if (seconds < 90) return `${Math.round(seconds)} sec left`
  if (seconds < 5400) return `${Math.round(seconds / 60)} min left`
  return `${Math.round(seconds / 3600)} hr left`
}

export const percentOf = (done: number, total: number): number =>
  total > 0 ? Math.max(0, Math.min(100, Math.round(done / total * 100))) : 0

interface Sample { bytes: number; at: number; speed: number }

/**
 * Smooths bytes-over-time into a speed per transfer. Samples closer than `minGapMs`
 * are ignored so a burst of progress events cannot make the number jump around.
 */
export function createSpeedTracker(minGapMs = 400) {
  const samples = new Map<string, Sample>()
  return {
    /** Records progress and returns the current smoothed speed in bytes per second (0 when unknown). */
    sample(id: string, bytes: number, at: number): number {
      const previous = samples.get(id)
      if (!previous || bytes < previous.bytes) {
        samples.set(id, { bytes, at, speed: 0 })
        return 0
      }
      const elapsed = at - previous.at
      if (elapsed < minGapMs) return previous.speed
      const instant = (bytes - previous.bytes) / elapsed * 1000
      const speed = previous.speed > 0 ? previous.speed * 0.6 + instant * 0.4 : instant
      samples.set(id, { bytes, at, speed })
      return speed
    },
    /** Forget transfers that are no longer being reported. */
    keep(ids: Iterable<string>): void {
      const live = new Set(ids)
      for (const id of samples.keys()) if (!live.has(id)) samples.delete(id)
    },
  }
}
