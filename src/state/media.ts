import { createSignal } from 'solid-js'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { cmd, onMediaChanged, type MediaAction, type NowPlaying } from '../lib/ipc'
import { reportError } from './feedback'

const [nowPlaying, setNowPlaying] = createSignal<NowPlaying | null>(null)
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
      setNowPlaying(m)
      setMediaError('')
    })
    const initial = await cmd.mediaGet()
    if (!receivedEvent) {
      previousTrack = trackKey(initial)
      initialized = true
      setNowPlaying(initial)
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
  try { await cmd.mediaControl(action, value); setNowPlaying(await cmd.mediaGet()) }
  catch (error) { setMediaError(String(error)); reportError('Media control failed', error) }
  finally { setMediaBusy(false) }
}

export { nowPlaying, mediaBusy, mediaError }
