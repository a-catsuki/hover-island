import { For } from 'solid-js'

const HOURS = ['twelve', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven']
const MINUTES = ['', 'five past', 'ten past', 'quarter past', 'twenty past', 'twenty-five past', 'half past', 'twenty-five to', 'twenty to', 'quarter to', 'ten to', 'five to']

/** "It's almost quarter past ten": the time as a phrase, to the nearest five minutes. */
export function timeInWords(date: Date): { lead: string; minutes: string; hour: string; period: string } {
  const total = date.getHours() * 60 + date.getMinutes()
  const rounded = Math.round(total / 5) * 5
  const off = total - rounded
  const step = (rounded % 60) / 5
  const hour24 = Math.floor(((step > 6 ? rounded + 60 : rounded) / 60)) % 24
  const lead = off < 0 ? 'It’s almost' : off > 0 ? 'It’s just after' : 'It’s'
  const hour = hour24 === 0 && step === 0 ? 'midnight' : hour24 === 12 && step === 0 ? 'noon' : HOURS[hour24 % 12]
  const named = hour === 'midnight' || hour === 'noon'
  const period = named ? '' : hour24 < 5 ? 'at night' : hour24 < 12 ? 'in the morning' : hour24 < 17 ? 'in the afternoon' : hour24 < 21 ? 'in the evening' : 'at night'
  return { lead, minutes: MINUTES[step], hour: step === 0 && !named ? `${hour} o’clock` : hour, period }
}

export function WordsClock(props: { now: Date }) {
  const words = () => timeInWords(props.now)
  return (
    <div class="clock-words" aria-label={`${words().lead} ${words().minutes} ${words().hour} ${words().period}`}>
      <span class="clock-words__lead">{words().lead}</span>
      {words().minutes ? <span class="clock-words__soft">{words().minutes}</span> : null}
      <span class="clock-words__hour">{words().hour}</span>
      {words().period ? <span class="clock-words__soft clock-words__period">{words().period}</span> : null}
    </div>
  )
}

/** Hours over minutes, heavy and tight, the way a phone lock screen stacks them. */
export function StackedClock(props: { hours: string; minutes: string }) {
  return (
    <div class="clock-stacked">
      <span>{props.hours}</span>
      <span>{props.minutes}</span>
    </div>
  )
}

/**
 * A watch face. The hands turn by total angle since midnight, so the second hand sweeps on past
 * twelve instead of spinning back.
 */
export function AnalogClock(props: { now: Date }) {
  const seconds = () => props.now.getHours() * 3600 + props.now.getMinutes() * 60 + props.now.getSeconds()
  const ticks = Array.from({ length: 60 }, (_, index) => index)
  return (
    <svg class="clock-analog" viewBox="0 0 200 200" aria-hidden="true">
      <circle class="clock-analog__face" cx="100" cy="100" r="96" />
      <For each={ticks}>{index => {
        const hour = index % 5 === 0
        const angle = (index / 60) * Math.PI * 2
        const inner = hour ? 80 : 86
        return <line class="clock-analog__tick" classList={{ 'clock-analog__tick--hour': hour }} x1={100 + Math.sin(angle) * inner} y1={100 - Math.cos(angle) * inner} x2={100 + Math.sin(angle) * 90} y2={100 - Math.cos(angle) * 90} />
      }}</For>
      <line class="clock-analog__hand clock-analog__hand--hour" x1="100" y1="108" x2="100" y2="52" style={{ transform: `rotate(${seconds() / 120}deg)` }} />
      <line class="clock-analog__hand clock-analog__hand--minute" x1="100" y1="110" x2="100" y2="24" style={{ transform: `rotate(${seconds() / 10}deg)` }} />
      <line class="clock-analog__hand clock-analog__hand--second" x1="100" y1="116" x2="100" y2="16" style={{ transform: `rotate(${seconds() * 6}deg)` }} />
      <circle class="clock-analog__pin" cx="100" cy="100" r="3.5" />
    </svg>
  )
}
