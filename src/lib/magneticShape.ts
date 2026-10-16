/** A tethered edge stays flush to the display while the free edge follows the pointer. */
export function magneticNotchPath(viewWidth: number, viewHeight: number, width: number, height: number, edge: 'top'|'bottom'|'left'|'right', x: number, y: number): string {
  const side = edge === 'left' || edge === 'right'
  const span = side ? height : width
  const depth = side ? width : height
  const clamp = (value: number) => Number.isFinite(value) ? Math.max(-6, Math.min(6, value)) : 0
  const along = clamp(side ? y : x)
  const normal = clamp(edge === 'top' ? y : edge === 'bottom' ? -y : edge === 'left' ? x : -x)
  const r = Math.min(20, depth * .42)
  const floor = Math.max(r * 2, depth + normal * .7)
  const start = ((side ? viewHeight : viewWidth) - span) / 2
  const point = (u: number, v: number) => {
    const coords = edge === 'top' ? [start + u, v] : edge === 'bottom' ? [start + u, viewHeight - v] : edge === 'left' ? [v, start + u] : [viewWidth - v, start + u]
    return coords.map(value => value.toFixed(2)).join(' ')
  }
  // Independent shoulder and belly curves make the material yield, rather than
  // translating a rigid rounded rectangle or shaking the contents on their own.
  return `path("M ${point(0,0)} L ${point(span,0)} C ${point(span,depth*.35)} ${point(span+along,floor-r)} ${point(span+along-r,floor)} C ${point(span*.65+along,floor+Math.abs(along)*.1)} ${point(span*.35+along,floor)} ${point(r+along,floor)} C ${point(along,floor)} ${point(0,depth*.5)} ${point(0,0)} Z")`
}
