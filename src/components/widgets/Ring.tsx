import type { JSX } from 'solid-js'

/** Activity-ring style gauge. `value` is 0..1; children render centred inside. */
export default function Ring(props: { value: number | null; color: string; label: string; stroke?: number; children?: JSX.Element; class?: string }) {
  const stroke = () => props.stroke ?? 9
  const radius = () => 50 - stroke() / 2
  const circumference = () => 2 * Math.PI * radius()
  const clamped = () => Math.max(0, Math.min(1, props.value ?? 0))
  return (
    <div class={`wk-ring ${props.class ?? ''}`} role="img" aria-label={props.label}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r={radius()} fill="none" stroke={props.color} stroke-opacity=".2" stroke-width={stroke()} />
        <circle
          cx="50" cy="50" r={radius()} fill="none" stroke={props.color} stroke-width={stroke()} stroke-linecap="round"
          stroke-dasharray={`${circumference() * clamped()} ${circumference()}`}
          transform="rotate(-90 50 50)"
          style={{ transition: 'stroke-dasharray 500ms cubic-bezier(.22,1,.36,1)', opacity: props.value == null ? 0 : 1 }}
        />
      </svg>
      <div class="wk-ring__inner">{props.children}</div>
    </div>
  )
}
