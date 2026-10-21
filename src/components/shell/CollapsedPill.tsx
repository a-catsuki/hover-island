import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Battery, BatteryCharging, Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, Music, Pause, Play, SkipBack, SkipForward, Sun, Zap } from 'lucide-solid'
import { nowPlaying, mediaBusy, mediaControl } from '../../state/media'
import { settings } from '../../state/settings'
import { notifications } from '../../state/notifications'
import { usage } from '../../state/usage'
import { focusTimer, formatFocus } from '../../state/focus'
import { cmd, type SystemStats, type WeatherSnapshot } from '../../lib/ipc'
import { normalizeCompactItems } from '../../lib/compactConfig'
import { canLoadWeather, createWeatherLoader } from '../../lib/weatherLayout'
import { compactStatValue, isReportStale, remainingPercent, reportAge, resetCountdown, resetTimeLabel, usedRatio, windowLabel } from '../../lib/usageDisplay'
import { liveActiveCount } from '../../state/aiActivity'
import { awakeLive } from '../../state/awake'
import './CollapsedPill.css'
import { Dynamic } from 'solid-js/web'
import { clockTime } from '../../lib/clockDisplay'
import { pendingAlert, openPendingAlert } from '../../state/peek'
import LiveBars from '../views/LiveBars'

function UsageRing(props: { percent: number }) {
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const clamped = () => Math.max(0, Math.min(1, props.percent))
  return <svg class="pill__ring" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <circle cx="8" cy="8" r={radius} fill="none" stroke="var(--line-1)" stroke-width="2" />
    <circle cx="8" cy="8" r={radius} fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-dasharray={String(circumference)} stroke-dashoffset={String(circumference * (1 - clamped()))} transform="rotate(-90 8 8)" />
  </svg>
}

function AnalogClock(props: { date: Date }) {
  const hand = (length: number, angle: number) => {
    const rad = (angle - 90) * (Math.PI / 180)
    return { x: 12 + Math.cos(rad) * length, y: 12 + Math.sin(rad) * length }
  }
  const hour = () => hand(6, (props.date.getHours() % 12) * 30 + props.date.getMinutes() * 0.5)
  const minute = () => hand(8.4, props.date.getMinutes() * 6)
  return <svg class="pill__analog" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <circle cx="12" cy="12" r="10.4" fill="none" stroke="var(--line-1)" stroke-width="1.1" />
    <line x1="12" y1="12" x2={hour().x} y2={hour().y} stroke="var(--text-1)" stroke-width="1.7" stroke-linecap="round" />
    <line x1="12" y1="12" x2={minute().x} y2={minute().y} stroke="var(--text-1)" stroke-width="1.3" stroke-linecap="round" />
    <line x1="12" y1="12" x2={minute().x} y2={minute().y} stroke="var(--accent)" stroke-width="0.9" stroke-linecap="round" />
    <circle cx="12" cy="12" r="1.15" fill="var(--accent)" />
  </svg>
}

function WeatherIcon(props: { code: number }) {
  const Icon = () => props.code === 0 ? Sun
    : props.code <= 2 ? CloudSun
      : props.code === 3 ? Cloud
        : props.code <= 48 ? CloudFog
          : props.code <= 57 ? CloudDrizzle
            : props.code <= 67 || (props.code >= 80 && props.code <= 82) ? CloudRain
              : props.code <= 77 || (props.code >= 85 && props.code <= 86) ? CloudSnow
                : props.code >= 95 ? CloudLightning : CloudSun
  return <Dynamic component={Icon()} size={15} aria-hidden="true" />
}

export default function CollapsedPill() {
  const [clock, setClock] = createSignal(new Date())
  const [weather, setWeather] = createSignal<WeatherSnapshot | null>(null)
  const [system, setSystem] = createSignal<SystemStats | null>(null)
  const clockLabel = () => clockTime(clock())
  const verticalClock = () => settings.placement.edge === 'left' || settings.placement.edge === 'right'
  const digitalClock = () => <Show when={verticalClock()} fallback={<strong>{clockLabel()}</strong>}>
    <strong class="pill__clock-stack" aria-hidden="true"><For each={clockLabel().split(/[:\s\u202f]+/).filter(Boolean)}>{part => <span>{part}</span>}</For></strong>
  </Show>
  const selected = createMemo(() => normalizeCompactItems(settings.compactItems, settings.sizePreset))
  const visible = createMemo(() => selected().filter(item => item !== 'media' || settings.modules.media).filter(item => item !== 'ai' || settings.modules.usage))
  const media = () => nowPlaying()
  const activeMedia = () => { const value = media(); return value && value.status !== 'stopped' ? value : null }

  const weatherLoader = createWeatherLoader(cmd.weatherGet, setWeather)
  const refreshSystem = async () => {
    try { setSystem(await cmd.systemStats()) } catch { /* Keep the last useful snapshot. */ }
  }

  onMount(() => {
    const clockTimer = window.setInterval(() => {const next=new Date();if(settings.clockSeconds||next.getSeconds()%15===0)setClock(next)}, 1000)
    const weatherTimer = window.setInterval(() => { void weatherLoader.refresh() }, 10 * 60_000)
    const systemTimer = window.setInterval(() => { if (visible().includes('battery')) void refreshSystem() }, 60_000)
    onCleanup(() => { clearInterval(clockTimer); clearInterval(weatherTimer); clearInterval(systemTimer) })
  })
  createEffect(() => {
    // Read every location field so city changes and consent clearing invalidate
    // compact data immediately, even while an old forecast request is pending.
    const location = {
      weatherLat: settings.weatherLat, weatherLon: settings.weatherLon,
      weatherCity: settings.weatherCity, weatherAutoLocation: settings.weatherAutoLocation,
    }
    const enabled = visible().includes('weather') && canLoadWeather(location)
    weatherLoader.configure(enabled)
    if (enabled) void weatherLoader.refresh()
  })
  onCleanup(() => weatherLoader.configure(false))
  createEffect(() => {
    const items = visible()
    if (items.includes('battery') && !system()) void refreshSystem()
  })

  const bestUsage = createMemo(() => {
    let best: { percent: number; label: string } | null = null
    for (const snapshot of usage()) {
      const left = remainingPercent(snapshot)
      if (snapshot.status === 'ok' && left != null && (snapshot.source === 'official-rate-limit' || snapshot.limit != null)) {
        if (!best || left < best.percent) {
          const used = usedRatio(snapshot)
          const expectedReset = resetTimeLabel(snapshot.resetAt)
          const age = `${reportAge(snapshot.updatedAt)}${isReportStale(snapshot.updatedAt) ? ' · stale report' : ''}`
          best = { percent: left, label: `${snapshot.label} · ${windowLabel(snapshot.window)} · ${left}% left${used == null ? '' : ` · ${Math.round(used * 100)}% used`} · ${age} · ${resetCountdown(snapshot.resetAt)}${expectedReset ? ` · Expected ${expectedReset}` : ''}` }
        }
      }
    }
    return best
  })
  // Small AI stat. Usage-left would repeat the "ai" item when that is already in the pill.
  const aiStat = createMemo(() => {
    if (!settings.modules.usage) return null
    const stat = settings.compactAiStat
    if (stat === 'usage-left' && visible().includes('ai')) return null
    return compactStatValue(stat, usage(), liveActiveCount())
  })
  const unread = createMemo(() => notifications().length)
  const stop = (event: Event) => event.stopPropagation()
  const doMedia = (event: MouseEvent, action: 'previous' | 'toggle' | 'next') => {
    event.stopPropagation()
    void mediaControl(action)
  }

  return <div class="pill" classList={{ 'pill--compact-small': settings.sizePreset === 'small', 'pill--compact-medium': settings.sizePreset === 'medium', 'pill--compact-large': settings.sizePreset === 'large' }}>
    <div class="pill__compact">
      <For each={visible()}>{item => <>
      <Show when={item === 'media'}>
        <div class="pill__compact-item pill__compact-media" classList={{ 'pill__compact-media--idle': !activeMedia() }} aria-label={activeMedia() ? `Now playing ${media()?.title ?? ''}` : 'Media controls'} onPointerDown={stop}>
          <span class="pill__compact-art">
            <Show when={activeMedia()?.thumbnail} fallback={<Music size={13} aria-hidden="true" />}>
              {src => <img src={src()} alt="" draggable={false} />}
            </Show>
          </span>
          <span class="pill__compact-title" title={activeMedia()?.title || 'Media'}>{activeMedia()?.title || 'Media'}</span>
          <Show when={activeMedia()}>
            <span class="pill__compact-live" aria-hidden="true"><LiveBars playing={media()?.status === 'playing'} bars={4} size={18} color="rgba(255,255,255,0.92)" /></span>
          </Show>
          <Show when={settings.compactMediaControls && media()}>
          <span class="pill__compact-controls" onPointerDown={stop}>
            <button type="button" aria-label="Previous track" title="Previous track" disabled={mediaBusy() || !media()?.canSkipPrevious} onClick={event => doMedia(event, 'previous')}><SkipBack size={13}/></button>
            <button type="button" aria-label={media()?.status === 'playing' ? 'Pause' : 'Play'} title={media()?.status === 'playing' ? 'Pause' : 'Play'} disabled={mediaBusy() || (media()?.status === 'playing' ? !media()?.canPause : !media()?.canPlay)} onClick={event => doMedia(event, 'toggle')}>{media()?.status === 'playing' ? <Pause size={14}/> : <Play size={14}/>}</button>
            <button type="button" aria-label="Next track" title="Next track" disabled={mediaBusy() || !media()?.canSkipNext} onClick={event => doMedia(event, 'next')}><SkipForward size={13}/></button>
          </span>
          </Show>
        </div>
      </Show><Show when={item === 'clock'}>
        <div class="pill__compact-item pill__compact-clock" classList={{ 'pill__compact-clock--analog': settings.compactClockStyle === 'analog' }} aria-label={`Local time ${clockLabel()}`}>
          <Show when={settings.compactClockStyle === 'analog'} fallback={<><span class="pill__compact-label">Local</span>{digitalClock()}</>}>
            <AnalogClock date={clock()} />
            {digitalClock()}
          </Show>
        </div>
      </Show><Show when={item === 'weather'}>
        <div class="pill__compact-item pill__compact-weather" aria-label={weather()?.ok ? `${weather()?.city}, ${Math.round(weather()!.tempC)} degrees Celsius` : 'Weather unavailable'}>
          <Show when={weather()?.ok} fallback={<CloudSun size={16} aria-hidden="true" />}>
            <WeatherIcon code={weather()!.code}/><strong>{Math.round(weather()!.tempC)}°</strong>
          </Show>
          <span class="pill__compact-label">{weather()?.city || 'Weather'}</span>
        </div>
      </Show><Show when={item === 'battery' && system()?.batteryPercent != null}>
        <div class="pill__compact-item pill__compact-battery" aria-label={`Battery ${Math.round(system()!.batteryPercent!)} percent${system()!.charging ? ', charging' : ''}`}>
          <Show when={system()?.charging} fallback={<Battery size={16}/>}><BatteryCharging size={16}/></Show>
          <strong>{Math.round(system()!.batteryPercent!)}%</strong>
        </div>
      </Show><Show when={item === 'ai' && bestUsage()}>
        {value => <div class="pill__compact-item pill__compact-ai" title={value().label}><UsageRing percent={value().percent / 100}/><strong>{value().percent}%</strong><span class="pill__compact-label">AI left</span></div>}
      </Show></> }</For>
      <Show when={aiStat()}>{stat => <div class="pill__compact-item pill__compact-aistat" classList={{ 'pill__compact-aistat--live': settings.compactAiStat === 'active-count' && Number(stat().value) > 0 }} title={stat().title} aria-label={stat().title}><span class="pill__aistat-dot" aria-hidden="true"/><strong>{stat().value}</strong><span class="pill__compact-label">{stat().label}</span></div>}</Show>
      <Show when={visible().length === 0 && !aiStat()}><span class="pill__compact-empty" role="img" aria-label="Hover Island" /></Show>
    </div>
    <Show when={!settings.dnd && settings.notifications.enabled ? pendingAlert() : null}>{item=><button class="pill__alert-badge" classList={{'pill__alert-badge--auth':item().category==='auth'}} aria-label={item().category==='auth'?`Verification code ${item().code ?? item().title}; activate to view and copy`:`Unread alert: ${item().title}`} title={item().category==='auth'?`Verification code · ${item().account ?? ''}`:`${item().app}: ${item().title}`} onPointerDown={stop} onClick={event=>{event.stopPropagation();openPendingAlert()}}><span class="pill__alert-dot"/><span>{item().category==='auth'?item().code ?? item().title:item().title}</span></button>}</Show>
    <div class="pill__badges" aria-hidden="true">
      <Show when={settings.modules.notifications && settings.notifications.enabled && unread() > 0}><span class="pill__dot" title={`${unread()} unread`} /></Show>
      <Show when={awakeLive()}>{live => <span class="pill__awake" classList={{ 'pill__awake--pending': live().pending }} title={`Keeping your PC awake, ${live().remaining} left`}><Zap size={11} strokeWidth={2.4}/>{live().remaining}</span>}</Show>
      <Show when={focusTimer().endsAt && !visible().includes('clock')}><span class="pill__focus">{formatFocus(focusTimer().remaining)}</span></Show>
    </div>
  </div>
}
