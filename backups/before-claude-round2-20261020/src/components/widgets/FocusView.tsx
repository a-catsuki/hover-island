import { For, Show } from 'solid-js'
import { Pause, Play, RotateCcw, Timer } from 'lucide-solid'
import { focusTimer, formatFocus, startFocus, pauseFocus, resetFocus } from '../../state/focus'
import Ring from './Ring'
import './widgetKit.css'
import './FocusView.css'

export default function FocusView() {
  const running = () => !!focusTimer().endsAt
  const progress = () => focusTimer().duration ? focusTimer().remaining / focusTimer().duration : 0
  const status = () => focusTimer().completed ? 'Complete' : running() ? 'In progress' : focusTimer().remaining < focusTimer().duration ? 'Paused' : 'Ready'
  const color = () => focusTimer().completed ? '#30D158' : '#FF9F0A'
  return (
    <section class="wk focus" aria-label="Focus timer">
      <div class="focus__ring-wrap">
        <Ring value={progress()} color={color()} label={`${formatFocus(focusTimer().remaining)} remaining`} stroke={6}>
          <div class="focus__readout">
            <div class="focus-clock" role="timer">{formatFocus(focusTimer().remaining)}</div>
            <span class="focus__status">{status()}</span>
          </div>
        </Ring>
      </div>
      <div class="focus__side">
        <span class="wk-title"><span class="wk-glyph" style={{ background: color() }}><Timer size={13} strokeWidth={2.2} /></span><span>Focus</span></span>
        <div class="focus-presets" role="group" aria-label="Focus length">
          <For each={[25, 45, 5]}>{(minutes) =>
            <button type="button" disabled={running()} classList={{ selected: focusTimer().duration === minutes * 60 }} onClick={() => resetFocus(minutes)}>{minutes === 5 ? 'Break' : `${minutes}m`}</button>
          }</For>
        </div>
        <div class="focus-controls">
          <button type="button" class="focus__go" classList={{ 'focus__go--on': running() }} aria-label={running() ? 'Pause focus' : 'Start focus'} onClick={() => running() ? pauseFocus() : startFocus()}>
            <Show when={running()} fallback={<Play size={20} fill="currentColor" />}><Pause size={20} fill="currentColor" /></Show>
          </button>
          <button type="button" class="focus__reset" aria-label="Reset focus" onClick={() => resetFocus()}><RotateCcw size={16} /></button>
        </div>
      </div>
    </section>
  )
}
