/** How long the last face unlock took, kept so Settings can show where the time went. */
export interface FaceTiming {
  at: number
  matched: boolean
  /** From the key press or mouse move to the verdict. */
  totalMs: number
  /** Waiting for the camera; 0 when it was already on. */
  cameraMs: number
  /** Waiting for the face models to load. */
  modelsMs: number
  frames: number
  backend: 'wasm' | 'webgl' | 'cpu'
  /** Where an incomplete scan spent its budget. Old diagnostic records omit it. */
  stage?: 'camera' | 'models' | 'inference' | 'verification'
  error?: string
}

const KEY = 'hover.faceUnlockTiming'

export function saveFaceTiming(timing: FaceTiming): void {
  try { localStorage.setItem(KEY, JSON.stringify(timing)) } catch { /* only a diagnostic */ }
}

export function lastFaceTiming(): FaceTiming | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null') as FaceTiming | null
    return value && typeof value.totalMs === 'number' ? value : null
  } catch {
    return null
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`

export function describeFaceTiming(timing: FaceTiming): string {
  const parts = [`${timing.matched ? 'Last unlock' : 'Last try'} took ${seconds(timing.totalMs)}`]
  if (timing.cameraMs > 0) parts.push(`camera ${seconds(timing.cameraMs)}`)
  if (timing.modelsMs > 50) parts.push(`loading ${seconds(timing.modelsMs)}`)
  parts.push(`${timing.frames} frame${timing.frames === 1 ? '' : 's'} on the ${faceBackendLabel(timing.backend)}`)
  if (!timing.matched && timing.stage) parts.push(`stopped at ${timing.stage}`)
  return parts.join(', ')
}

export const faceBackendLabel = (backend: FaceTiming['backend']): string =>
  backend === 'wasm' ? 'accelerated CPU' : backend === 'webgl' ? 'GPU' : 'CPU (slow)'
