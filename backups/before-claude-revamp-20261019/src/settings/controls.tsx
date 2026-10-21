import { Show, type JSX } from 'solid-js'

export function Toggle(props: {
  label: string
  hint?: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <button
      type="button"
      class="set-row set-row--action"
      role="switch"
      aria-checked={props.checked}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="set-row__text">
        <strong>{props.label}</strong>
        <Show when={props.hint}>
          <small>{props.hint}</small>
        </Show>
      </span>
      <span class="set-switch" classList={{ 'set-switch--on': props.checked }}>
        <span />
      </span>
    </button>
  )
}

export function Field(props: { label: string; hint?: string; children: JSX.Element }) {
  return (
    <div class="set-row">
      <span class="set-row__text">
        <strong>{props.label}</strong>
        <Show when={props.hint}>
          <small>{props.hint}</small>
        </Show>
      </span>
      <span class="set-row__control">{props.children}</span>
    </div>
  )
}

export function Slider(props: {
  label: string
  hint?: string
  min: number
  max: number
  step: number
  value: number
  onInput: (value: number) => void
}) {
  return (
    <label class="set-row">
      <span class="set-row__text">
        <strong>{props.label}</strong>
        <Show when={props.hint}>
          <small>{props.hint}</small>
        </Show>
      </span>
      <span class="set-row__control">
        <input
          type="range"
          min={props.min}
          max={props.max}
          step={props.step}
          value={props.value}
          onInput={(event) => props.onInput(event.currentTarget.valueAsNumber)}
        />
      </span>
    </label>
  )
}

export function Group(props: { title: string; description?: string; children: JSX.Element }) {
  return (
    <section class="set-group">
      <div class="set-group__head">
        <h2>{props.title}</h2>
        <Show when={props.description}>
          <p>{props.description}</p>
        </Show>
      </div>
      <div class="set-card">{props.children}</div>
    </section>
  )
}
