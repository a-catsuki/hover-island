export type FileDropDestination = 'recycle' | 'beam' | null

export interface Point { x: number; y: number }
export interface TargetRect { left: number; top: number; right: number; bottom: number }
export interface FileDropTargetRects { recycle?: TargetRect; beam?: TargetRect }
export interface FileDropPreviewState { paths: string[]; count: number; target: FileDropDestination }

/** Tauri reports drag positions in physical webview pixels; DOM rectangles use CSS pixels. */
export function physicalDragPositionToCss(position: Point, devicePixelRatio: number): Point {
  const scale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  return { x: position.x / scale, y: position.y / scale }
}

/** Only the two visible target rectangles accept a drop; the center gap stays inert. */
export function fileDropDestinationAt(point: Point, rects: FileDropTargetRects): FileDropDestination {
  for (const destination of ['recycle', 'beam'] as const) {
    const rect = rects[destination]
    if (rect && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) {
      return destination
    }
  }
  return null
}

/** A release is the only action boundary, and empty native payloads are inert. */
export function fileDropActionAtRelease(destination: FileDropDestination, paths: string[]): FileDropDestination {
  return paths.length ? destination : null
}

/** Native enter/over updates preview; leave clears it without producing an action. */
export function updateFileDropPreview(
  previous: FileDropPreviewState | null,
  event: { type: 'enter' | 'over' | 'leave'; paths?: string[]; count?: number },
  destination: FileDropDestination,
): FileDropPreviewState | null {
  if (event.type === 'leave') return null
  const paths = event.type === 'enter' ? (event.paths ?? []) : (previous?.paths ?? [])
  return { paths, count: paths.length || event.count || previous?.count || 1, target: destination }
}

export function canExpandOnHover(input: {
  enabled: boolean
  alreadyOpen: boolean
  placementDragging: boolean
  fileDragging: boolean
}): boolean {
  return input.enabled && !input.alreadyOpen && !input.placementDragging && !input.fileDragging
}
