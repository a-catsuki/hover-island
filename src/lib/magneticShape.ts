/** A tethered edge stays flush to the display while the free edge follows the pointer. */
export function magneticNotchPath(viewWidth: number, viewHeight: number, width: number, height: number, edge: 'top'|'bottom'|'left'|'right', x: number, y: number, radius?: number): string {
  const side = edge === 'left' || edge === 'right'
  const span = side ? height : width
  const depth = side ? width : height
  const clamp = (value: number) => Number.isFinite(value) ? Math.max(-6, Math.min(6, value)) : 0
  const along = clamp(side ? y : x) * .6
  const normal = clamp(edge === 'top' ? y : edge === 'bottom' ? -y : edge === 'left' ? x : -x) * .4
  const r = Math.max(0, Math.min(span / 2, depth / 2, radius ?? Math.min(14, depth * .28)))
  const floor = Math.max(r * 2, depth + normal)
  const curve = .5522847498 * r
  const start = ((side ? viewHeight : viewWidth) - span) / 2
  const point = (u: number, v: number) => {
    const coords = edge === 'top' ? [start + u, v] : edge === 'bottom' ? [start + u, viewHeight - v] : edge === 'left' ? [v, start + u] : [viewWidth - v, start + u]
    return coords.map(value => value.toFixed(2)).join(' ')
  }
  // A symmetric MacBook-style silhouette at rest. Separate side and quarter-
  // circle segments preserve vertical tangents instead of cutting off a corner.
  // Only the free edge yields; the attachment remains flush with the display.
  return `path("M ${point(0,0)} L ${point(span,0)} C ${point(span,depth*.35)} ${point(span+along,floor*.35)} ${point(span+along,floor-r)} C ${point(span+along,floor-r+curve)} ${point(span+along-r+curve,floor)} ${point(span+along-r,floor)} L ${point(along+r,floor)} C ${point(along+r-curve,floor)} ${point(along,floor-r+curve)} ${point(along,floor-r)} C ${point(along,floor*.35)} ${point(0,depth*.35)} ${point(0,0)} Z")`
}

/**
 * The island silhouette as a CSS inset() clip: flush to the display on its docked edge,
 * centred along it, with rounded corners on the free edge only. It is the same shape as
 * magneticNotchPath at rest, but inset() is a plain rounded-rect clip, which browsers
 * paint far more cheaply than a path() mask on every spring frame.
 */
export function edgeInsetClip(viewWidth: number, viewHeight: number, width: number, height: number, edge: 'top'|'bottom'|'left'|'right', radius?: number): string {
  const side = edge === 'left' || edge === 'right'
  const span = Math.max(0, Math.min(side ? height : width, side ? viewHeight : viewWidth))
  const depth = Math.max(0, Math.min(side ? width : height, side ? viewWidth : viewHeight))
  const r = Math.max(0, Math.min(span / 2, depth / 2, radius ?? Math.min(14, depth * .28)))
  const px = (value: number) => `${Math.max(0, value).toFixed(2)}px`
  const gap = px(((side ? viewHeight : viewWidth) - span) / 2)
  const free = px((side ? viewWidth : viewHeight) - depth)
  const round = px(r)
  if (edge === 'top') return `inset(0 ${gap} ${free} ${gap} round 0 0 ${round} ${round})`
  if (edge === 'bottom') return `inset(${free} ${gap} 0 ${gap} round ${round} ${round} 0 0)`
  if (edge === 'left') return `inset(${gap} ${free} ${gap} 0 round 0 ${round} ${round} 0)`
  return `inset(${gap} 0 ${gap} ${free} round ${round} 0 0 ${round})`
}

/**
 * The collapsed top notch: a short pill whose top corners flare outward into the
 * display edge (concave "ears", like a hardware notch), with softer bottom corners.
 * `width` includes the ears, so the visible body is `width - 2 * ear`.
 */
export function earNotchPath(viewWidth: number, width: number, height: number, ear: number, radius: number): string {
  const span = Math.max(0, Math.min(width, viewWidth))
  const e = Math.max(0, Math.min(ear, span / 4, height / 2))
  const r = Math.max(0, Math.min(radius, (span - e * 2) / 2, height - e))
  const k = .5522847498 * r
  const x0 = (viewWidth - span) / 2
  const n = (value: number) => value.toFixed(2)
  const p = (u: number, v: number) => `${n(x0 + u)} ${n(v)}`
  return `path("M ${p(0, 0)} L ${p(span, 0)} Q ${p(span - e, 0)} ${p(span - e, e)} L ${p(span - e, height - r)} C ${p(span - e, height - r + k)} ${p(span - e - r + k, height)} ${p(span - e - r, height)} L ${p(e + r, height)} C ${p(e + r - k, height)} ${p(e, height - r + k)} ${p(e, height - r)} L ${p(e, e)} Q ${p(e, 0)} ${p(0, 0)} Z")`
}
