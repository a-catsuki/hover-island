import { Bell, LayoutGrid, MousePointer2, Settings } from 'lucide-solid'
import { createEffect, createSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { finishFirstRun, goToOnboardingStep, nextOnboardingStep, onboardingOpen, onboardingStep, previousOnboardingStep } from '../../state/onboarding'
import './FirstRunTour.css'
import { browserPreview,cmd } from '../../lib/ipc'
import { patchSettings,settings } from '../../state/settings'

interface TourStep {
  eyebrow: string
  title: string
  body: string
  Icon: typeof MousePointer2
  tone: 'blue' | 'purple' | 'orange' | 'green'
}

const steps: TourStep[] = [
  {
    eyebrow: 'Welcome',
    title: 'Meet Hover Island',
    get body() { return `A small island at the top of your screen. Hover it, click it, or press ${settings.hotkey} to open.` },
    Icon: MousePointer2,
    tone: 'blue',
  },
  {
    eyebrow: 'Pages',
    title: 'Your day, in pages',
    body: 'Media, weather, calendar and more live on pages you can switch, reorder and rearrange.',
    Icon: LayoutGrid,
    tone: 'purple',
  },
  {
    eyebrow: 'Alerts',
    title: 'Stay in the loop',
    body: 'Notifications, volume and battery changes appear right in the island, then get out of the way.',
    Icon: Bell,
    tone: 'orange',
  },
  {
    eyebrow: 'Ready',
    title: 'You are all set',
    get body() { return `Everything lives in Settings, from the gear in the header. Press ${settings.spotlightHotkey} any time to search.` },
    Icon: Settings,
    tone: 'green',
  },
]
const ALERT_STEP = 2

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export default function FirstRunTour() {
  const [askingAccess,setAskingAccess]=createSignal(false),[accessMessage,setAccessMessage]=createSignal('')
  const enableAlerts=async()=>{setAskingAccess(true);try{const allowed=await cmd.notificationsAccess();if(allowed){patchSettings({notifications:{...settings.notifications,systemListener:true,enabled:true}});setAccessMessage('Windows alerts are enabled. Choose your apps in Connections.')}else setAccessMessage('You can allow Windows alerts later in Settings → Alerts.')}catch(error){setAccessMessage(String(error))}finally{setAskingAccess(false)}}
  let dialog: HTMLElement | undefined
  let previousFocus: HTMLElement | null = null

  const step = () => Math.min(onboardingStep(), steps.length - 1)
  const current = () => steps[step()] ?? steps[0]
  const isLast = () => step() >= steps.length - 1

  const next = () => (isLast() ? finishFirstRun() : nextOnboardingStep())
  const previous = () => previousOnboardingStep()

  const focusables = (): HTMLElement[] => {
    if (!dialog) return []
    return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
  }

  const onKeyDown = (event: KeyboardEvent) => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        finishFirstRun()
        break
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault()
        next()
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault()
        previous()
        break
      case 'Home':
        event.preventDefault()
        goToOnboardingStep(0)
        break
      case 'End':
        event.preventDefault()
        goToOnboardingStep(steps.length - 1)
        break
      case 'Tab': {
        const items = focusables()
        if (!items.length) {
          event.preventDefault()
          dialog?.focus()
          break
        }
        const first = items[0]
        const last = items[items.length - 1]
        const active = document.activeElement
        if (event.shiftKey && (active === first || active === dialog)) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && active === last) {
          event.preventDefault()
          first.focus()
        }
        break
      }
    }
  }

  createEffect(() => {
    if (onboardingOpen()) {
      if (!previousFocus) previousFocus = (document.activeElement as HTMLElement | null) ?? null
      queueMicrotask(() => dialog?.focus())
    } else if (previousFocus) {
      previousFocus.focus()
      previousFocus = null
    }
  })

  onCleanup(() => {
    previousFocus?.focus()
    previousFocus = null
  })

  return (
    <Show when={onboardingOpen()}>
      <section
        ref={dialog}
        class="first-run-tour"
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-run-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <button type="button" class="first-run-tour__close" onClick={finishFirstRun}>Skip</button>

        <div class="first-run-tour__stage">
          <Show when={current()} keyed>
            {(active: TourStep) => (
              <div class="frt-step">
                <span class={`frt-icon frt-icon--${active.tone}`} aria-hidden="true"><Dynamic component={active.Icon} size={34} stroke-width={1.6}/></span>
                <span class="frt-eyebrow">{active.eyebrow}</span>
                <h2 id="first-run-title">{active.title}</h2>
                <p>{active.body}</p>
                <Show when={step() === ALERT_STEP && accessMessage()}><p class="frt-status" role="status">{accessMessage()}</p></Show>
              </div>
            )}
          </Show>
        </div>

        <footer class="first-run-tour__bottom">
          <button type="button" class="button button--primary first-run-tour__next" onClick={next}>{isLast() ? 'Get started' : 'Next'}</button>
          <div class="first-run-tour__dots" role="group" aria-label="Tour steps">
            <For each={steps}>{(item, index) => (
              <button
                type="button"
                aria-label={`Step ${index() + 1}: ${item.eyebrow}`}
                aria-current={index() === step() ? 'step' : undefined}
                classList={{ 'is-active': index() === step() }}
                onClick={() => goToOnboardingStep(index())}
              />
            )}</For>
          </div>
          <Show when={!browserPreview && step() === ALERT_STEP} fallback={<span class="first-run-tour__spacer" aria-hidden="true"/>}>
            <button type="button" class="first-run-tour__skip" disabled={askingAccess()} onClick={() => void enableAlerts()}>{askingAccess() ? 'Waiting for Windows…' : 'Enable desktop alerts'}</button>
          </Show>
        </footer>
      </section>
    </Show>
  )
}
