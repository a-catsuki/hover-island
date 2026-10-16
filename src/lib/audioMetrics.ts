/** Convert normalized 24-band output into a perceptual light drive. */
function normalizedBands(bands: readonly number[]) {
  return Array.from({ length: 24 }, (_, index) => {
    const value = bands[index] ?? 0
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
  })
}

const rms = (values: readonly number[]) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / Math.max(1, values.length))

/** A bounded log response preserves quiet movement without pinning loud tracks at full brightness. */
function dbDrive(value: number, floor = 0.0015, ceiling = 0.18) {
  if (value <= floor) return 0
  return Math.max(0, Math.min(1, Math.log(value / floor) / Math.log(ceiling / floor)))
}

export function audioMetrics(bands: readonly number[]) {
  const values = normalizedBands(bands)
  if (values.filter(value => value > 0.003).length < 3 || rms(values) <= 0.003) return { energy: 0, bass: 0 }
  return {
    energy: dbDrive(rms(values)),
    bass: dbDrive(rms(values.slice(0, 7))),
  }
}

/** Independent mid and high envelopes for palette lighting. */
export function audioFrequencyMetrics(bands: readonly number[]) {
  const values = normalizedBands(bands)
  return {
    mids: dbDrive(rms(values.slice(7, 17))),
    treble: dbDrive(rms(values.slice(17))),
  }
}

/** Ignore near-silence and isolated FFT noise while retaining quiet broadband playback. */
export function isMeaningfulSpectrum(bands: readonly number[]) {
  const values = normalizedBands(bands)
  const energy = rms(values)
  const occupiedBands = values.filter(value => value > 0.003).length
  return energy > 0.003 && occupiedBands >= 3
}

/** Bounded per-band peak tracking keeps quiet playback visible without flattening dynamics. */
export function adaptSpectrumLevels(
  bands: readonly number[],
  previousPeaks: readonly number[],
  active: boolean,
  dtSeconds = 1 / 30,
) {
  const dt = Math.max(0, Math.min(0.12, Number.isFinite(dtSeconds) ? dtSeconds : 1 / 30))
  const peaks: number[] = []
  const values = normalizedBands(bands)
  const levels = values.map((value, index) => {
    const source = active ? value : 0
    const peak = Math.max(source, (previousPeaks[index] ?? 0.008) * Math.pow(0.965, dt / (1 / 30)))
    peaks.push(peak)
    const makeup = Math.max(1, Math.min(24, 2 / Math.sqrt(Math.max(peak, 0.008))))
    const preKnee = source * makeup
    return preKnee <= 0.45
      ? preKnee
      : Math.max(0, Math.min(1, 0.45 + (preKnee - 0.45) / (1 + (preKnee - 0.45) * 1.7)))
  })
  return { levels, peaks }
}

/** Stateful, dt-based envelope and bass-onset detector shared by render surfaces. */
export function createAudioDynamics() {
  const peaks = Array(24).fill(0.008) as number[]
  const levels = Array(24).fill(0) as number[]
  let energy = 0
  let bass = 0
  let mids = 0
  let treble = 0
  let bassFloor = 0
  let previousBass = 0
  let punch = 0

  return {
    update(bands: readonly number[], active: boolean, dtSeconds: number, response = 0.8) {
      const dt = Math.max(0.001, Math.min(0.12, Number.isFinite(dtSeconds) ? dtSeconds : 1 / 30))
      const reactivity = Math.max(0, Math.min(1, Number.isFinite(response) ? response : 0.8))
      const raw = normalizedBands(bands)
      const adapted = adaptSpectrumLevels(raw, peaks, active, dt)
      adapted.peaks.forEach((value, index) => { peaks[index] = value })
      const rawMetrics = active ? audioMetrics(raw) : { energy: 0, bass: 0 }
      const frequencies = active ? audioFrequencyMetrics(raw) : { mids: 0, treble: 0 }
      const targetEnergy = rawMetrics.energy
      const attack = 0.018 + (1 - reactivity) * 0.045
      const release = 0.11 + (1 - reactivity) * 0.19
      const alpha = (tau: number) => 1 - Math.exp(-dt / tau)
      const smoothing = alpha(targetEnergy > energy ? attack : release)
      adapted.levels.forEach((value, index) => { levels[index] += (value - levels[index]) * smoothing })

      bass += (rawMetrics.bass - bass) * alpha(rawMetrics.bass > bass ? attack : release)
      mids += (frequencies.mids - mids) * alpha(frequencies.mids > mids ? attack : release)
      treble += (frequencies.treble - treble) * alpha(frequencies.treble > treble ? attack : release)
      const bassRise = bass - previousBass
      previousBass = bass
      bassFloor += (bass - bassFloor) * alpha(0.8)
      const onset = active ? Math.max(0, bass - bassFloor - 0.055, bassRise - 0.08) : 0
      punch = Math.max(punch * Math.exp(-dt / 0.19), Math.min(1, onset * 3.2))
      const energySmoothing = alpha(targetEnergy > energy ? attack : release)
      energy += (targetEnergy - energy) * energySmoothing
      return { levels: levels.slice(), energy, bass, mids, treble, punch }
    },
    reset() {
      peaks.fill(0.008)
      levels.fill(0)
      energy = 0
      bass = 0
      mids = 0
      treble = 0
      bassFloor = 0
      previousBass = 0
      punch = 0
    },
  }
}
