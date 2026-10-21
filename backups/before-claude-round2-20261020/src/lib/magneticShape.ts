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
