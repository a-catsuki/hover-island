/** Pure helpers for timed lyrics: parsing, the current-line lookup and the sync lead. */
export interface LyricLine {
  /** Playback time in seconds. */
  at: number
  text: string
}

/**
 * Lines switch a little before their stamp. Windows reports the position in coarse steps and
 * the UI paints a frame later, so a small lead keeps the highlight on the beat of the voice.
 */
export const LYRICS_LEAD_SECONDS = 0.25

const MAX_LINES = 500

/** Strips enhanced-LRC word stamps such as `<00:12.50>`. */
const stripWordStamps = (text: string) => text.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').replace(/\s+/g, ' ').trim()

/**
 * Parses LRC text the same way the native side does: several stamps per line, `[mm:ss.xx]`,
 * `[mm:ss.xxx]`, `[mm:ss:xx]`, `[mm:ss]`, and `[offset:ms]` (positive shows lyrics earlier).
 * Blank stamped lines stay as gaps so a line does not hang on through an instrumental.
 */
export function parseLrc(input: string, duration = Number.POSITIVE_INFINITY): LyricLine[] {
  let offset = 0
  for (const raw of input.split(/\r?\n/)) {
    const match = /^\s*\[offset:\s*([+-]?\d+(?:\.\d+)?)\s*\]\s*$/i.exec(raw)
    if (match) offset = Number(match[1]) / 1000
  }
  const lines: LyricLine[] = []
  for (const raw of input.split(/\r?\n/)) {
    let rest = raw.trim()
    const stamps: number[] = []
    for (;;) {
      const match = /^\[([^\]]*)\]/.exec(rest)
      if (!match) break
      rest = rest.slice(match[0].length)
      const parts = /^(\d+):(\d+(?:[.:]\d+)?)$/.exec(match[1].trim())
      if (!parts) continue
      const seconds = Number(parts[2].replace(':', '.'))
      const at = Math.max(0, Number(parts[1]) * 60 + seconds - offset)
      if (Number.isFinite(at) && at <= duration + 2) stamps.push(at)
    }
    if (!stamps.length) continue
    const text = stripWordStamps(rest)
    if (text.length > 360) continue
    for (const at of stamps) if (lines.length < MAX_LINES) lines.push({ at, text })
  }
  lines.sort((a, b) => a.at - b.at)
  const out: LyricLine[] = []
  for (const line of lines) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.at - line.at) < 0.01 && last.text === line.text) continue
    if (!last && !line.text) continue
    if (last && !last.text && !line.text) continue
    out.push(line)
  }
  return out
}

/** Index of the line that is current at `position` (seconds), or -1 before the first line. Binary search. */
export function activeLineIndex(lines: ReadonlyArray<{ at: number }>, position: number, lead = LYRICS_LEAD_SECONDS): number {
  if (!lines.length || !Number.isFinite(position)) return -1
  const at = position + lead
  let low = 0
  let high = lines.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (lines[middle].at <= at) { found = middle; low = middle + 1 } else high = middle - 1
  }
  return found
}

/**
 * 0..1 progress through line `index`: time since its stamp over the gap to the next line.
 * Long gaps (an instrumental after the line) are capped so the fill tracks the singing, not the silence.
 */
export function lineProgress(lines: ReadonlyArray<{ at: number; text?: string }>, index: number, position: number, duration = 0, lead = LYRICS_LEAD_SECONDS): number {
  const line = lines[index]
  if (!line || !Number.isFinite(position)) return 0
  const next = lines[index + 1]?.at ?? (duration > line.at ? duration : line.at + 4)
  const chars = Math.max(1, (line.text ?? '').length)
  // Roughly 14 characters a second when sung, never shorter than a second.
  const sung = Math.max(1, Math.min(next - line.at, chars / 14 + 0.6))
  return Math.max(0, Math.min(1, (position + lead - line.at) / sung))
}

/** Which untimed line to centre: playback progress mapped across the lines. */
export function untimedLineIndex(lineCount: number, position: number, duration: number): number {
  if (lineCount <= 0 || !(duration > 0)) return 0
  return Math.min(lineCount - 1, Math.max(0, Math.floor((position / duration) * lineCount)))
}

/** Identity of a track for lyrics: a result is only shown while this still matches. */
export function lyricsTrackKey(media: { title?: string; artist?: string; album?: string | null; duration?: number | null } | null | undefined): string | null {
  const title = media?.title?.trim()
  const artist = media?.artist?.trim()
  // Some players (Apple Music) report no length; lyrics still match on names.
  const duration = typeof media?.duration === 'number' && Number.isFinite(media.duration) && media.duration >= 1 ? media.duration : 0
  if (!title || !artist) return null
  return `${title}\u0000${artist}\u0000${media?.album ?? ''}\u0000${Math.round(duration)}`
}
