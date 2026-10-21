import { batch, createSignal } from 'solid-js'
import { browserPreview, cmd, listen } from '../lib/ipc'
import { widgetPanel } from '../lib/panels'
import { FIRST_RUN_STEP_COUNT, planTour, shouldShowFirstRun, tourWidgetKind, type TourStepSpec } from '../lib/onboardingConfig'
import { patchSettings, settings } from './settings'
import { collapseIsland, expandIsland, expanded, open, pinned, setPinned } from './ui'
import { activePanel, setActivePanel, showControls, showFileBucket } from './panel'

/*
 * The first-run tour: a virtual cursor that drives the real island.
 *
 * It only calls exported helpers from ui.ts and panel.ts, never reaches into
 * their signals. While it runs the island is held open with `setPinned`, and
 * everything it changed (pin, panel, expanded) is put back when it ends.
 * Nothing it does writes settings except the final "seen" flag.
 */

export const FIRST_RUN_VERSION = 1
export { shouldShowFirstRun, FIRST_RUN_STEP_COUNT }

export interface TourGoal {
  id: number
  el: Element
  /** Where on the element the cursor tip lands, 0..1. */
  ax: number
  ay: number
}

const [tourActive, setTourActive] = createSignal(false)
const [tourIndex, setTourIndex] = createSignal(0)
const [tourPlan, setTourPlan] = createSignal<TourStepSpec[]>([])
const [tourGoal, setTourGoal] = createSignal<TourGoal | null>(null)
/** Bumps on every virtual click so the cursor can ripple. */
const [tourClickTick, setTourClickTick] = createSignal(0)
/** True while the current step wants the collapsed pill (the caption sits below it). */
const [tourCollapsed, setTourCollapsed] = createSignal(false)

/** Legacy flag from the old full-screen sheet. The tour now runs over the live
 * island, so this stays false and `tourActive` is the one to read. */
const [onboardingOpen] = createSignal(false)

export { onboardingOpen, tourActive, tourIndex, tourPlan, tourGoal, tourClickTick, tourCollapsed }
export const onboardingStep = tourIndex

interface Saved { expanded: boolean; pinned: boolean; panel: string }
let saved: Saved | null = null
let runToken = 0
let goalSeq = 0
let boundsExtended = false
const waiters = new Map<number, () => void>()

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean, timeout = 1500): Promise<boolean> {
  const started = performance.now()
  while (!condition()) {
    if (performance.now() - started > timeout) return false
    await sleep(25)
  }
  return true
}

function visible(el: Element | null | undefined): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false
  const rect = el.getBoundingClientRect()
  return rect.width > 1 && rect.height > 1
}

function resolveOnce(specs: string[]): HTMLElement | null {
  for (const spec of specs) {
    if (spec.startsWith('tab:')) {
      const tabs = document.querySelectorAll<HTMLElement>('.panel-tabs [role="tab"]')
      const tab = tabs[Number(spec.slice(4))]
      if (visible(tab)) return tab
      continue
    }
    const el = document.querySelector(spec)
    if (visible(el)) return el
  }
  return null
}

async function resolveTarget(specs: string[], alive: () => boolean): Promise<HTMLElement | null> {
  for (let attempt = 0; attempt < 24; attempt++) {
    if (!alive()) return null
    const el = resolveOnce(specs)
    if (el) return el
    await sleep(30)
  }
  return null
}

/** Called by the cursor layer when it has reached a goal. */
export function reportTourArrived(id: number): void {
  waiters.get(id)?.()
}

function releaseWaiters(): void {
  for (const done of [...waiters.values()]) done()
}

function pointAt(el: Element, ax = 0.5, ay = 0.5): Promise<void> {
  const id = ++goalSeq
  setTourGoal({ id, el, ax, ay })
  return new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); waiters.delete(id); resolve() }
    const timer = setTimeout(done, 2400)
    waiters.set(id, done)
  })
}

function click(): Promise<void> {
  setTourClickTick(tick => tick + 1)
  return sleep(110)
}

/** The pill steps need a top notch. Other placements get the expanded view. */
function collapsedSupported(): boolean {
  return settings.placement.mode === 'notch' && settings.placement.edge === 'top'
}

function enabledKinds(): string[] {
  return settings.widgets.filter(widget => widget.enabled).map(widget => widget.kind)
}

function panelForKind(kind: string): string | null {
  const widget = settings.widgets.find(item => item.enabled && item.kind === kind)
  return widget ? widgetPanel(widget, settings.panelOrder) : null
}

async function ensureCollapsed(): Promise<void> {
  if (expanded() || open()) {
    collapseIsland()
    await waitFor(() => !expanded(), 2000)
    await sleep(80)
  }
}

async function ensureExpanded(): Promise<void> {
  if (!open()) {
    expandIsland()
    await waitFor(() => open(), 2000)
    // Let the width and height spring settle before measuring anything.
    await sleep(220)
  }
}

async function showPanelFor(kind: string | null): Promise<void> {
  const panel = kind ? panelForKind(kind) : null
  if (panel && activePanel() !== panel) {
    setActivePanel(panel)
    await sleep(320)
  }
}

/** Tells the native side the caption below a collapsed pill is clickable. */
export function extendTourBounds(width: number, height: number): void {
  if (browserPreview || !tourActive()) return
  boundsExtended = true
  void cmd.setInteractionBounds(Math.round(width), Math.round(height)).catch(() => {})
}

function restoreBounds(): void {
  if (!boundsExtended) return
  boundsExtended = false
  // Collapsing natively clears any interaction bounds the tour set.
  if (!expanded() && !browserPreview) void cmd.setExpanded(false).catch(() => {})
}

async function performStep(step: TourStepSpec, alive: () => boolean): Promise<void> {
  const kinds = enabledKinds()
  const target = () => resolveTarget(step.target, alive)
  const [ax, ay] = step.anchor

  switch (step.id) {
    case 'pill': {
      const el = await target()
      if (el && alive()) await pointAt(el, ax, ay)
      else if (alive()) setTourGoal(null)
      return
    }
    case 'open': {
      const el = await target()
      if (!el || !alive()) return
      await pointAt(el, ax, ay)
      if (!alive()) return
      await sleep(120)
      await click()
      if (!alive()) return
      expandIsland()
      await waitFor(() => open(), 2000)
      await sleep(240)
      if (!alive()) return
      setTourCollapsed(false)
      const tabs = await resolveTarget(['.panel-tabs'], alive)
      if (tabs && alive()) await pointAt(tabs, 0.5, 0.5)
      return
    }
    case 'pages': {
      const tabs = Array.from(document.querySelectorAll<HTMLElement>('.panel-tabs [role="tab"]'))
      if (tabs.length < 2) return
      const second = tabs[1], first = tabs[0]
      await pointAt(second, 0.5, 0.5)
      if (!alive()) return
      await sleep(90)
      await click()
      if (!alive()) return
      const secondId = second.dataset.panelId, firstId = first.dataset.panelId
      if (secondId) setActivePanel(secondId)
      await sleep(380)
      if (!alive()) return
      await pointAt(first, 0.5, 0.5)
      if (!alive()) return
      await sleep(90)
      await click()
      if (firstId) setActivePanel(firstId)
      return
    }
    case 'media': {
      await showPanelFor('media')
      const el = await target()
      if (el && alive()) await pointAt(el, ax, ay)
      return
    }
    case 'widgets': {
      const kind = tourWidgetKind(step, kinds)
      await showPanelFor(kind)
      const widget = kind ? await resolveTarget([`[data-widget-kind="${kind}"]`], alive) : null
      if (widget && alive()) {
        await pointAt(widget, 0.5, 0.4)
        if (!alive()) return
        await sleep(650)
      }
      const more = await target()
      if (more && alive()) await pointAt(more, ax, ay)
      return
    }
    case 'quick': {
      const el = await target()
      if (!el || !alive()) return
      await pointAt(el, ax, ay)
      // showControls would add the widget to a layout that lacks it, so only
      // click through when the user already has it.
      if (!kinds.includes('controls') || !alive()) return
      await sleep(90)
      await click()
      if (!alive()) return
      showControls()
      await sleep(380)
      const widget = await resolveTarget(['[data-widget-kind="controls"]'], alive)
      if (widget && alive()) await pointAt(widget, 0.5, 0.3)
      return
    }
    case 'beam': {
      const el = await target()
      if (!el || !alive()) return
      await pointAt(el, ax, ay)
      if (!kinds.includes('nearby') || !alive()) return
      await sleep(90)
      await click()
      if (!alive()) return
      showFileBucket()
      await sleep(380)
      const widget = await resolveTarget(['[data-widget-kind="nearby"]'], alive)
      if (widget && alive()) await pointAt(widget, 0.5, 0.3)
      return
    }
    case 'done': {
      // Calm ending: put the first page back and let the cursor go.
      const first = document.querySelector<HTMLElement>('.panel-tabs [role="tab"]')?.dataset.panelId
      if (first && activePanel() !== first) setActivePanel(first)
      setTourGoal(null)
      return
    }
    default: {
      // search, settings: point only. Opening either would take over the screen.
      const el = await target()
      if (el && alive()) await pointAt(el, ax, ay)
      else if (alive()) setTourGoal(null)
    }
  }
}

async function runStep(index: number): Promise<void> {
  const token = ++runToken
  releaseWaiters()
  const alive = () => token === runToken && tourActive()
  const step = tourPlan()[index]
  if (!step) return
  try {
    const wantCollapsed = step.needs === 'collapsed' && collapsedSupported()
    setTourCollapsed(wantCollapsed)
    transitioning = true
    try {
      if (wantCollapsed) await ensureCollapsed()
      else await ensureExpanded()
    } finally { transitioning = false }
    if (!alive()) return
    await performStep(step, alive)
  } catch {
    // A missing target must never trap the user in the tour.
  }
}

let lastEnter = 0
function enterStep(index: number): void {
  // Rapid Next presses collapse into the latest one; each run cancels the last.
  const now = performance.now()
  if (now - lastEnter < 140) return
  lastEnter = now
  const last = Math.max(0, tourPlan().length - 1)
  const next = Math.max(0, Math.min(last, Math.trunc(index)))
  setTourIndex(next)
  void runStep(next)
}

let watchdog: ReturnType<typeof setInterval> | undefined
let transitioning = false

/** Keeps the island open on every step after the first, whatever collapsed it
 * (a native shortcut, a stray hover leave, Esc handled elsewhere). */
function holdOpen(): void {
  if (!tourActive() || transitioning) return
  const step = tourPlan()[tourIndex()]
  if (!step) return
  const wantCollapsed = step.needs === 'collapsed' && collapsedSupported()
  if (!wantCollapsed && !open()) expandIsland()
}

export function startTour(options: { firstRun?: boolean } = {}): void {
  if (tourActive()) return
  // First run: the island is only open because the first-run effect opened it.
  saved = { expanded: options.firstRun ? false : expanded(), pinned: pinned(), panel: activePanel() }
  const tabCount = document.querySelectorAll('.panel-tabs [role="tab"]').length || settings.panelOrder.length
  const plan = planTour({ widgetKinds: enabledKinds(), tabCount })
  if (!plan.length) return
  batch(() => {
    setTourPlan(plan)
    setTourIndex(0)
    setTourGoal(null)
    setTourCollapsed(plan[0].needs === 'collapsed' && collapsedSupported())
    setTourActive(true)
  })
  watchdog = setInterval(holdOpen, 250)
  // Holds the island open for the whole tour. Put back by endTour.
  setPinned(true)
  document.documentElement.classList.add('tour-active')
  // The first-run effect expands the island right after it begins the tour.
  // A microtask later we take over, before the first frame is drawn.
  queueMicrotask(() => { if (tourActive()) void runStep(0) })
}

/** Ends the tour without recording it as seen. */
export function endTour(): void {
  if (!tourActive()) return
  runToken++
  releaseWaiters()
  clearInterval(watchdog)
  watchdog = undefined
  transitioning = false
  const before = saved
  saved = null
  batch(() => {
    setTourActive(false)
    setTourGoal(null)
    setTourCollapsed(false)
  })
  document.documentElement.classList.remove('tour-active')
  if (!before) return
  setPinned(before.pinned)
  if (before.panel && settings.panelOrder.includes(before.panel)) setActivePanel(before.panel)
  if (!before.expanded) {
    collapseIsland()
    restoreBounds()
    // The pointer may be resting where the caption was. Hover logic must not
    // read that as a request to open the island again.
    // Briefly ignore hover so the resting pointer cannot reopen the island
    // while its shape springs shut (see html.tour-ending in TourCursor.css).
    document.documentElement.classList.add('tour-ending')
    setTimeout(() => document.documentElement.classList.remove('tour-ending'), 1100)
    let ticks = 0
    const guard = setInterval(() => {
      if (tourActive() || ++ticks > 25) { clearInterval(guard); return }
      if (open() && !document.querySelector('.island__bar:hover')) collapseIsland()
    }, 100)
  }
}

/** Starts the tour when another window asks for a replay. Returns the unlisten. */
export function listenForTourReplay(): () => void {
  let stop: (() => void) | undefined
  let disposed = false
  void listen('tour://replay', () => startTour()).then(fn => { if (disposed) fn(); else stop = fn }).catch(() => {})
  return () => { disposed = true; stop?.() }
}

export function beginFirstRun(): void {
  startTour({ firstRun: true })
}

export function nextOnboardingStep(): void {
  if (tourActive()) enterStep(tourIndex() + 1)
}

export function previousOnboardingStep(): void {
  if (tourActive()) enterStep(tourIndex() - 1)
}

export function goToOnboardingStep(index: number): void {
  if (!Number.isFinite(index) || !tourActive()) return
  enterStep(index)
}

/** Ends the tour and remembers that it was seen. */
export function finishFirstRun(): void {
  batch(() => {
    patchSettings({ onboardingVersion: FIRST_RUN_VERSION })
    endTour()
  })
}

/** From another window: reset the flag, the main island picks it up and starts the tour. */
export function replayFirstRun(): void {
  patchSettings({ onboardingVersion: 0 })
}
