import { For, Show } from 'solid-js'
import { Timer, Pause, Play, RotateCcw } from 'lucide-solid'
import { focusTimer,formatFocus,startFocus,pauseFocus,resetFocus } from '../../state/focus'
export default function FocusView() {
  return <><header class="widget__head"><span class="widget__title"><Timer size={15}/>Focus</span><span class="widget__eyebrow">{focusTimer().completed?'Complete':focusTimer().endsAt?'In progress':'One thing at a time'}</span></header><div class="focus-clock" role="timer">{formatFocus(focusTimer().remaining)}</div><div class="focus-controls"><div class="focus-presets"><For each={[25,45,5]}>{minutes=><button disabled={!!focusTimer().endsAt} classList={{ selected:focusTimer().duration===minutes*60 }} onClick={()=>resetFocus(minutes)}>{minutes===5?'Break':`${minutes}m`}</button>}</For></div><button class="icon-button" aria-label={focusTimer().endsAt?'Pause focus':'Start focus'} onClick={()=>focusTimer().endsAt?pauseFocus():startFocus()}><Show when={focusTimer().endsAt} fallback={<Play size={17}/>}><Pause size={17}/></Show></button><button class="icon-button" aria-label="Reset focus" onClick={()=>resetFocus()}><RotateCcw size={14}/></button></div></>
}
