import { createEffect, createMemo, createSignal, Show } from 'solid-js'
import { Music, Pause, Play, SkipBack, SkipForward } from 'lucide-solid'
import { mediaControl, mediaBusy, mediaError, nowPlaying } from '../../state/media'
import { patchSettings, settings } from '../../state/settings'
import type { NowPlaying } from '../../lib/ipc'
import Visualizer from './Visualizer'
import { normalizeVisualizerStyle, VISUALIZER_STYLES } from '../../lib/visualizerStyles'
import './MediaView.css'
import { open } from '../../state/ui'
import { audioCaptureStatus } from '../../state/audio'
import { syntheticAudioSpectrum } from '../../lib/syntheticAudioPreview'

const formatTime = (seconds: number) => {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  return `${Math.floor(safe / 60)}:${Math.floor(safe % 60).toString().padStart(2, '0')}`
}

export default function MediaView(props: { compact?: boolean }) {
  const [scrubbing, setScrubbing] = createSignal(false)
  const [scrub, setScrub] = createSignal(0)

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

  createEffect(() => {
    media()?.title
    setScrubbing(false)
  })

  const source = () =>
    media()?.sourceApp?.replace(/_.*$/, '').split('.').pop() || 'Windows media'
  const visualizationMode = () => {
    if (settings.visualizer.style === 'off') return 'Off'
    if (syntheticAudioSpectrum()) return 'Synthetic preview'
    if (audioCaptureStatus() === 'active') return 'System audio · live'
    if (audioCaptureStatus() === 'error') return 'Ambient · audio unavailable'
    return 'Ambient motion'
  }

  const Visualization = (p: { current: NowPlaying; compact?: boolean }) => (
    <>
      <div class="media__viz" classList={{ 'media__viz--tile': p.compact }}>
        <div class="media__viz-stage" classList={{
          'media__viz-stage--off': settings.visualizer.style === 'off',
          'media__viz-stage--ambient': settings.visualizer.style === 'ambient',
        }}>
          <Visualizer
            title={p.current.title || 'Now playing'}
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
          onChange={(event) => patchSettings({ visualizer: { ...settings.visualizer, style: event.currentTarget.value as typeof settings.visualizer.style } })}
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
          <div class="widget__empty media__empty-tile">
            <Music class="icon" strokeWidth={1.5} aria-hidden="true" />
            <span>Nothing playing right now.</span>
          </div>
        }
      >
        {(current) => (
          <div class="media media--tile" classList={{'media--ambient':settings.visualizer.style === 'ambient'}}>
            <Show when={current().thumbnail}><div class="media__backdrop" aria-hidden="true"><img src={current().thumbnail!} alt=""/></div></Show>
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
            <Show when={open() && settings.modules.visualizer && current().status === 'playing'}>
              <Visualization current={current()} compact />
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
    <div class="media">
      <Show
        when={media()}
        fallback={
          <div class="media__empty">
            <div class="media__empty-art">
              <Music size={30} strokeWidth={1.3} />
            </div>
            <h2>Give your day a soundtrack.</h2>
            <p>Play something in Spotify, your browser, or another Windows media app.</p>
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
            <Show when={open() && settings.modules.visualizer && current().status === 'playing'}>
              <Visualization current={current()} />
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
