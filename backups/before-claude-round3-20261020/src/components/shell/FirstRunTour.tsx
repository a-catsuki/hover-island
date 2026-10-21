import { createMemo, For, onCleanup, onMount, Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import { settings } from '../../state/settings'
import {
  endTour,
  extendTourBounds,
  finishFirstRun,
  goToOnboardingStep,
  nextOnboardingStep,
  previousOnboardingStep,
  tourActive,
  tourCollapsed,
  tourGoal,
  tourIndex,
  tourPlan,
} from '../../state/onboarding'
import { placeCaption, shortcutKeys, tourText, type TourRect, type TourStepSpec } from '../../lib/onboardingConfig'
import TourCursor from './TourCursor'
import './FirstRunTour.css'

/*
 * The tour caption card. It floats over the real island (the cursor and ring
 * are TourCursor), so it lives in a portal on the body and is never clipped by
 * the island shape. Arrow keys, Enter and Esc work from anywhere.
 */

const INTERACTIVE = 'input, textarea, select, [contenteditable="true"]'

function islandRect(): TourRect {
  const el = document.querySelector<HTMLElement>('.island')
  const host = el?.getBoundingClientRect()
  const hostRect = host ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight }
  const w = Math.min(hostRect.width, parseFloat(el?.style.getPropertyValue('--island-spring-width') ?? '') || hostRect.width)
  const h = Math.min(hostRect.height, parseFloat(el?.style.getPropertyValue('--island-spring-height') ?? '') || hostRect.height)
  const edge = settings.placement.edge
  const x = edge === 'left' ? hostRect.left : edge === 'right' ? hostRect.right - w : hostRect.left + (hostRect.width - w) / 2
  const y = edge === 'bottom' ? hostRect.bottom - h : hostRect.top
  return { x, y, w, h }
}

function Keys(props: { shortcut: string }) {
  return <span class="tour-keys"><For each={shortcutKeys(props.shortcut)}>{key => <kbd class="tour-key">{key}</kbd>}</For></span>
}

function TourLayer() {
  let card: HTMLElement | undefined
  let frame = 0
  let placed = false
  let lastKey = ''
  let stableSince = 0
  let extendedFor = -1

  const step = createMemo<TourStepSpec | undefined>(() => tourPlan()[tourIndex()])
  const total = () => tourPlan().length
  const isLast = () => tourIndex() >= total() - 1
  const text = (value: string) => tourText(value, { open: settings.hotkey, search: settings.spotlightHotkey })
  const shortcutFor = (key: 'open' | 'search') => key === 'open' ? settings.hotkey : settings.spotlightHotkey

  const next = () => (isLast() ? finishFirstRun() : nextOnboardingStep())
  const skip = () => finishFirstRun()

  const place = () => {
    frame = requestAnimationFrame(place)
    if (!card) return
    const size = { w: card.offsetWidth, h: card.offsetHeight }
    const goal = tourGoal()
    const rect = goal?.el.isConnected ? goal.el.getBoundingClientRect() : null
    const target = rect ? { x: rect.left, y: rect.top, w: rect.width, h: rect.height } : null
    const collapsed = tourCollapsed()
    const island = islandRect()
    const point = placeCaption({ viewport: { w: window.innerWidth, h: window.innerHeight }, island, card: size, target, collapsed })
    const key = `${point.x},${point.y}`
    if (key !== lastKey) { lastKey = key; stableSince = performance.now() }
    card.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`
    if (!placed) { placed = true; card.dataset.ready = 'true' }
    // A collapsed pill leaves the caption outside the native hit area, so ask
    // the window to treat the caption as part of the island while this step runs.
    if (collapsed && extendedFor !== tourIndex() && performance.now() - stableSince > 300) {
      extendedFor = tourIndex()
      extendTourBounds(Math.max(size.w, island.w) + 8, point.y + size.h + 10 - island.y)
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      skip()
      return
    }
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
    const target = event.target as HTMLElement | null
    if (target?.matches?.(INTERACTIVE)) return
    const onButton = !!target && target instanceof HTMLButtonElement
    let handled = true
    if (event.key === 'ArrowRight') next()
    else if (event.key === 'ArrowLeft') previousOnboardingStep()
    else if (event.key === 'Enter' && !onButton) next()
    else handled = false
    if (handled) { event.preventDefault(); event.stopImmediatePropagation() }
  }

  onMount(() => {
    frame = requestAnimationFrame(place)
    window.addEventListener('keydown', onKeyDown, true)
  })
  onCleanup(() => {
    cancelAnimationFrame(frame)
    window.removeEventListener('keydown', onKeyDown, true)
  })

  return <div class="tour-layer">
    <TourCursor/>
    <section ref={card} class="tour-card" role="dialog" aria-label="Hover Island tour" aria-describedby="tour-body" data-ready="false">
      <div class="tour-card__top">
        <span class="tour-card__count" aria-hidden="true">{tourIndex() + 1} of {total()}</span>
        <button type="button" class="tour-card__skip" onClick={skip}>Skip tour</button>
      </div>
      <Show when={step()} keyed>
        {(active: TourStepSpec) => <div class="tour-card__copy" aria-live="polite">
          <h2 class="tour-card__title">{active.title}</h2>
          <p id="tour-body" class="tour-card__body">{text(active.body)}</p>
          <Show when={active.shortcuts}>{items => <div class="tour-card__shortcuts">
            <For each={items()}>{item => <span class="tour-shortcut"><span>{item.label}</span><Keys shortcut={shortcutFor(item.key)}/></span>}</For>
          </div>}</Show>
        </div>}
      </Show>
      <div class="tour-card__foot">
        <div class="tour-card__dots" role="group" aria-label="Tour steps">
          <For each={tourPlan()}>{(item, index) => <button type="button" aria-label={`Step ${index() + 1}: ${item.title}`} aria-current={index() === tourIndex() ? 'step' : undefined} classList={{ 'is-active': index() === tourIndex() }} onClick={() => goToOnboardingStep(index())}/>}</For>
        </div>
        <div class="tour-card__actions">
          <button type="button" class="tour-card__back" disabled={tourIndex() === 0} onClick={previousOnboardingStep}>Back</button>
          <button type="button" class="tour-card__next" onClick={next}>{isLast() ? 'Done' : 'Next'}</button>
        </div>
      </div>
    </section>
  </div>
}

export default function FirstRunTour() {
  // Mounted by the expanded panel, but rendered on the body so the cursor can
  // also travel over the collapsed pill.
  onCleanup(() => endTour())
  return <Show when={tourActive()}><Portal><TourLayer/></Portal></Show>
}
