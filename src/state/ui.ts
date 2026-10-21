import { createSignal } from 'solid-js'
import { cmd } from '../lib/ipc'
import { reportError } from './feedback'

const [expanded, setExpandedRaw] = createSignal(false)
let collapsedAt = 0
const [open, setOpen] = createSignal(false)
const [closing, setClosing] = createSignal(false)
const [hovering, setHovering] = createSignal(false)
const [pinned, setPinnedState] = createSignal(false)
const [temporaryExpansion, setTemporaryExpansion] = createSignal(false)
const [accent, setAccentState] = createSignal('#0a84ff')

/** Records when the island last finished collapsing so queued toasts can wait for it to settle. */
function setExpanded(value: boolean): void {
  if (!value && expanded()) collapsedAt = Date.now()
  setExpandedRaw(value)
}
/** Milliseconds the island has been fully collapsed (huge before the first expansion). */
export function collapsedForMs(): number {
  return expanded() ? 0 : Date.now() - collapsedAt
}

let collapseTimer: ReturnType<typeof setTimeout> | undefined
let nativeExpanded = false
let desiredExpanded = false
let transition: Promise<void> | null = null
let interactionHolds = 0
let interactionQuietUntil = 0

/** Pointer holds are not idle, even when a slider stops emitting input. */
export function beginSurfaceInteraction(): void {
  interactionHolds++
  noteSurfaceInteraction()
}
export function noteSurfaceInteraction(): void { interactionQuietUntil = Date.now() + 600 }
export function endSurfaceInteraction(): void {
  interactionHolds = Math.max(0, interactionHolds - 1)
  noteSurfaceInteraction()
}
export function surfaceInteractionActive(): boolean {
  return interactionHolds > 0 || Date.now() < interactionQuietUntil
}
const expectedNativeEvents = new Map<boolean, number>()
const expectedNativeTimers = new Map<boolean, ReturnType<typeof setTimeout>>()

function expectNativeEvent(value: boolean): void {
  expectedNativeEvents.set(value, (expectedNativeEvents.get(value) ?? 0) + 1)
  clearTimeout(expectedNativeTimers.get(value))
  expectedNativeTimers.set(value, setTimeout(() => {
    expectedNativeEvents.delete(value)
    expectedNativeTimers.delete(value)
  }, 1200))
}

function consumeExpectedNativeEvent(value: boolean): boolean {
  const count = expectedNativeEvents.get(value) ?? 0
  if (!count) return false
  if (count === 1) {
    expectedNativeEvents.delete(value)
    clearTimeout(expectedNativeTimers.get(value))
    expectedNativeTimers.delete(value)
  } else expectedNativeEvents.set(value, count - 1)
  return true
}

// The old default accents were indigo. New installs and anyone still on the
// stock accent get the system blue, a deliberate custom colour is kept.
const LEGACY_DEFAULT_ACCENTS = new Set(['#6e8bff', '#818cf8'])
export function applyAccent(requested: string): void {
  if (!/^#[0-9a-f]{6}$/i.test(requested)) return
  const hex = LEGACY_DEFAULT_ACCENTS.has(requested.toLowerCase()) ? '#0a84ff' : requested
  setAccentState(hex)
  document.documentElement.style.setProperty('--accent', hex)
  document.documentElement.style.setProperty('--accent-soft', `${hex}24`)
}

export function syncExpanded(value: boolean): void {
  nativeExpanded = value
  if (consumeExpectedNativeEvent(value)) {
    if (transition) return
    if (value !== desiredExpanded) reconcileWindow()
    return
  }
  desiredExpanded = value
  // Native shortcuts and tray actions are persistent user intent. Only a peek
  // marks its own command as temporary before it reaches the native boundary.
  setTemporaryExpansion(false)
  clearTimeout(collapseTimer)
  setClosing(false)
  setExpanded(value)
  setOpen(value)
}

function reconcileWindow(): void {
  if (transition) return
  // Defer one microtask so synchronous preview events also see the lock.
  transition = Promise.resolve()
    .then(async () => {
      try {
        while (nativeExpanded !== desiredExpanded) {
          const target = desiredExpanded
          expectNativeEvent(target)
          await cmd.setExpanded(target)
          nativeExpanded = target
          // A leave or click arriving during IPC changes the target, so reconcile
          // again before publishing the stale response as the visible state.
          if (target === desiredExpanded) {
            setExpanded(target)
            setOpen(target)
            setClosing(false)
          }
        }
      } catch (error) {
        expectedNativeEvents.clear()
        for (const timer of expectedNativeTimers.values()) clearTimeout(timer)
        expectedNativeTimers.clear()
        desiredExpanded = nativeExpanded
        setTemporaryExpansion(false)
        setExpanded(nativeExpanded)
        setOpen(nativeExpanded)
        setClosing(false)
        reportError('Could not change the island state', error)
      }
    })
    .finally(() => {
      transition = null
    })
}

export function expandIsland(temporary = false): void {
  setTemporaryExpansion(temporary)
  desiredExpanded = true
  clearTimeout(collapseTimer)
  setClosing(false)
  // Publish visual intent immediately; native IPC reconciles hit-testing in
  // the background and the spring can start on the same frame as the trigger.
  setExpanded(true)
  setOpen(true)
  reconcileWindow()
}

export function collapseIsland(): void {
  setTemporaryExpansion(false)
  desiredExpanded = false
  if (!expanded() && !transition) return
  setClosing(true)
  setOpen(false)
  clearTimeout(collapseTimer)
  // Long enough for the close spring (see ISLAND_CLOSE_SETTLE_MS in motion.ts) to finish before the native window shrinks.
  collapseTimer = setTimeout(finalizeCollapse, 300)
}

export function finalizeCollapse(): void {
  if (!closing() || desiredExpanded) return
  clearTimeout(collapseTimer)
  reconcileWindow()
}

export const toggleIsland = () => (expanded() ? collapseIsland() : expandIsland())

export function setPinned(value: boolean): void {
  if (value) setTemporaryExpansion(false)
  setPinnedState(value)
}

export { expanded, open, closing, hovering, setHovering, pinned, accent, temporaryExpansion }
