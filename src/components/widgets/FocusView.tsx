import { For, Show } from 'solid-js'
import { Bell, BellOff, Minus, Pause, Play, Plus, RotateCcw, SkipForward } from 'lucide-solid'
import {
  FOCUS_MODES, FOCUS_MODE_LABEL, SESSIONS_PER_CYCLE, focusSessionsToday, focusTimer, formatFocus, nudgeFocusMinutes,
  pauseFocus, resetFocus, setFocusMode, skipFocus, startFocus, toggleFocusAlerts, type FocusMode,
} from '../../state/focus'
import '../../state/focusAlerts'
import Ring from './Ring'
import './widgetKit.css'
import './FocusView.css'

const PRESETS: Record<FocusMode, number[]> = { focus: [15, 25, 45, 60], short: [3, 5, 10], long: [15, 20, 30] }
const COLOR: Record<FocusMode, string> = { focus: '#FF9F0A', short: '#30D158', long: '#64D2FF' }

export default function FocusView() {
  const timer = focusTimer
  const running = () => !!timer().endsAt
  const mode = () => timer().mode
  const progress = () => timer().duration ? timer().remaining / timer().duration : 0
  const color = () => COLOR[mode()]
  const idle = () => !running() && timer().remaining >= timer().duration
  const status = () => timer().completed ? 'Session done' : running() ? FOCUS_MODE_LABEL[mode()] : idle() ? 'Ready' : 'Paused'
  const sessions = () => focusSessionsToday()
  // Dots count sessions inside the current set of four; a finished set shows all four.
  const filled = () => sessions() > 0 && sessions() % SESSIONS_PER_CYCLE === 0 && mode() === 'long' ? SESSIONS_PER_CYCLE : sessions() % SESSIONS_PER_CYCLE
  const minutes = () => timer().durations[mode()]
  return (
    <section class="wk focus-host" style={{ '--focus-color': color() }} data-mode={mode()} data-running={running() ? '' : undefined} aria-label="Focus timer">
      <div class="focus">
      <div class="focus__ring-wrap">
        <Ring value={progress()} color={color()} label={`${formatFocus(timer().remaining)} remaining`} stroke={6}>
          <div class="focus__readout">
            <div class="focus-clock" role="timer">{formatFocus(timer().remaining)}</div>
            <span class="focus__status">{status()}</span>
          </div>
        </Ring>
      </div>
      <div class="focus__side">
        <div class="focus__top">
          <div class="focus-seg" role="radiogroup" aria-label="Timer mode" style={{ '--i': FOCUS_MODES.indexOf(mode()) }}>
            <span class="focus-seg__thumb" aria-hidden="true" />
            <For each={FOCUS_MODES}>{(item) =>
              <button type="button" role="radio" aria-checked={mode() === item} disabled={running()} classList={{ on: mode() === item }}
                title={running() ? 'Pause the timer to change mode' : undefined} onClick={() => setFocusMode(item)}>
                <span class="focus-seg__full">{FOCUS_MODE_LABEL[item]}</span>
                <span class="focus-seg__short">{item === 'focus' ? 'Focus' : item === 'short' ? 'Break' : 'Long'}</span>
              </button>
            }</For>
          </div>
          <button type="button" class="wk-icon-btn focus__bell" aria-pressed={timer().alerts} aria-label={timer().alerts ? 'Turn off end of session alerts' : 'Turn on end of session alerts'}
            title={timer().alerts ? 'Alert and chime at the end' : 'Alerts are off'} onClick={toggleFocusAlerts}>
            <Show when={timer().alerts} fallback={<BellOff size={15} />}><Bell size={15} /></Show>
          </button>
        </div>
        <div class="focus__adjust" role="group" aria-label={`${FOCUS_MODE_LABEL[mode()]} length`}>
          <button type="button" class="wk-icon-btn" disabled={running() || minutes() <= 1} aria-label="Shorter" onClick={() => nudgeFocusMinutes(-1)}><Minus size={15} /></button>
          <span class="focus__minutes"><strong>{minutes()}</strong> min</span>
          <button type="button" class="wk-icon-btn" disabled={running() || minutes() >= 180} aria-label="Longer" onClick={() => nudgeFocusMinutes(1)}><Plus size={15} /></button>
        </div>
        <div class="focus-presets" role="group" aria-label="Preset lengths">
          <For each={PRESETS[mode()]}>{(value) =>
            <button type="button" disabled={running()} classList={{ selected: minutes() === value }} onClick={() => resetFocus(value)}>{value}m</button>
          }</For>
        </div>
        <div class="focus-controls">
          <button type="button" class="focus__reset" aria-label="Reset timer" title="Reset" onClick={() => resetFocus()}><RotateCcw size={16} /></button>
          <button type="button" class="focus__go" classList={{ 'focus__go--on': running() }} aria-label={running() ? 'Pause timer' : timer().completed ? `Start ${FOCUS_MODE_LABEL[mode()].toLowerCase()}` : 'Start timer'} onClick={() => running() ? pauseFocus() : startFocus()}>
            <Show when={running()} fallback={<Play size={22} fill="currentColor" />}><Pause size={22} fill="currentColor" /></Show>
          </button>
          <button type="button" class="focus__reset" aria-label={mode() === 'focus' ? 'Skip to break' : 'Skip to focus'} title="Skip" onClick={skipFocus}><SkipForward size={16} /></button>
        </div>
        <div class="focus__sessions" title="Focus sessions finished today" aria-label={`${sessions()} focus ${sessions() === 1 ? 'session' : 'sessions'} today`}>
          <span class="focus__dots" aria-hidden="true"><For each={Array.from({ length: SESSIONS_PER_CYCLE })}>{(_, index) => <i classList={{ on: index() < filled() }} />}</For></span>
          <span class="focus__count">{sessions()} today</span>
        </div>
      </div>
      </div>
    </section>
  )
}
