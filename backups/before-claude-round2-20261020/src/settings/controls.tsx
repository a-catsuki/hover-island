import { createEffect, createSignal, For, Show, type JSX } from 'solid-js'

/** Shared search text for the sidebar field. SettingsApp filters rows and groups with it. */
export const [searchQuery, setSearchQuery] = createSignal('')

function RowText(props: { label: string; hint?: string }) {
  return (
    <span class="set-row__text">
      <strong>{props.label}</strong>
      <Show when={props.hint}>
        <small>{props.hint}</small>
      </Show>
    </span>
  )
}

/** Bare switch. Use inside your own row; give it an aria-label. */
export function Switch(props: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      class="set-switch"
      classList={{ 'set-switch--on': props.checked }}
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span />
    </button>
  )
}

/** A whole row that is a switch. */
export function Toggle(props: {
  label: string
  hint?: string
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      class="set-row set-row--action"
      role="switch"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <RowText label={props.label} hint={props.hint} />
      <span class="set-switch" classList={{ 'set-switch--on': props.checked }}>
        <span />
      </span>
    </button>
  )
}

/** Label on the left, any control on the right. */
export function Field(props: { label: string; hint?: string; children: JSX.Element }) {
  return (
    <div class="set-row">
      <RowText label={props.label} hint={props.hint} />
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
  const fill = () => `${Math.max(0, Math.min(1, (props.value - props.min) / (props.max - props.min || 1))) * 100}%`
  return (
    <label class="set-row">
      <RowText label={props.label} hint={props.hint} />
      <span class="set-row__control">
        <input
          class="set-range"
          type="range"
          aria-label={props.label}
          min={props.min}
          max={props.max}
          step={props.step}
          value={props.value}
          style={{ '--fill': fill() }}
          onInput={(event) => props.onInput(event.currentTarget.valueAsNumber)}
        />
      </span>
    </label>
  )
}

/** Pop-up button row. Pass options as [value, label] pairs. */
export function Select<T extends string>(props: {
  label: string
  hint?: string
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (value: T) => void
  ariaLabel?: string
}) {
  let el: HTMLSelectElement | undefined
  // Keep the DOM value in step with the store when options or the value change from outside.
  createEffect(() => {
    const value = props.value
    props.options.length
    queueMicrotask(() => { if (el && el.value !== value) el.value = value })
  })
  return (
    <div class="set-row">
      <RowText label={props.label} hint={props.hint} />
      <span class="set-row__control">
        <span class="set-select">
          <select ref={el} aria-label={props.ariaLabel ?? props.label} value={props.value} onChange={(event) => props.onChange(event.currentTarget.value as T)}>
            <For each={props.options}>{([value, label]) => <option value={value} selected={value === props.value}>{label}</option>}</For>
          </select>
          <svg viewBox="0 0 10 14" width="8" height="11" aria-hidden="true"><path d="M2 5.2 5 2l3 3.2M2 8.8 5 12l3-3.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </span>
      </span>
    </div>
  )
}

/** Segmented control with a sliding thumb. */
export function Segmented<T extends string>(props: {
  label?: string
  hint?: string
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (value: T) => void
  ariaLabel: string
}) {
  const index = () => Math.max(0, props.options.findIndex(([value]) => value === props.value))
  const control = (
    <div class="set-seg" role="radiogroup" aria-label={props.ariaLabel} style={{ '--n': props.options.length, '--i': index() }}>
      <span class="set-seg__thumb" aria-hidden="true" />
      <For each={props.options}>{([value, label]) => (
        <button type="button" role="radio" aria-checked={props.value === value} classList={{ 'set-seg__item--on': props.value === value }} onClick={() => props.onChange(value)}>{label}</button>
      )}</For>
    </div>
  )
  return (
    <Show when={props.label} fallback={control}>
      <div class="set-row">
        <RowText label={props.label!} hint={props.hint} />
        <span class="set-row__control">{control}</span>
      </div>
    </Show>
  )
}

/** Small heading inside a group, for splitting one card into parts. */
export function Subhead(props: { title: string; hint?: string }) {
  return (
    <div class="set-subhead">
      <strong>{props.title}</strong>
      <Show when={props.hint}>
        <small>{props.hint}</small>
      </Show>
    </div>
  )
}

/**
 * Inset grouped list. `title` renders as the caption above the card and
 * `description` as help text below it. `flush` removes the card padding for
 * content that brings its own (pickers, lists).
 */
export function Group(props: { title?: string; description?: string; flush?: boolean; children: JSX.Element }) {
  return (
    <section class="set-group" data-search-title={`${props.title ?? ''} ${props.description ?? ''}`}>
      <Show when={props.title}>
        <h2 class="set-group__caption">{props.title}</h2>
      </Show>
      <div class="set-card" classList={{ 'set-card--flush': props.flush }}>{props.children}</div>
      <Show when={props.description}>
        <p class="set-group__footer">{props.description}</p>
      </Show>
    </section>
  )
}
