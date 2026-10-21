import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { Music, Pause, Play, SkipBack, SkipForward } from 'lucide-solid'
import { interpolatedPosition, mediaControl, mediaError, mediaReceivedAt, nowPlaying } from '../../state/media'
import { settings } from '../../state/settings'
import type { LyricsLine, WidgetConfig } from '../../lib/ipc'
import Visualizer from './Visualizer'
import LiveBars from './LiveBars'
import { normalizeVisualizerStyle } from '../../lib/visualizerStyles'
import { getAlbumPalette, type AlbumPalette } from '../../lib/albumPalette'
import './MediaView.css'
import { open } from '../../state/ui'
import { browserPreview, cmd } from '../../lib/ipc'

const formatTime = (seconds: number) => {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  return `${Math.floor(safe / 60)}:${Math.floor(safe % 60).toString().padStart(2, '0')}`
}

/** Single-line text that scrolls only when it does not fit. */
function Marquee(props: { text: string; class?: string }) {
  let box: HTMLSpanElement | undefined
  let inner: HTMLSpanElement | undefined
  const [shift, setShift] = createSignal(0)
  const measure = () => {
    if (!box || !inner) return
    const overflow = inner.scrollWidth - box.clientWidth
    setShift(overflow > 2 ? overflow + 14 : 0)
  }
  onMount(() => {
    measure()
    if (typeof ResizeObserver === 'undefined' || !box) return
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    onCleanup(() => observer.disconnect())
  })
  createEffect(() => { props.text; queueMicrotask(measure) })
  return (
    <span
      ref={box}
      class={`marquee ${props.class ?? ''}`}
      classList={{ 'marquee--on': shift() > 0 }}
      style={{ '--shift': `${-shift()}px`, '--dur': `${Math.max(7, shift() / 20 + 5).toFixed(1)}s` }}
      title={props.text}
    >
      <span ref={inner} class="marquee__text">{props.text}</span>
    </span>
  )
}

export default function MediaView(props: {
  compact?: boolean
  showLyrics?: boolean
  size?: WidgetConfig['size']
  onToggleLyrics?: () => void
}) {
  const [scrubbing, setScrubbing] = createSignal(false)
  const [scrub, setScrub] = createSignal(0)
  const [now, setNow] = createSignal(performance.now())
  const [palette, setPalette] = createSignal<AlbumPalette | null>(null)
  const [box, setBox] = createSignal({ w: 0, h: 0 })
  const [lyrics, setLyrics] = createSignal<LyricsLine[]>([])
  const [lyricsStatus, setLyricsStatus] = createSignal<'idle' | 'loading' | 'ok' | 'not_found' | 'no_timed_lyrics' | 'rate_limited' | 'unavailable' | 'preview'>('idle')
  const [lyricsRetryAt, setLyricsRetryAt] = createSignal(0)
  const [lyricsClock, setLyricsClock] = createSignal(Date.now())
  const lyricsWait = () => Math.max(0, Math.ceil((lyricsRetryAt() - lyricsClock()) / 1000))
  const [lyricsRetry, setLyricsRetry] = createSignal(0)
  const [lyricsCanFit, setLyricsCanFit] = createSignal(false)
  let mediaElement: HTMLDivElement | undefined
  let mediaResize: ResizeObserver | undefined
  let lyricsRequest = 0
  let lastLyricsKey: string | null = null

  const media = () => nowPlaying()
  const active = createMemo(() => {
    const current = media()
    return current && current.status !== 'stopped' ? current : null
  })
  const playing = () => media()?.status === 'playing'
  const duration = () => {
    const value = media()?.duration
    return Math.max(0, typeof value === 'number' && Number.isFinite(value) ? value : 0)
  }
  const seekMin = () => {
    const value = media()?.seekMin
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(duration(), Math.max(0, value)) : 0
  }
  const seekMax = () => {
    const value = media()?.seekMax
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(duration(), Math.max(seekMin(), value)) : duration()
  }
  const canSeek = () => Boolean(media()?.canSeek && duration() > 0 && seekMax() > seekMin())
  // Windows reports the position only when it changes; advance it locally while playing.
  const position = () => interpolatedPosition(media(), mediaReceivedAt(), now())
  const shownPosition = () => scrubbing() ? scrub() : position()
  const progress = () => duration() ? Math.min(100, Math.max(0, (shownPosition() / duration()) * 100)) : 0

  createEffect(() => {
    if (!playing() || !open() || scrubbing()) return
    setNow(performance.now())
    const timer = setInterval(() => setNow(performance.now()), 250)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    const src = active()?.thumbnail
    let current = true
    void getAlbumPalette(src).then((value) => { if (current) setPalette(value) })
    onCleanup(() => { current = false })
  })
  const accent = () => palette()?.dominant ?? ''

  const attachMediaElement = (element: HTMLDivElement) => {
    mediaElement = element
    mediaResize?.disconnect()
    const measure = () => {
      setLyricsCanFit(element.clientHeight >= 240)
      setBox({ w: element.clientWidth, h: element.clientHeight })
    }
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      mediaResize = new ResizeObserver(measure)
      mediaResize.observe(element)
    }
  }

  const lyricsEnabled = () => Boolean(props.showLyrics && props.size !== 'compact' && lyricsCanFit() && open())
  const activeLyric = createMemo(() => {
    const lines = lyrics()
    if (!lines.length) return -1
    const at = position()
    let index = -1
    for (let cursor = 0; cursor < lines.length; cursor++) {
      if (lines[cursor].at > at) break
      index = cursor
    }
    return index
  })

  createEffect(() => {
    const current = active()
    const eligible = lyricsEnabled() && current && current.title?.trim() && current.artist?.trim()
      && typeof current.duration === 'number' && Number.isFinite(current.duration) && current.duration >= 1
    if (!eligible) {
      lastLyricsKey = null
      lyricsRequest++
      setLyrics([])
      setLyricsStatus('idle')
      return
    }
    const key = `${current.title.trim()}\u0000${current.artist.trim()}\u0000${current.album ?? ''}\u0000${current.duration}\u0000${lyricsRetry()}`
    if (key === lastLyricsKey) return
    lastLyricsKey = key
    const request = ++lyricsRequest
    if (browserPreview) {
      setLyrics([])
      setLyricsStatus('preview')
      return
    }
    setLyrics([])
    setLyricsStatus('loading')
    void cmd.lyricsLookup(current.title, current.artist, current.album ?? null, current.duration!).then((result) => {
      if (request !== lyricsRequest) return
      setLyrics(result.status === 'ok' ? result.lines : [])
      setLyricsRetryAt(result.status === 'rate_limited' ? Date.now() + (result.retryAfterSeconds ?? 60) * 1000 : 0)
      setLyricsClock(Date.now())
      setLyricsStatus(result.status === 'invalid_track' ? 'not_found' : result.status)
    }).catch(() => {
      if (request === lyricsRequest) setLyricsStatus('unavailable')
    })
  })

  createEffect(() => {
    if (lyricsStatus() !== 'rate_limited' || !open()) return
    setLyricsClock(Date.now())
    const clock = setInterval(() => setLyricsClock(Date.now()), 1000)
    onCleanup(() => clearInterval(clock))
  })

  createEffect(() => {
    const index = activeLyric()
    if (index < 0 || !mediaElement) return
    const target = mediaElement.querySelector<HTMLElement>(`[data-lyrics-index="${index}"]`)
    target?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  })

  onCleanup(() => {
    lyricsRequest++
    mediaResize?.disconnect()
  })

  createEffect(() => {
    media()?.title
    setScrubbing(false)
  })

  const source = () => media()?.sourceApp?.replace(/_.*$/, '').split('.').pop() || 'Windows media'
  const sourceName = () => {
    const raw = source()
    return raw.charAt(0).toUpperCase() + raw.slice(1)
  }
  const style = () => normalizeVisualizerStyle(settings.visualizer.style)
  const barsOn = () => settings.modules.visualizer && style() !== 'off'
  // The big visualiser is opt-in: any style other than the default compact bars.
  const largeViz = () => barsOn() && style() !== 'ambient' && open()
  const artSize = () => {
    const room = box().h - 224 - (largeViz() ? 104 : 0)
    return Math.floor(Math.min(box().w - 8, room, 236))
  }
  const tallLayout = () => !lyricsEnabled() && artSize() >= 132

  const Lyrics = () => (
    <section class="media__lyrics" aria-label="Synchronized lyrics">
      <Show when={lyricsStatus() === 'ok' && lyrics().length} fallback={
        <p class="media__lyrics-state" role={lyricsStatus() === 'unavailable' ? 'status' : undefined}>
          {lyricsStatus() === 'loading' ? 'Looking for synced lyrics…'
            : lyricsStatus() === 'not_found' ? 'No timed lyrics found for this track.'
            : lyricsStatus() === 'no_timed_lyrics' ? 'Timed lyrics are not available for this track.'
            : lyricsStatus() === 'rate_limited' ? lyricsWait() > 0 ? `Lyrics lookup is busy. Try again in ${lyricsWait()} seconds.` : 'Ready to retry lyrics.'
            : lyricsStatus() === 'unavailable' ? 'Lyrics are temporarily unavailable.'
            : lyricsStatus() === 'preview' ? 'Synced lyrics are available in the desktop app.'
            : 'No lyrics to show.'}
        </p>
      }>
        <div class="media__lyrics-lines" aria-live="off" aria-atomic="false">
          {lyrics().map((line, index) => <p
            class="media__lyrics-line"
            classList={{ 'media__lyrics-line--active': activeLyric() === index }}
            data-lyrics-index={index}
          >{line.text}</p>)}
        </div>
      </Show>
      <Show when={lyricsStatus() === 'unavailable' || lyricsStatus() === 'rate_limited'}>
        <button type="button" class="media__lyrics-retry" disabled={lyricsStatus() === 'rate_limited' && lyricsWait() > 0} onClick={() => setLyricsRetry(value => value + 1)}>Try again</button>
      </Show>
      <a class="media__lyrics-source" href="https://lrclib.net" target="_blank" rel="noreferrer">Timed lyrics · LRCLIB</a>
    </section>
  )

  return (
    <Show
      when={active()}
      fallback={
        <div ref={attachMediaElement} class="media media--empty">
          <div class="media__empty-message">
            <span class="media__empty-icon"><Music size={22} strokeWidth={1.75} aria-hidden="true" /></span>
            <strong>Nothing playing</strong>
            <small>Play something in any app.</small>
          </div>
        </div>
      }
    >
      {(current) => (
        <div
          ref={attachMediaElement}
          class="media"
          classList={{ 'media--tall': tallLayout(), 'media--playing': playing(), 'media--has-accent': Boolean(accent()) }}
          style={{ '--media-accent': accent() || 'rgba(255,255,255,0.5)', '--art': `${tallLayout() ? Math.max(96, artSize()) : 76}px` }}
        >
          <div class="media__wash" aria-hidden="true" />
          <div class="media__head">
            <div class="media__art">
              <Show when={current().thumbnail} fallback={<Music size={28} strokeWidth={1.4} />}>
                {(src) => <img src={src()} alt="Album artwork" draggable={false} />}
              </Show>
            </div>
            <div class="media__meta">
              <span class="media__source"><i class="media__source-glyph" aria-hidden="true">{sourceName().charAt(0)}</i>{sourceName()}</span>
              <Marquee class="media__title" text={current().title || 'Untitled'} />
              <Marquee class="media__artist" text={current().artist || 'Unknown artist'} />
            </div>
            <Show when={barsOn()}>
              <LiveBars class="media__bars" playing={playing()} color={accent() || '#ffffff'} size={22} barWidth={4} bars={5} />
            </Show>
          </div>

          <Show when={largeViz()}>
            <div class="media__stage">
              <Visualizer title={current().title} style={settings.visualizer.style} intensity={settings.visualizer.intensity} reactivity={settings.visualizer.reactivity} showModeLabel={false} />
            </div>
          </Show>
          <Show when={lyricsEnabled()}><Lyrics /></Show>

          <div class="media__seek" classList={{ 'media__seek--disabled': !canSeek() }}>
            <div class="media__track" style={{ '--progress': `${progress()}%` }}>
              <div class="media__fill" />
              <input
                class="media__range"
                aria-label="Seek playback"
                type="range"
                min={seekMin()}
                max={seekMax() || 1}
                step="0.25"
                disabled={!canSeek()}
                value={Math.min(seekMax(), Math.max(seekMin(), shownPosition()))}
                onInput={(event) => {
                  setScrub(Math.min(seekMax(), Math.max(seekMin(), event.currentTarget.valueAsNumber)))
                  setScrubbing(true)
                }}
                onChange={(event) => {
                  void mediaControl('seek', event.currentTarget.valueAsNumber).finally(() => setScrubbing(false))
                }}
                data-no-drag
              />
            </div>
            <div class="media__times">
              <span>{formatTime(shownPosition())}</span>
              <Show when={duration() > 0}><span>{`-${formatTime(Math.max(0, duration() - shownPosition()))}`}</span></Show>
            </div>
          </div>

          <div class="media__controls">
            <div class="media__transport">
              <button class="media__btn" disabled={!current().canSkipPrevious} aria-label="Previous track" onClick={() => void mediaControl('previous')} data-no-drag>
                <SkipBack size={28} fill="currentColor" strokeWidth={1.5} />
              </button>
              <button
                class="media__btn media__btn--play"
                disabled={playing() ? !current().canPause : !current().canPlay}
                aria-label={playing() ? 'Pause' : 'Play'}
                onClick={() => void mediaControl('toggle')}
                data-no-drag
              >
                <Show when={playing()} fallback={<Play size={34} fill="currentColor" strokeWidth={1.5} />}>
                  <Pause size={34} fill="currentColor" strokeWidth={1.5} />
                </Show>
              </button>
              <button class="media__btn" disabled={!current().canSkipNext} aria-label="Next track" onClick={() => void mediaControl('next')} data-no-drag>
                <SkipForward size={28} fill="currentColor" strokeWidth={1.5} />
              </button>
            </div>
            <Show when={props.size !== 'compact' && props.onToggleLyrics}>
              <button
                type="button"
                class="media__pill"
                aria-pressed={Boolean(props.showLyrics)}
                disabled={!lyricsCanFit()}
                title={lyricsCanFit() ? 'Show synchronized lyrics' : 'Expand this widget to make room for lyrics'}
                onClick={props.onToggleLyrics}
                data-no-drag
              >Lyrics</button>
            </Show>
          </div>
          <Show when={mediaError()}>
            <p class="inline-error" role="alert">{mediaError()}</p>
          </Show>
        </div>
      )}
    </Show>
  )
}
