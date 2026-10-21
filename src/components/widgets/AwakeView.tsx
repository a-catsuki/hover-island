import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { BellRing, Check, Coffee, Moon, Sun, Volume2, Zap } from 'lucide-solid'
import {
  END_CHIPS, INTENSITIES, chipEnd, formatClock, formatLeft, formatRemaining, nextClockTime, parseTimeInput, toTimeInput, type EndChip,
} from '../../lib/awakeSchedule'
import { SOUND_PACKS, type SoundPack } from '../../lib/awakeSounds'
import {
  alarmBurst, awakeActive, awakeConfirmWindowMs, awakeBusy, awakeCelebration, awakeDraft, awakeEnd, awakeError, awakeGlyph, awakeNow,
  awakeProgress, awakeRemainingMs, awakeStatus, awakeSunrise, awakeUrgency, confirmAwake, dismissCelebration, pickAwakeChip,
  previewAwakeSound, refreshSunrise, setAwakeDraft, setAwakeEnd, startAwake, stopAwake,
} from '../../state/awake'
import './widgetKit.css'
import './AwakeView.css'

/** Calm teal at the start, warming to red as the end (or an unanswered alarm) gets closer. */
const STOPS: Array<[number, [number, number, number]]> = [[0, [100, 210, 255]], [0.5, [255, 214, 10]], [0.78, [255, 159, 10]], [1, [255, 69, 58]]]
function heat(u: number): string {
  const t = Math.min(1, Math.max(0, u))
  for (let i = 1; i < STOPS.length; i++) {
    const [b, to] = STOPS[i]
    const [a, from] = STOPS[i - 1]
    if (t <= b) {
      const k = (t - a) / (b - a)
      return `rgb(${from.map((value, n) => Math.round(value + (to[n] - value) * k)).join(',')})`
    }
  }
  return 'rgb(255,69,58)'
}

const RING = 2 * Math.PI * 44

export default function AwakeView() {
  const [armStop, setArmStop] = createSignal(false)
  let armTimer: ReturnType<typeof setTimeout> | undefined
  onMount(refreshSunrise)
  onCleanup(() => clearTimeout(armTimer))

  const pending = () => awakeStatus().pending
  const u = () => Math.max(awakeUrgency(), pending() ? 0.85 : 0)
  const color = () => heat(u())
  const state = () => (awakeCelebration() && !awakeActive() ? 'done' : awakeActive() ? (pending() ? 'pending' : 'active') : 'idle')
  const rootStyle = () => ({
    '--c': color(),
    '--pulse': `${(4.2 - 3.3 * u()).toFixed(2)}s`,
    '--spin': `${(16 - 12.5 * u()).toFixed(2)}s`,
    '--confirm': `${Math.round(awakeConfirmWindowMs() / 1000)}s`,
  })

  const subtitle = () => {
    if (state() === 'done') return 'Session complete'
    if (!awakeActive()) return 'Stay up until a time you pick'
    return `Until ${formatClock(awakeStatus().endEpochMs)} · ${formatLeft(awakeRemainingMs())}`
  }

  const stop = () => {
    if (!armStop()) {
      setArmStop(true)
      clearTimeout(armTimer)
      armTimer = setTimeout(() => setArmStop(false), 3000)
      return
    }
    setArmStop(false)
    void stopAwake()
  }

  const chipActive = (chip: EndChip) => Math.abs(chipEnd(chip, awakeNow(), awakeSunrise()) - awakeEnd()) < 60_000
  const endLabel = () => formatClock(awakeEnd())
  const endIn = createMemo(() => formatLeft(awakeEnd() - awakeNow()))

  const onTime = (value: string) => {
    const parsed = parseTimeInput(value)
    if (parsed) setAwakeEnd(nextClockTime(parsed.hour, parsed.minute, Date.now()))
  }

  const Setup = () => (
    <div class="aw__setup">
      <div class="aw__main">
        <div class="aw__row">
          <label class="aw__time">
            <span class="aw__time-label">Until</span>
            <input class="aw__time-input" type="time" aria-label="End time" value={toTimeInput(awakeEnd())} onInput={(event) => onTime(event.currentTarget.value)} />
          </label>
          <button type="button" class="aw__go" disabled={awakeBusy()} onClick={() => void startAwake()}>
            <Moon size={14} strokeWidth={2.2} aria-hidden="true" /><span>Start</span>
          </button>
        </div>
        <div class="aw__chips" role="group" aria-label="Quick end times">
          <For each={END_CHIPS}>{(chip) => (
            <button type="button" class="aw__chip" classList={{ on: chipActive(chip.id) }} onClick={() => pickAwakeChip(chip.id)}>{chip.label}</button>
          )}</For>
        </div>
        <p class="aw__hint">Ends at {endLabel()} · {endIn()}</p>
        <Show when={awakeError()}><p class="wk-error">{awakeError()}</p></Show>
      </div>
      <div class="aw__opts">
        <div class="aw-seg" role="radiogroup" aria-label="Intensity" style={{ '--i': INTENSITIES.findIndex((item) => item.id === awakeDraft().intensity) }}>
          <span class="aw-seg__thumb" aria-hidden="true" />
          <For each={INTENSITIES}>{(item) => (
            <button type="button" role="radio" aria-checked={awakeDraft().intensity === item.id} classList={{ on: awakeDraft().intensity === item.id }} title={item.hint}
              onClick={() => setAwakeDraft({ intensity: item.id })}>{item.label}</button>
          )}</For>
        </div>
        <div class="aw__chips aw__sounds" role="radiogroup" aria-label="Alarm sound">
          <For each={SOUND_PACKS}>{(pack) => (
            <button type="button" role="radio" aria-checked={awakeDraft().sound === pack.id} class="aw__chip" classList={{ on: awakeDraft().sound === pack.id }} title={pack.hint}
              onClick={() => { setAwakeDraft({ sound: pack.id as SoundPack }); void previewAwakeSound() }}>{pack.id === 'system' ? 'Windows' : pack.label}</button>
          )}</For>
        </div>
        <label class="aw-vol" style={{ '--v': `${Math.round(awakeDraft().volume * 100)}%` }}>
          <Volume2 size={14} aria-hidden="true" />
          <input type="range" min="5" max="100" step="5" aria-label="Alarm volume" value={Math.round(awakeDraft().volume * 100)}
            onInput={(event) => setAwakeDraft({ volume: Number(event.currentTarget.value) / 100 })}
            onChange={() => void previewAwakeSound()} />
          <span>{Math.round(awakeDraft().volume * 100)}%</span>
        </label>
      </div>
    </div>
  )

  const Glyphs = () => (
    <span class="aw__glyph" data-glyph={awakeGlyph()} aria-hidden="true">
      <Coffee size={16} class="g-coffee" /><Zap size={16} class="g-zap" /><Sun size={16} class="g-sun" />
    </span>
  )

  const Hero = () => (
    <div class="aw__active">
      <For each={[alarmBurst()]}>{(burst) => (
        <div class="aw__hero" classList={{ 'aw__hero--shake': burst > 0 }}>
          <div class="aw__aura" aria-hidden="true" />
          <Show when={pending()}><span class="aw__ripple" aria-hidden="true" /><span class="aw__ripple aw__ripple--2" aria-hidden="true" /></Show>
          <svg class="aw__arc" viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="44" class="aw__arc-track" />
            <circle cx="50" cy="50" r="44" class="aw__arc-fill" stroke-dasharray={String(RING)} stroke-dashoffset={String(RING * (1 - awakeProgress()))} transform="rotate(-90 50 50)" />
          </svg>
          <div class="aw__center">
            <Glyphs />
            <div class="aw__clock" role="timer" aria-label={`${formatLeft(awakeRemainingMs())}`}>{formatRemaining(awakeRemainingMs())}</div>
          </div>
        </div>
      )}</For>
      <div class="aw__side">
        <div class="aw__until"><span>Until</span><strong>{formatClock(awakeStatus().endEpochMs)}</strong></div>
        <p class="aw__facts">{INTENSITIES.find((item) => item.id === awakeStatus().intensity)?.label} · {awakeStatus().alarmCount} {awakeStatus().alarmCount === 1 ? 'check-in' : 'check-ins'}{awakeStatus().keepingAwake ? ' · PC kept awake' : ''}</p>
        <div class="aw__actions">
          <button type="button" class="aw__btn aw__btn--primary" classList={{ calm: !pending() }} onClick={() => void confirmAwake()}><Check size={14} strokeWidth={2.4} aria-hidden="true" /><span>I'm awake</span></button>
          <button type="button" class="aw__btn" onClick={() => void confirmAwake(10)} title="Quiet for 10 minutes">Snooze</button>
          <button type="button" class="aw__btn aw__btn--stop" classList={{ armed: armStop() }} onClick={stop}>{armStop() ? 'Tap to stop' : 'Stop'}</button>
        </div>
      </div>
    </div>
  )

  const Done = () => (
    <div class="aw__done" onClick={dismissCelebration}>
      <svg class="aw__check" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="23" class="aw__check-ring" /><path d="M15 27.5 22.5 35 37 19" class="aw__check-tick" /></svg>
      <div class="aw__done-text">
        <strong>Nice work</strong>
        <span>You stayed up until {formatClock(awakeCelebration()?.endMs ?? Date.now())}{(awakeCelebration()?.alarms ?? 0) > 0 ? ` · ${awakeCelebration()?.alarms} check-ins` : ''}</span>
      </div>
    </div>
  )

  return (
    <section class="wk aw" data-state={state()} style={rootStyle()} aria-label="Keep me awake">
      <Show when={state() === 'pending'} fallback={
        <header class="wk-head aw__head">
          <span class="wk-title">
            <span class="wk-glyph aw__badge">{state() === 'idle' || state() === 'done' ? <Moon size={13} strokeWidth={2} /> : <BellRing size={13} strokeWidth={2} />}</span>
            <span>Keep me awake</span>
          </span>
          <span class="wk-sub aw__sub">{subtitle()}</span>
        </header>
      }>
        <button type="button" class="aw__toast" onClick={() => void confirmAwake()} aria-live="assertive">
          <BellRing size={16} strokeWidth={2.2} aria-hidden="true" />
          <span class="aw__toast-text"><strong>Still here?</strong><span>Tap to confirm</span></span>
          <For each={[awakeStatus().seq]}>{() => <span class="aw__toast-bar" aria-hidden="true" />}</For>
        </button>
      </Show>
      <div class="aw__body">
        <Show when={state() === 'idle'}><Setup /></Show>
        <Show when={state() === 'active' || state() === 'pending'}><Hero /></Show>
        <Show when={state() === 'done'}><Done /></Show>
      </div>
    </section>
  )
}
