import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js'
import { Music, Pause, Play, SkipBack, SkipForward } from 'lucide-solid'
import { mediaControl, mediaBusy, mediaError, nowPlaying } from '../../state/media'
import { patchSettings, settings } from '../../state/settings'
import type { LyricsLine, WidgetConfig } from '../../lib/ipc'
import Visualizer from './Visualizer'
import { normalizeVisualizerStyle, VISUALIZER_STYLES } from '../../lib/visualizerStyles'
import './MediaView.css'
import { open } from '../../state/ui'
import { audioCaptureStatus, audioFrame } from '../../state/audio'
import { browserPreview, cmd } from '../../lib/ipc'

const formatTime = (seconds: number) => {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  return `${Math.floor(safe / 60)}:${Math.floor(safe % 60).toString().padStart(2, '0')}`
}

export default function MediaView(props: {
  compact?: boolean
  showLyrics?: boolean
  size?: WidgetConfig['size']
  onToggleLyrics?: () => void
}) {
  const [scrubbing, setScrubbing] = createSignal(false)
  const [scrub, setScrub] = createSignal(0)
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
  const position = () => {
    const value = media()?.position
    return Math.min(duration(), Math.max(0, typeof value === 'number' && Number.isFinite(value) ? value : 0))
  }
  const progress = () => {
    if (!duration()) return 0
    return ((scrubbing() ? scrub() : position()) / duration()) * 100
  }

  const attachMediaElement = (element: HTMLDivElement) => {
    mediaElement = element
    mediaResize?.disconnect()
    const measure = () => setLyricsCanFit(element.clientHeight >= 240)
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
      if (request === lyricsRequest) {
        setLyricsStatus('unavailable')
      }
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

  const source = () =>
    media()?.sourceApp?.replace(/_.*$/, '').split('.').pop() || 'Windows media'
  const visualized = () => settings.modules.visualizer && normalizeVisualizerStyle(settings.visualizer.style) !== 'off'
  const visualizationMode = () => {
    if (!visualized()) return 'Off'
    if (audioCaptureStatus() === 'active') return audioFrame().rms > 0.000025 ? 'System audio · live' : 'Waiting for sound'
    if (audioCaptureStatus() === 'starting') return 'Connecting to audio'
    if (audioCaptureStatus() === 'error') return 'Audio unavailable'
    return 'Ready for system audio'
  }

  const Visualization = (p: { title?: string; compact?: boolean }) => (
    <>
      <div class="media__viz" classList={{ 'media__viz--tile': p.compact }}>
        <div class="media__viz-stage" classList={{
          'media__viz-stage--off': settings.visualizer.style === 'off',
        }}>
          <Visualizer
            title={p.title || 'System audio'}
            style={settings.visualizer.style}
            intensity={settings.visualizer.intensity}
            reactivity={settings.visualizer.reactivity}
            showModeLabel={false}
          />
        </div>
      </div>
      <div class="media__viz-toolbar" role="group" aria-label="Visualizer style">
        <span class="media__viz-mode" aria-live="off">{visualizationMode()}</span>
        <select
          class="media__viz-select"
          aria-label="Visualizer style"
          value={normalizeVisualizerStyle(settings.visualizer.style)}
          onChange={(event) => patchSettings({ visualizer: { ...settings.visualizer, style: event.currentTarget.value as typeof settings.visualizer.style }, modules: { ...settings.modules, visualizer: event.currentTarget.value !== 'off' } })}
          data-no-drag
        >
          {VISUALIZER_STYLES.map((choice) => <option value={choice.id}>{choice.label}</option>)}
        </select>
      </div>
    </>
  )

  const Transport = (p: { size: number }) => (
    <div class="media__transport" classList={{ 'media__transport--sm': props.compact }}>
      <button
        class="media__btn"
        disabled={mediaBusy() || !media()?.canSkipPrevious}
        aria-label="Previous track"
        onClick={() => void mediaControl('previous')}
      >
        <SkipBack size={p.size} fill="currentColor" />
      </button>
      <button
        class="media__btn media__btn--primary"
        classList={{ 'media__btn--sm': props.compact }}
        disabled={mediaBusy() || (media()?.status === 'playing' ? !media()?.canPause : !media()?.canPlay)}
        aria-label={media()?.status === 'playing' ? 'Pause' : 'Play'}
        onClick={() => void mediaControl('toggle')}
      >
        <Show when={media()?.status === 'playing'} fallback={<Play size={p.size + 1} fill="currentColor" />}>
          <Pause size={p.size + 1} fill="currentColor" />
        </Show>
      </button>
      <button
        class="media__btn"
        disabled={mediaBusy() || !media()?.canSkipNext}
        aria-label="Next track"
        onClick={() => void mediaControl('next')}
      >
        <SkipForward size={p.size} fill="currentColor" />
      </button>
    </div>
  )

  const Seek = () => (
    <div class="media__seek">
      <input
        class="media__range"
        aria-label="Seek playback"
        type="range"
        min={seekMin()}
        max={seekMax() || 1}
        step="0.25"
        disabled={!canSeek() || mediaBusy()}
        value={Math.min(seekMax(), Math.max(seekMin(), scrubbing() ? scrub() : position()))}
        onInput={(event) => {
          const value = Math.min(seekMax(), Math.max(seekMin(), event.currentTarget.valueAsNumber))
          setScrub(value)
          setScrubbing(true)
        }}
        onChange={(event) => {
          void mediaControl('seek', event.currentTarget.valueAsNumber).finally(() => setScrubbing(false))
        }}
        style={{ '--progress': `${progress()}%` }}
      />
      <div class="media__times">
        <span>{formatTime(scrubbing() ? scrub() : position())}</span>
        <span>{duration() ? formatTime(duration()) : 'Live'}</span>
      </div>
    </div>
  )

  if (props.compact) {
    return (
      <Show
        when={active()}
        fallback={
          <div ref={attachMediaElement} class="media media--tile widget__empty media__empty-tile" classList={{ 'media--visualized': visualized() }}>
            <div class="media__empty-message"><Music class="icon" strokeWidth={1.5} aria-hidden="true" /><span>System audio</span><small>Play something in any app.</small></div>
            <Show when={open() && settings.modules.visualizer}>
              <Visualization compact />
            </Show>
          </div>
        }
      >
        {(current) => (
          <div ref={attachMediaElement} class="media media--tile" classList={{ 'media--visualized': visualized() }}>
            <Show when={!visualized() && current().thumbnail}><div class="media__backdrop" aria-hidden="true"><img src={current().thumbnail!} alt=""/></div></Show>
            <div class="media__tile-main">
              <div class="media__art media__art--sm">
                <Show when={current().thumbnail} fallback={<Music size={20} strokeWidth={1.5} />}>
                  {(src) => <img src={src()} alt="Album artwork" draggable={false} />}
                </Show>
              </div>
              <div class="media__tile-meta">
                <span class="media__source">{source()}</span>
                <span class="media__tile-title" title={current().title}>
                  {current().title || 'Untitled'}
                </span>
                <span class="media__tile-artist" title={current().artist}>
                  {current().artist || 'Unknown artist'}
                </span>
              </div>
              <Transport size={17} />
            </div>
            <Show when={props.size !== 'compact' && props.onToggleLyrics}>
              <button
                type="button"
                class="media__lyrics-toggle media__lyrics-toggle--standalone"
                aria-pressed={Boolean(props.showLyrics)}
                disabled={!lyricsCanFit()}
                title={lyricsCanFit() ? 'Show synchronized lyrics' : 'Expand this widget to make room for lyrics'}
                onClick={props.onToggleLyrics}
                data-no-drag
              >{props.showLyrics ? 'Lyrics on' : 'Show lyrics'}</button>
            </Show>
            <Show when={open() && settings.modules.visualizer}>
              <Visualization title={current().title} compact />
            </Show>
            <Show when={lyricsEnabled()}>
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
                <Show when={lyricsStatus() === 'unavailable' || lyricsStatus() === 'rate_limited'}><button type="button" class="media__lyrics-retry" disabled={lyricsStatus() === 'rate_limited' && lyricsWait() > 0} onClick={() => setLyricsRetry(value => value + 1)}>Try again</button></Show>
                <a class="media__lyrics-source" href="https://lrclib.net" target="_blank" rel="noreferrer">Timed lyrics · LRCLIB</a>
              </section>
            </Show>
            <Seek />
            <Show when={mediaError()}>
              <p class="inline-error" role="alert">
                {mediaError()}
              </p>
            </Show>
          </div>
        )}
      </Show>
    )
  }

  return (
    <div ref={attachMediaElement} class="media" classList={{ 'media--visualized': visualized() }}>
      <Show
        when={media()}
        fallback={
          <div class="media__empty">
            <div class="media__empty-art">
              <Music size={30} strokeWidth={1.3} />
            </div>
            <h2>Give your day a soundtrack.</h2>
            <p>Play something in Spotify, your browser, or another Windows media app.</p>
            <Show when={open() && settings.modules.visualizer}>
              <Visualization />
            </Show>
          </div>
        }
      >
        {(current) => (
          <>
            <div class="media__main">
              <div class="media__art">
                <Show when={current().thumbnail} fallback={<Music size={32} strokeWidth={1.3} />}>
                  {(src) => <img src={src()} alt="Album artwork" draggable={false} />}
                </Show>
              </div>
              <div class="media__meta">
                <span class="media__source">{source()}</span>
                <h2 class="media__title" title={current().title}>
                  {current().title || 'Untitled'}
                </h2>
                <p class="media__artist" title={current().artist}>
                  {current().artist || 'Unknown artist'}
                </p>
                <Show when={current().album}>
                  <p class="media__album">{current().album}</p>
                </Show>
              </div>
            </div>
            <Seek />
            <Transport size={20} />
            <Show when={mediaError()}>
              <p class="inline-error" role="alert">
                {mediaError()}
              </p>
            </Show>
            <Show when={open() && settings.modules.visualizer}>
              <Visualization title={current().title} />
            </Show>
            <Show when={lyricsEnabled()}>
              <section class="media__lyrics" aria-label="Synchronized lyrics">
                <Show when={lyricsStatus() === 'ok' && lyrics().length} fallback={
                  <p class="media__lyrics-state">
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
                <Show when={lyricsStatus() === 'unavailable' || lyricsStatus() === 'rate_limited'}><button type="button" class="media__lyrics-retry" disabled={lyricsStatus() === 'rate_limited' && lyricsWait() > 0} onClick={() => setLyricsRetry(value => value + 1)}>Try again</button></Show>
                <a class="media__lyrics-source" href="https://lrclib.net" target="_blank" rel="noreferrer">Timed lyrics · LRCLIB</a>
              </section>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
