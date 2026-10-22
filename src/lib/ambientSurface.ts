/** Soft atmospheric graphics never need a monitor-sized backing bitmap. */
export function ambientSurfaceSize(width: number, height: number, maxWidth = 512, maxHeight = 320) {
  const w = Math.max(1, Number.isFinite(width) ? width : 1)
  const h = Math.max(1, Number.isFinite(height) ? height : 1)
  const scale = Math.min(1, maxWidth / w, maxHeight / h)
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)), scale }
}
