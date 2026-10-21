import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { Music, Pause, Play, SkipBack, SkipForward, TextQuote } from 'lucide-solid'
import { interpolatedPosition, mediaControl, mediaError, mediaReceivedAt, nowPlaying } from '../../state/media'
import { settings } from '../../state/settings'
import type { LyricsLine, WidgetConfig } from '../../lib/ipc'
import Visualizer from './Visualizer'
import { normalizeVisualizerStyle } from '../../lib/visualizerStyles'
import { activeLineIndex, lineProgress, lyricsTrackKey, parseLrc, untimedLineIndex } from '../../lib/lyricsSync'
import { getAlbumPalette, type AlbumPalette } from '../../lib/albumPalette'
import './MediaView.css'
import { open } from '../../state/ui'
import { browserPreview, cmd } from '../../lib/ipc'

/**
 * Card shapes. `auto` follows the measured box; the others are forced by the widget's shape option.
 * wide = artwork left, everything else in one column; tall = big artwork on top; square = artwork beside the title.
 */
export const MEDIA_ORIENTATIONS = ['auto', 'wide', 'tall', 'square'] as const
export type MediaOrientation = typeof MEDIA_ORIENTATIONS[number]
export type MediaLayout = Exclude<MediaOrientation, 'auto'>

/** Wider than this (width / height) reads as landscape, narrower than the lower bound as portrait. */
const WIDE_RATIO = 2
const TALL_RATIO = 0.92

export function mediaLayoutFor(width: number, height: number, forced: MediaOrientation = 'auto'): MediaLayout {
  if (forced !== 'auto') return forced
  if (width <= 0 || height <= 0) return 'square'
  const ratio = width / height
  return ratio >= WIDE_RATIO ? 'wide' : ratio <= TALL_RATIO ? 'tall' : 'square'
}

// Browser preview has no native lookup, so it shows a few original sample lines to exercise the layout.
const PREVIEW_LRC = [
  '[01:10.00]Morning light on the window glass', '[01:15.50]Coffee cooling while the hours pass', '[01:21.00]Nobody calling, nowhere to be',
  '[01:27.00]Just a walk in the quiet and me', '[01:34.00]Shadows stretch across the street', '[01:39.50]Slow footsteps keeping time with my feet',
  '[01:46.00]', '[01:52.00]And the world goes soft at the edges', '[01:58.00]When the day has nothing left to say',
  '[02:05.00]So I carry on, easy and slow', '[02:11.00]Wherever the quiet wants to go',
].join('\n')

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
  /** Forces a layout. Default `auto`: follows the card's own aspect ratio. */
  shape?: MediaOrientation
  onToggleLyrics?: () => void
}) {
  const [scrubbing, setScrubbing] = createSignal(false)
  const [scrub, setScrub] = createSignal(0)
  const [now, setNow] = createSignal(performance.now())
  const [palette, setPalette] = createSignal<AlbumPalette | null>(null)
  const [box, setBox] = createSignal({ w: 0, h: 0 })
  const [lyrics, setLyrics] = createSignal<LyricsLine[]>([])
  const [lyricsTimed, setLyricsTimed] = createSignal(true)
  const [lyricsFor, setLyricsFor] = createSignal<string | null>(null)
  const [lyricsShift, setLyricsShift] = createSignal(0)
  const [lyricsAnimate, setLyricsAnimate] = createSignal(false)
  const [lyricsStatus, setLyricsStatus] = createSignal<'idle' | 'loading' | 'ok' | 'not_found' | 'no_timed_lyrics' | 'rate_limited' | 'unavailable' | 'preview'>('idle')
  const [lyricsRetryAt, setLyricsRetryAt] = createSignal(0)
  const [lyricsClock, setLyricsClock] = createSignal(Date.now())
  const lyricsWait = () => Math.max(0, Math.ceil((lyricsRetryAt() - lyricsClock()) / 1000))
  const [lyricsRetry, setLyricsRetry] = createSignal(0)
  let mediaElement: HTMLDivElement | undefined
  let mediaResize: ResizeObserver | undefined
  let lyricsRequest = 0
  let lastLyricsKey: string | null = null
  let linesBox: HTMLDivElement | undefined
  let linesTrack: HTMLDivElement | undefined

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
    // Lyrics need a finer clock than the progress bar so lines change on time.
    const timer = setInterval(() => setNow(performance.now()), lyricsReady() && lyricsTimed() ? 100 : 250)
    onCleanup(() => clearInterval(timer))
  })

  // A new position report (seek, pause, track change) restarts the local clock at once.
  createEffect(() => {
    media()
    mediaReceivedAt()
    setNow(performance.now())
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
      setBox({ w: element.clientWidth, h: element.clientHeight })
    }
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      mediaResize = new ResizeObserver(measure)
      mediaResize.observe(element)
    }
  }

  const layout = createMemo<MediaLayout>(() => mediaLayoutFor(box().w, box().h, props.shape))
  // Wide cards keep lyrics in the right column, so they need less height than stacked cards.
  const lyricsCanFit = () => box().h >= (layout() === 'wide' ? 190 : 280)
  const lyricsEnabled = () => Boolean(props.showLyrics && lyricsCanFit() && open())
  const trackKey = createMemo(() => lyricsTrackKey(active()))
  // Lyrics only count while they belong to the track on screen; a stale result is never shown.
  const lyricsReady = () => lyricsStatus() === 'ok' && lyrics().length > 0 && lyricsFor() !== null && lyricsFor() === trackKey()
  const activeLyric = createMemo(() => {
    if (!lyricsReady()) return -1
    return lyricsTimed()
      ? activeLineIndex(lyrics(), position())
      : untimedLineIndex(lyrics().length, position(), duration())
  })
  // How far through the current line the singer is, for the karaoke fill.
  const activeFill = () => {
    const index = activeLyric()
    if (!lyricsTimed() || index < 0) return 0
    return lineProgress(lyrics(), index, position(), duration())
  }

  createEffect(() => {
    const current = active()
    const eligible = lyricsEnabled() && current && current.title?.trim() && current.artist?.trim()
    if (!eligible) {
      lastLyricsKey = null
      lyricsRequest++
      setLyrics([])
      setLyricsFor(null)
      setLyricsStatus('idle')
      return
    }
    const trackId = lyricsTrackKey(current)
    const key = `${trackId}\u0000${lyricsRetry()}`
    if (key === lastLyricsKey) return
    lastLyricsKey = key
    const request = ++lyricsRequest
    // Clear first: the previous track's lines must never show against this track.
    setLyrics([])
    setLyricsFor(null)
    setLyricsTimed(true)
    if (browserPreview) {
      setLyrics(parseLrc(PREVIEW_LRC, current.duration || 3600))
      setLyricsFor(trackId)
      setLyricsStatus('ok')
      return
    }
    setLyricsStatus('loading')
    void cmd.lyricsLookup(current.title, current.artist, current.album ?? null, current.duration && Number.isFinite(current.duration) ? current.duration : 0).then((result) => {
      if (request !== lyricsRequest) return
      setLyricsTimed(result.timed !== false)
      setLyrics(result.status === 'ok' ? result.lines : [])
      setLyricsFor(result.status === 'ok' ? trackId : null)
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

  // Keeps the current line at about 35% of the lyrics height. Nothing here is user-scrollable.
  const placeLyrics = () => {
    if (!linesBox || !linesTrack || !lyricsReady()) return
    const height = linesBox.clientHeight
    linesBox.style.setProperty('--lyrics-h', `${height}px`)
    const index = activeLyric()
    if (lyricsTimed()) {
      const line = index >= 0 ? linesTrack.children[index] as HTMLElement | undefined : undefined
      setLyricsShift(line ? Math.max(0, line.offsetTop + line.offsetHeight / 2 - height * 0.35) : 0)
    } else {
      // Plain lyrics carry no timing: drift down in proportion to playback, never pretend to track lines.
      const range = Math.max(0, linesTrack.scrollHeight - height)
      const total = duration()
      setLyricsShift(total > 0 ? range * Math.min(1, Math.max(0, position() / total)) : 0)
    }
  }
  createEffect(() => {
    activeLyric()
    lyrics()
    box()
    lyricsTimed()
    position()
    queueMicrotask(placeLyrics)
  })
  createEffect(() => {
    // A fresh set of lines snaps into place, only later changes glide.
    lyrics()
    setLyricsAnimate(false)
    requestAnimationFrame(() => requestAnimationFrame(() => setLyricsAnimate(true)))
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
  const vizOn = () => settings.modules.visualizer && style() !== 'off'
  // Album colours drive the backdrop; the theme accent is the fallback inside the canvas.
  const vizColors = createMemo(() => {
    const colors = palette()
    return colors ? [colors.dominant, colors.secondary, colors.highlight] : []
  })
  const dense = () => box().h > 0 && box().h < 200
  const tiny = () => box().h > 0 && box().h < 120
  // Artwork size per layout. Wide cards use the full height, tall cards whatever the text rows leave.
  const artSize = createMemo(() => {
    const { w, h } = box()
    if (w <= 0 || h <= 0) return 76
    const chrome = lyricsEnabled() ? 150 : 176
    switch (layout()) {
      case 'wide': return Math.floor(Math.max(56, Math.min(h - 2, w * 0.4, 260)))
      case 'tall': return lyricsEnabled() ? 52 : Math.floor(Math.max(72, Math.min(w - 8, h - chrome - (dense() ? 0 : 20), 280)))
      default: return Math.floor(Math.max(lyricsEnabled() ? 48 : 56, Math.min(lyricsEnabled() ? 52 : w * 0.3, h * 0.34, h >= 340 ? 132 : 96)))
    }
  })

  const Lyrics = () => (
    <section class="media__lyrics" classList={{ 'media__lyrics--untimed': lyricsReady() && !lyricsTimed() }} aria-label={lyricsTimed() ? 'Synchronized lyrics' : 'Lyrics, not timed'}>
      <Show when={lyricsReady()} fallback={
        <p class="media__lyrics-state" role={lyricsStatus() === 'unavailable' ? 'status' : undefined}>
          {lyricsStatus() === 'loading' ? 'Looking for lyrics…'
            : lyricsStatus() === 'not_found' ? 'No lyrics found for this track.'
            : lyricsStatus() === 'no_timed_lyrics' ? 'No lyrics available for this track.'
            : lyricsStatus() === 'rate_limited' ? lyricsWait() > 0 ? `Lyrics lookup is busy. Try again in ${lyricsWait()} seconds.` : 'Ready to retry lyrics.'
            : lyricsStatus() === 'unavailable' ? 'Lyrics are temporarily unavailable.'
            : 'No lyrics to show.'}
        </p>
      }>
        <div ref={linesBox} class="media__lyrics-lines" aria-live="off" onWheel={(event) => event.preventDefault()} onTouchMove={(event) => event.preventDefault()}>
          <div
            ref={linesTrack}
            class="media__lyrics-track"
            classList={{ 'media__lyrics-track--glide': lyricsAnimate() }}
            style={{ transform: `translateY(${-lyricsShift()}px)` }}
          >
            {lyrics().map((line, index) => {
              const distance = () => lyricsTimed() ? Math.min(3, Math.abs(activeLyric() - index)) : 1
              return <p
                class="media__lyrics-line"
                classList={{ 'media__lyrics-line--active': lyricsTimed() && activeLyric() === index, 'media__lyrics-line--gap': !line.text, 'media__lyrics-line--past': lyricsTimed() && index < activeLyric() }}
                style={lyricsTimed() && activeLyric() === index ? { '--fill': `${(activeFill() * 100).toFixed(1)}%` } : undefined}
                data-d={distance()}
                data-lyrics-index={index}
              >{line.text || '\u266A'}</p>
            })}
          </div>
        </div>
      </Show>
      <Show when={lyricsStatus() === 'unavailable' || lyricsStatus() === 'rate_limited'}>
        <button type="button" class="media__lyrics-retry" disabled={lyricsStatus() === 'rate_limited' && lyricsWait() > 0} onClick={() => setLyricsRetry(value => value + 1)}>Try again</button>
      </Show>
      <a class="media__lyrics-source" href="https://lrclib.net" target="_blank" rel="noreferrer">{lyricsReady() && !lyricsTimed() ? 'Not timed · LRCLIB' : 'LRCLIB'}</a>
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
          classList={{
            'media--wide': layout() === 'wide',
            'media--tall': layout() === 'tall',
            'media--square': layout() === 'square',
            'media--dense': dense(),
            'media--tiny': tiny(),
            'media--lyrics': lyricsEnabled(),
            'media--playing': playing(),
            'media--has-accent': Boolean(accent()),
            'media--viz': vizOn(),
          }}
          data-layout={layout()}
          style={{ '--media-accent': accent() || 'rgba(255,255,255,0.5)', '--art': `${artSize()}px` }}
        >
          <div class="media__bg" aria-hidden="true">
            <div class="media__wash" />
            <Show when={vizOn()}>
              <Visualizer
                class="media__viz"
                style={settings.visualizer.style}
                intensity={settings.visualizer.intensity}
                reactivity={settings.visualizer.reactivity}
                playing={playing()}
                active={open()}
                colors={vizColors()}
              />
            </Show>
          </div>
          <div class="media__head">
            <div class="media__art" classList={{ [`media__art--${settings.coverStyle}`]: settings.coverStyle !== 'classic' }}>
              <Show when={current().thumbnail} fallback={<Music size={28} strokeWidth={1.4} />}>
                {(src) => <img src={src()} alt="Album artwork" draggable={false} />}
              </Show>
            </div>
            <div class="media__meta">
              <span class="media__source"><i class="media__source-glyph" aria-hidden="true">{sourceName().charAt(0)}</i>{sourceName()}</span>
              <Marquee class="media__title" text={current().title || 'Untitled'} />
              <Marquee class="media__artist" text={current().artist || 'Unknown artist'} />
            </div>
          </div>

          <Show when={lyricsEnabled()}><Lyrics /></Show>

          <div class="media__seek" classList={{ 'media__seek--disabled': !canSeek() }}>
            <div class="media__scrub">
            <div class="media__scrubber">
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
            <Show when={props.onToggleLyrics && lyricsCanFit()}>
              <button
                type="button"
                class="media__lyrics-toggle"
                aria-pressed={Boolean(props.showLyrics)}
                aria-label="Lyrics"
                title={props.showLyrics ? 'Hide lyrics' : 'Show lyrics'}
                onClick={props.onToggleLyrics}
                data-no-drag
              ><TextQuote size={16} strokeWidth={1.9} aria-hidden="true" /></button>
            </Show>
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
          </div>
          <Show when={mediaError()}>
            <p class="inline-error" role="alert">{mediaError()}</p>
          </Show>
        </div>
      )}
    </Show>
  )
}
