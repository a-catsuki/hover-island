import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { ArrowDown, ArrowUp, Cable, Network, Play, Square, Trash2, Wifi, WifiOff } from 'lucide-solid'
import {
  PING_TARGETS, cancelSpeedtest, clearSpeedHistory, history, host, info, pingError, pingStats, series, setPingHost, speed,
  startSpeedtest, watchNetwork,
} from '../../state/network'
import Dropdown from './Dropdown'
import './widgetKit.css'
import './NetworkWidget.css'

const CUSTOM = 'custom'
const GAUGE_MAX = 1000
const DOWN = '#0A84FF'
const UP = '#BF5AF2'

/** Log scale so 5 Mbps and 500 Mbps both move the needle. */
const gaugeFraction = (mbps: number) => Math.max(0, Math.min(1, Math.log10(1 + mbps) / Math.log10(1 + GAUGE_MAX)))
const fmtSpeed = (mbps: number | null | undefined) => mbps == null ? '--' : mbps >= 100 ? Math.round(mbps).toString() : mbps.toFixed(1)
const fmtMs = (ms: number | null | undefined) => ms == null ? '--' : ms >= 100 ? Math.round(ms).toString() : ms.toFixed(1)
const latencyTone = (ms: number | null | undefined) => ms == null ? 'none' : ms < 40 ? 'good' : ms < 100 ? 'fair' : 'poor'
const timeLabel = (at: number) => {
  const date = new Date(at)
  const sameDay = new Date().toDateString() === date.toDateString()
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return sameDay ? time : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

function Sparkline(props: { values: (number | null)[] }) {
  const W = 200
  const H = 56
  const shape = createMemo(() => {
    const values = props.values.slice(-40)
    const good = values.filter((v): v is number => v !== null)
    if (good.length < 2) return null
    const max = Math.max(...good, 20) * 1.15
    const min = Math.max(0, Math.min(...good) * 0.8)
    const step = W / Math.max(1, values.length - 1)
    const y = (v: number) => H - 4 - ((v - min) / Math.max(1, max - min)) * (H - 10)
    let path = ''
    let started = false
    const points: { x: number; y: number; lost: boolean }[] = []
    values.forEach((value, index) => {
      const x = index * step
      if (value === null) { started = false; points.push({ x, y: H - 2, lost: true }); return }
      path += `${started ? 'L' : 'M'}${x.toFixed(1)} ${y(value).toFixed(1)} `
      started = true
      points.push({ x, y: y(value), lost: false })
    })
    const solid = points.filter(point => !point.lost)
    const area = solid.length > 1 ? `${path.trim()} L${solid[solid.length - 1].x.toFixed(1)} ${H} L${solid[0].x.toFixed(1)} ${H} Z` : ''
    return { path: path.trim(), area, last: solid[solid.length - 1], lost: points.filter(point => point.lost) }
  })
  return (
    <svg class="net__spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Recent latency">
      <defs><linearGradient id="net-spark-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".28" /><stop offset="1" stop-color="currentColor" stop-opacity="0" /></linearGradient></defs>
      <Show when={shape()} fallback={<line x1="0" y1={H - 4} x2={W} y2={H - 4} stroke="currentColor" stroke-opacity=".2" stroke-width="1.5" stroke-dasharray="3 4" vector-effect="non-scaling-stroke" />}>
        {(item) => <>
          <path d={item().area} fill="url(#net-spark-fill)" />
          <path d={item().path} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
          <For each={item().lost}>{(point) => <line x1={point.x} x2={point.x} y1={H - 10} y2={H - 1} stroke="#FF453A" stroke-width="2" stroke-linecap="round" vector-effect="non-scaling-stroke" />}</For>
        </>}
      </Show>
    </svg>
  )
}

export default function NetworkWidget() {
  const state = speed
  const stats = createMemo(() => pingStats(series()))
  const running = () => state().running
  const [customDraft, setCustomDraft] = createSignal('')
  const [customMode, setCustomMode] = createSignal(false)
  const isPreset = () => PING_TARGETS.some(target => target.value === host())
  const showCustom = () => customMode() || !isPreset()
  const targetValue = () => showCustom() ? CUSTOM : host()
  const options = [...PING_TARGETS.map(target => ({ ...target })), { value: CUSTOM, label: 'Custom host', detail: 'Type an address' }]

  onMount(() => { const release = watchNetwork(); onCleanup(release) })

  const phase = () => state().phase
  const downShown = () => running() ? (phase() === 'download' ? state().mbps : state().down) : state().down ?? history()[0]?.down ?? null
  const upShown = () => running() ? (phase() === 'upload' ? state().mbps : state().up) : state().up ?? history()[0]?.up ?? null
  const latencyShown = () => state().latency ?? history()[0]?.latency ?? null
  const caption = () => {
    if (running()) return phase() === 'latency' ? 'Checking latency' : phase() === 'upload' ? 'Testing upload' : 'Testing download'
    if (phase() === 'error') return 'Test failed'
    if (phase() === 'cancelled') return 'Stopped'
    if (phase() === 'done') return 'Complete'
    return history()[0] ? `Last test ${timeLabel(history()[0].at)}` : 'Ready to test'
  }
  const link = () => info()
  const linkLabel = () => {
    const current = link()
    if (!current) return 'Checking'
    if (current.kind === 'wifi') return current.ssid ?? 'Wi-Fi'
    if (current.kind === 'wired') return 'Ethernet'
    if (current.kind === 'offline') return 'Offline'
    return 'Connected'
  }
  const linkDetail = () => {
    const current = link()
    if (!current) return ''
    return [current.kind === 'wifi' && current.signalPct != null ? `${current.signalPct}% signal` : null, current.linkMbps ? `${current.linkMbps} Mbps link` : null, current.localIp].filter(Boolean).join(' · ')
  }
  const applyCustom = () => { const value = customDraft().trim(); if (value) setPingHost(value) }

  return (
    <section class="wk net" aria-label="Network" data-phase={phase()} data-running={running() ? '' : undefined}>
      <div class="net__grid">
      <header class="wk-head net__head">
        <span class="wk-title"><span class="wk-glyph" style={{ background: '#0A84FF' }}><Network size={13} strokeWidth={2.2} /></span><span>Network</span></span>
        <span class="net__tools"><span class="net__link" classList={{ 'net__link--off': link()?.kind === 'offline' }} title={linkDetail() || undefined}>
          <Show when={link()?.kind === 'wired'} fallback={<Show when={link()?.kind === 'offline'} fallback={<Wifi size={13} />}><WifiOff size={13} /></Show>}><Cable size={13} /></Show>
          <span class="net__link-name">{linkLabel()}</span>
        </span>
        <button type="button" class="net__go" classList={{ 'net__go--stop': running() }} aria-label={running() ? 'Stop speed test' : 'Start speed test'}
          onClick={() => running() ? cancelSpeedtest() : void startSpeedtest()}>
          {running() ? <Square size={10} fill="currentColor" strokeWidth={0} /> : <Play size={10} fill="currentColor" strokeWidth={0} />}{running() ? 'Stop' : history()[0] || phase() !== 'idle' ? 'Again' : 'Start'}
        </button></span>
      </header>

      <div class="net__bar">
        <span class="net__caption" role="status" aria-live="polite">{caption()}</span>
      </div>

      <div class="net__meters" aria-label="Speed test results">
        <div class="net__meter" style={{ '--c': DOWN }} data-active={running() && phase() === 'download' ? '' : undefined}>
          <span class="net__meter-label"><ArrowDown size={12} strokeWidth={2.6} />Download</span>
          <strong class="net__meter-val">{fmtSpeed(downShown())}<small>Mbps</small></strong>
          <span class="net__meter-track"><i style={{ width: `${Math.round(gaugeFraction(downShown() ?? 0) * 100)}%` }} /></span>
        </div>
        <div class="net__meter" style={{ '--c': UP }} data-active={running() && phase() === 'upload' ? '' : undefined}>
          <span class="net__meter-label"><ArrowUp size={12} strokeWidth={2.6} />Upload</span>
          <strong class="net__meter-val">{fmtSpeed(upShown())}<small>Mbps</small></strong>
          <span class="net__meter-track"><i style={{ width: `${Math.round(gaugeFraction(upShown() ?? 0) * 100)}%` }} /></span>
        </div>
      </div>

      <div class="net__latency" data-tone={latencyTone(stats()?.last)}>
        <div class="net__latency-head">
          <span class="net__dot" aria-hidden="true" />
          <span class="net__latency-title">Ping</span>
          <span class="net__latency-now">{stats()?.last != null ? fmtMs(stats()!.last) : stats()?.loss === 100 ? 'Timed out' : fmtMs(latencyShown())}<Show when={stats()?.last != null || latencyShown() != null}><small> ms</small></Show></span>
          <Sparkline values={series()} />
          <span class="net__target">
            <Dropdown class="net__target-dd" size="sm" align="end" ariaLabel="Ping target" value={targetValue()} options={options}
              onChange={(value) => { if (value === CUSTOM) { setCustomMode(true); setCustomDraft(isPreset() ? '' : host()) } else { setCustomMode(false); setPingHost(value) } }} />
          </span>
        </div>
        <Show when={showCustom()}>
          <form class="net__custom" onSubmit={(event) => { event.preventDefault(); applyCustom() }}>
            <input type="text" inputmode="url" spellcheck={false} autocomplete="off" placeholder="example.com" aria-label="Custom host to ping" value={customDraft() || (isPreset() ? '' : host())}
              onInput={(event) => setCustomDraft(event.currentTarget.value)} onBlur={applyCustom} />
          </form>
        </Show>
        <div class="net__stats">
          <span><b>{stats() && stats()!.loss < 100 ? fmtMs(stats()!.avg) : '--'}</b> avg</span>
          <span><b>{stats() && stats()!.loss < 100 ? fmtMs(stats()!.jitter) : '--'}</b> jitter</span>
          <span classList={{ 'net__bad': (stats()?.loss ?? 0) > 0 }}><b>{stats() ? Math.round(stats()!.loss) : '--'}%</b> loss</span>
        </div>
        <Show when={pingError()}><p class="wk-error net__error">{pingError()}</p></Show>
      </div>

      <Show when={state().phase === 'error' && state().error}><p class="wk-error net__error net__error--test">{state().error}</p></Show>

      <div class="net__history">
        <div class="net__history-head"><span>Recent tests</span>
          <Show when={history().length > 0}><button type="button" class="wk-icon-btn" aria-label="Clear speed test history" title="Clear history" onClick={clearSpeedHistory}><Trash2 size={13} /></button></Show>
        </div>
        <Show when={history().length > 0} fallback={<p class="net__history-empty">Run a test to see it here.</p>}>
          <ul>
            <For each={history()}>{(item) => <li>
              <span class="net__h-time">{timeLabel(item.at)}</span>
              <span class="net__h-val" style={{ color: DOWN }}>{fmtSpeed(item.down)}</span>
              <span class="net__h-val" style={{ color: UP }}>{fmtSpeed(item.up)}</span>
              <span class="net__h-ms">{fmtMs(item.latency)} ms</span>
            </li>}</For>
          </ul>
        </Show>
      </div>
      </div>
    </section>
  )
}
