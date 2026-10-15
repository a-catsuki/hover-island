/** Convert the native 24-band spectrum into a perceptually useful ambient drive. */
export function audioMetrics(bands: readonly number[]) {
  const values = Array.from({ length: 24 }, (_, index) => {
    const value = bands[index] ?? 0
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
  })
  const rms = (values: number[]) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / Math.max(1, values.length))
  const all = rms(values)
  const bass = rms(values.slice(0, 7))
  // The native spectrum is intentionally normalized for fine equalizer detail;
  // give broad ambient surfaces a wider, still bounded response window.
  return {
    // WASAPI's FFT bins are deliberately conservative. A fixed linear gain made
    // ordinary listening look almost motionless; a gentle perceptual curve gives
    // quiet passages room to move while the floor still rejects endpoint noise.
    energy: Math.max(0, Math.min(1, Math.sqrt(Math.max(0, all - 0.012)) * 2.6)),
    bass: Math.max(0, Math.min(1, (bass - 0.012) * 9)),
  }
}

/** Perceptually lifted frequency groups for fluid ambient-light fields. */
export function audioFrequencyMetrics(bands: readonly number[]) {
  const values = Array.from({ length: 24 }, (_, index) => {
    const value = bands[index] ?? 0
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
  })
  const rms = (group: number[]) => Math.sqrt(group.reduce((sum, value) => sum + value * value, 0) / Math.max(1, group.length))
  const mid = rms(values.slice(7, 17))
  const treble = rms(values.slice(17))
  return {
    mids: Math.max(0, Math.min(1, Math.sqrt(Math.max(0, mid - 0.01)) * 2.7)),
    treble: Math.max(0, Math.min(1, Math.sqrt(Math.max(0, treble - 0.01)) * 2.7)),
  }
}
