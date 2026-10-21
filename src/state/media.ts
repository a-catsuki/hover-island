import { createSignal } from 'solid-js'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { cmd, onMediaChanged, type MediaAction, type NowPlaying } from '../lib/ipc'
import { reportError } from './feedback'

const [nowPlaying, setNowPlaying] = createSignal<NowPlaying | null>(null)
const [mediaReceivedAt, setMediaReceivedAt] = createSignal(0)
const nowMs = () => typeof performance !== 'undefined' ? performance.now() : Date.now()
// The native side sends the cover as a base64 data URL (up to ~1.3 MB of text). Every <img> and
// every palette read would otherwise re-parse that string, and the heap keeps it alive. Decode it
// once into a Blob and hand the views a short blob: URL; an identical cover reuses the same URL.
let coverSource = ''
let coverUrl = ''
const staleCovers: string[] = []
function localCover(data: string | null | undefined): string | null | undefined {
  if (!data || !data.startsWith('data:') || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return data
  if (data === coverSource) return coverUrl
  try {
    const comma = data.indexOf(',')
    const mime = /^data:([^;,]+)/.exec(data)?.[1] ?? 'image/png'
    const binary = atob(data.slice(comma + 1))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
    if (coverUrl) {
      // Views swap to the new cover on the next frame; revoke the old one a little later.
      staleCovers.push(coverUrl)
      setTimeout(() => { const old = staleCovers.shift(); if (old) URL.revokeObjectURL(old) }, 20_000)
    }
    coverSource = data
    coverUrl = url
    return url
  } catch { return data }
}
const publish = (media: NowPlaying | null) => {
  setMediaReceivedAt(nowMs())
  setNowPlaying(media && media.thumbnail ? { ...media, thumbnail: localCover(media.thumbnail) } : media)
}
const [mediaBusy, setMediaBusy] = createSignal(false)
const [mediaError, setMediaError] = createSignal('')

let unlisten: UnlistenFn | null = null
let started = false

export async function subscribeMedia(onTrackChange?: (media: NowPlaying) => void): Promise<() => void> {
  if (started) return () => {}
  started = true
  setMediaError('')

  let receivedEvent = false
  let initialized = false
  let previousTrack: string | null = null
  const trackKey = (media: NowPlaying | null) => media && media.status !== 'stopped'
    ? `${media.sourceApp ?? ''}\u0000${media.title}\u0000${media.artist}`
    : null
  try {
    unlisten = await onMediaChanged((m) => {
      receivedEvent = true
      const nextTrack = trackKey(m)
      if (!initialized) {
        previousTrack = nextTrack
        initialized = true
      } else if (nextTrack !== previousTrack && m?.status === 'playing' && m.title.trim()) {
        onTrackChange?.(m)
      }
      previousTrack = nextTrack
      publish(m)
      setMediaError('')
    })
    const initial = await cmd.mediaGet()
    if (!receivedEvent) {
      previousTrack = trackKey(initial)
      initialized = true
      publish(initial)
    }
  } catch (error) {
    setMediaError(String(error))
    reportError('Could not connect to media', error)
  }

  return () => {
    unlisten?.()
    unlisten = null
    started = false
    setNowPlaying(null)
  }
}

export async function mediaControl(action: MediaAction, value?: number): Promise<void> {
  if (mediaBusy()) return
  setMediaBusy(true)
  setMediaError('')
  try { await cmd.mediaControl(action, value); publish(await cmd.mediaGet()) }
  catch (error) { setMediaError(String(error)); reportError('Media control failed', error) }
  finally { setMediaBusy(false) }
}

/**
 * Windows only reports the playback position when something changes, so the UI advances it
 * locally from the moment the value arrived. `now` is a `performance.now()` timestamp.
 */
export function interpolatedPosition(media: NowPlaying | null, receivedAt: number, now: number): number {
  const base = typeof media?.position === 'number' && Number.isFinite(media.position) ? Math.max(0, media.position) : 0
  const total = typeof media?.duration === 'number' && Number.isFinite(media.duration) ? Math.max(0, media.duration) : 0
  const advanced = media?.status === 'playing' && receivedAt > 0 ? base + Math.max(0, now - receivedAt) / 1000 : base
  return total > 0 ? Math.min(total, advanced) : advanced
}

export { nowPlaying, mediaBusy, mediaError, mediaReceivedAt }
