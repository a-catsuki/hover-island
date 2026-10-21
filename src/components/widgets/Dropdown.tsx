import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, Show, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'
import './Dropdown.css'

export interface DropdownOption<T extends string = string> {
  value: T
  label: string
  /** small secondary text shown under or beside the label */
  detail?: string
  disabled?: boolean
  icon?: JSX.Element
}

export interface DropdownProps<T extends string = string> {
  value: T
  options: DropdownOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  /** text shown when `value` matches no option */
  placeholder?: string
  disabled?: boolean
  /** `sm` is a 24px control for inline settings rows, `md` is 30px */
  size?: 'sm' | 'md'
  /** which edge of the trigger the menu lines up with */
  align?: 'start' | 'end'
  class?: string
  id?: string
}

const GAP = 6
const EDGE = 8

/**
 * A dark, Apple-style pop-up menu that replaces the native <select>, which draws a
 * white system list inside the dark webview and is clipped by the island. The
 * menu renders in a portal at the end of <body>, so no parent can clip it, and it
 * flips above the trigger when there is no room below.
 *
 * Keyboard: Enter, Space, Arrow keys open it; Arrow keys, Home, End and typing
 * move; Enter or Space picks; Escape closes without picking; Tab closes.
 */
export default function Dropdown<T extends string = string>(props: DropdownProps<T>): JSX.Element {
  const uid = createUniqueId()
  const listId = `dd-list-${uid}`
  const optionId = (index: number) => `dd-opt-${uid}-${index}`
  let trigger: HTMLButtonElement | undefined
  let menu: HTMLDivElement | undefined
  const [open, setOpen] = createSignal(false)
  const [active, setActive] = createSignal(-1)
  const [place, setPlace] = createSignal<{ left: number; top: number; minWidth: number; maxHeight: number; up: boolean } | null>(null)
  let typed = ''
  let typedTimer: number | undefined

  const selected = createMemo(() => props.options.findIndex(option => option.value === props.value))
  const label = () => props.options[selected()]?.label ?? props.placeholder ?? ''
  const enabledIndexes = () => props.options.flatMap((option, index) => option.disabled ? [] : [index])

  const measure = () => {
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const wanted = Math.min(props.options.length * 32 + 12, 320)
    const below = viewportHeight - rect.bottom - GAP - EDGE
    const above = rect.top - GAP - EDGE
    const up = below < Math.min(wanted, 160) && above > below
    const maxHeight = Math.max(96, Math.min(320, up ? above : below))
    const width = Math.max(rect.width, menu?.offsetWidth ?? 0)
    let left = props.align === 'end' ? rect.right - width : rect.left
    left = Math.max(EDGE, Math.min(left, viewportWidth - width - EDGE))
    const height = Math.min(maxHeight, menu?.scrollHeight ?? wanted)
    const top = up ? rect.top - GAP - height : rect.bottom + GAP
    setPlace({ left, top, minWidth: rect.width, maxHeight, up })
  }

  const close = (restoreFocus = true) => {
    setOpen(false)
    setActive(-1)
    if (restoreFocus) trigger?.focus({ preventScroll: true })
  }
  const openMenu = (focusLast = false) => {
    if (props.disabled || !props.options.length) return
    const enabled = enabledIndexes()
    if (!enabled.length) return
    setActive(selected() >= 0 && !props.options[selected()].disabled ? selected() : focusLast ? enabled[enabled.length - 1] : enabled[0])
    setOpen(true)
    measure()
    // The menu mounts with the open flag; measure again once it has a real size.
    requestAnimationFrame(measure)
  }
  const choose = (index: number) => {
    const option = props.options[index]
    if (!option || option.disabled) return
    close()
    if (option.value !== props.value) props.onChange(option.value)
  }
  const step = (delta: number) => {
    const enabled = enabledIndexes()
    if (!enabled.length) return
    const at = enabled.indexOf(active())
    const next = at < 0 ? (delta > 0 ? 0 : enabled.length - 1) : Math.max(0, Math.min(enabled.length - 1, at + delta))
    setActive(enabled[next])
  }
  const jump = (first: boolean) => {
    const enabled = enabledIndexes()
    if (enabled.length) setActive(first ? enabled[0] : enabled[enabled.length - 1])
  }
  const typeAhead = (key: string) => {
    window.clearTimeout(typedTimer)
    typed += key.toLowerCase()
    typedTimer = window.setTimeout(() => { typed = '' }, 600)
    const enabled = enabledIndexes()
    const start = Math.max(0, enabled.indexOf(active()))
    // A repeated single letter cycles through matches; otherwise match the typed prefix.
    const order = [...enabled.slice(start + (typed.length === 1 ? 1 : 0)), ...enabled.slice(0, start + (typed.length === 1 ? 1 : 0))]
    const hit = order.find(index => props.options[index].label.toLowerCase().startsWith(typed))
    if (hit !== undefined) setActive(hit)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (props.disabled) return
    if (!open()) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault()
        openMenu(event.key === 'ArrowUp')
      }
      return
    }
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); step(1); break
      case 'ArrowUp': event.preventDefault(); step(-1); break
      case 'Home': event.preventDefault(); jump(true); break
      case 'End': event.preventDefault(); jump(false); break
      case 'PageDown': event.preventDefault(); step(5); break
      case 'PageUp': event.preventDefault(); step(-5); break
      case 'Enter': case ' ': event.preventDefault(); if (active() >= 0) choose(active()); else close(); break
      // The island also closes on Escape; this menu takes the first press.
      case 'Escape': event.preventDefault(); event.stopPropagation(); close(); break
      case 'Tab': close(false); break
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); typeAhead(event.key) }
    }
  }

  createEffect(() => {
    if (!open()) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && (trigger?.contains(target) || menu?.contains(target))) return
      close(false)
    }
    const reflow = (event?: Event) => {
      // Scrolling inside the menu itself must not dismiss it.
      if (event?.target instanceof Node && menu?.contains(event.target)) return
      measure()
    }
    const blur = () => close(false)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', reflow)
    window.addEventListener('scroll', reflow, true)
    window.addEventListener('blur', blur)
    onCleanup(() => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', reflow)
      window.removeEventListener('scroll', reflow, true)
      window.removeEventListener('blur', blur)
    })
  })

  // Keep the highlighted row in view while arrowing through a long list.
  createEffect(() => {
    const index = active()
    if (!open() || index < 0) return
    document.getElementById(optionId(index))?.scrollIntoView({ block: 'nearest' })
  })
  onCleanup(() => window.clearTimeout(typedTimer))

  return (
    <>
      <button
        ref={trigger}
        id={props.id}
        type="button"
        class={`dd ${props.class ?? ''}`}
        classList={{ 'dd--open': open(), 'dd--sm': props.size === 'sm', 'dd--empty': selected() < 0 }}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-controls={open() ? listId : undefined}
        aria-activedescendant={open() && active() >= 0 ? optionId(active()) : undefined}
        aria-label={props.ariaLabel}
        disabled={props.disabled}
        onClick={() => open() ? close() : openMenu()}
        on:keydown={onKeyDown}
      >
        <span class="dd__label">{label()}</span>
        <svg class="dd__chevron" viewBox="0 0 10 14" width="8" height="11" aria-hidden="true">
          <path d="M2 5.2 5 2l3 3.2M2 8.8 5 12l3-3.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={menu}
            id={listId}
            class="dd-menu"
            classList={{ 'dd-menu--up': place()?.up, 'dd-menu--ready': !!place() }}
            role="listbox"
            aria-label={props.ariaLabel}
            tabindex="-1"
            style={{
              left: `${place()?.left ?? 0}px`,
              top: `${place()?.top ?? 0}px`,
              'min-width': `${place()?.minWidth ?? 0}px`,
              'max-height': `${place()?.maxHeight ?? 320}px`,
            }}
            // Keep focus on the trigger so the keyboard keeps working after a click.
            onMouseDown={event => event.preventDefault()}
          >
            <For each={props.options}>{(option, index) => (
              <div
                id={optionId(index())}
                class="dd-option"
                classList={{ 'dd-option--active': active() === index(), 'dd-option--selected': selected() === index(), 'dd-option--disabled': option.disabled }}
                role="option"
                aria-selected={selected() === index()}
                aria-disabled={option.disabled || undefined}
                onPointerEnter={() => { if (!option.disabled) setActive(index()) }}
                onClick={() => choose(index())}
              >
                <span class="dd-option__check" aria-hidden="true">
                  <Show when={selected() === index()}>
                    <svg viewBox="0 0 12 12" width="11" height="11"><path d="m2.4 6.4 2.4 2.4 4.8-5.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                  </Show>
                </span>
                <Show when={option.icon}><span class="dd-option__icon">{option.icon}</span></Show>
                <span class="dd-option__text">
                  <span class="dd-option__label">{option.label}</span>
                  <Show when={option.detail}><span class="dd-option__detail">{option.detail}</span></Show>
                </span>
              </div>
            )}</For>
          </div>
        </Portal>
      </Show>
    </>
  )
}
