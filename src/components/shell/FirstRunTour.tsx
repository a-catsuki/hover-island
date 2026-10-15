import { Bell, Check, ChevronLeft, ChevronRight, LayoutGrid, MousePointer2, Play, Settings, X } from 'lucide-solid'
import { createEffect, createSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { finishFirstRun, goToOnboardingStep, nextOnboardingStep, onboardingOpen, onboardingStep, previousOnboardingStep } from '../../state/onboarding'
import { FIRST_RUN_STEP_COUNT } from '../../lib/onboardingConfig'
import './FirstRunTour.css'
import { browserPreview,cmd } from '../../lib/ipc'
import { patchSettings,settings } from '../../state/settings'

interface TourStep {
  eyebrow: string
  title: string
  body: string
  points: string[]
  Art: () => JSX.Element
}

const NotchArt = () => (
  <div class="frt-figure frt-figure--screen">
    <div class="frt-desktop">
      <div class="frt-notch">
        <span class="frt-notch__dot"/>
        <span class="frt-notch__label">Hover Island</span>
      </div>
    </div>
  </div>
)

const OpenArt = () => (
  <div class="frt-figure frt-figure--screen">
    <div class="frt-desktop">
      <div class="frt-notch frt-notch--open">
        <span class="frt-notch__dot"/>
        <span class="frt-notch__label">Spotify · Now playing</span>
      </div>
      <MousePointer2 class="frt-cursor" size={18} aria-hidden="true"/>
      <div class="frt-keyrow">
        <kbd class="frt-key">Alt</kbd>
        <kbd class="frt-key">Space</kbd>
      </div>
    </div>
  </div>
)

const PanelsArt = () => (
  <div class="frt-figure">
    <div class="frt-tabs">
      <span class="frt-tab is-on">Today</span>
      <span class="frt-tab">Desk</span>
      <span class="frt-tab">Activity</span>
    </div>
    <div class="frt-grid">
      <span class="frt-tile frt-tile--accent"/>
      <span class="frt-tile"/>
      <span class="frt-tile"/>
      <span class="frt-tile frt-tile--accent"/>
    </div>
  </div>
)

const CompactArt = () => (
  <div class="frt-figure">
    <div class="frt-pill">
      <span class="frt-pill__time">9:41</span>
      <span class="frt-pill__divider"/>
      <span class="frt-pill__media">
        <span class="frt-pill__art"/>
        <span>Now playing</span>
      </span>
      <span class="frt-pill__spacer"/>
      <span class="frt-battery" aria-hidden="true"><i/></span>
    </div>
    <div class="frt-pill frt-pill--muted">
      <span class="frt-pill__time">Mon 14</span>
      <span class="frt-pill__divider"/>
      <span class="frt-pill__media">Pinned open</span>
      <span class="frt-pill__spacer"/>
      <span class="frt-badge"><LayoutGrid size={11}/></span>
    </div>
  </div>
)

const MediaArt = () => (
  <div class="frt-figure">
    <div class="frt-media">
      <span class="frt-media__art"/>
      <span class="frt-media__meta">
        <span class="frt-line frt-line--w70"/>
        <span class="frt-line frt-line--w45"/>
        <span class="frt-media__transport" aria-hidden="true">
          <span/><span class="is-play"><Play size={9} fill="currentColor"/></span><span/>
        </span>
      </span>
    </div>
    <div class="frt-viz" aria-hidden="true">
      <i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/>
    </div>
  </div>
)

const AlertArt = () => (
  <div class="frt-figure">
    <div class="frt-peek">
      <span class="frt-peek__icon"><Bell size={14}/></span>
      <span class="frt-peek__meta">
        <strong>Now playing</strong>
        <span class="frt-line frt-line--w60"/>
      </span>
    </div>
    <div class="frt-chips">
      <span class="frt-chip">Bluetooth</span>
      <span class="frt-chip">Battery 82%</span>
      <span class="frt-chip frt-chip--accent">Share nearby</span>
    </div>
  </div>
)

const FinishArt = () => (
  <div class="frt-figure frt-figure--finish">
    <span class="frt-gear"><Settings size={24}/></span>
    <div class="frt-checklist">
      <span><Check size={13}/> Widgets and panels</span>
      <span><Check size={13}/> Appearance and motion</span>
      <span><Check size={13}/> Shortcuts and sharing</span>
    </div>
  </div>
)

const steps: TourStep[] = [
  {
    eyebrow: 'The notch',
    title: 'Your screen’s quiet corner',
    body: 'Hover Island lives in a small notch at the top of your screen. It stays out of the way until you need it.',
    points: ['Collapsed to a glanceable pill', 'No window to move or manage', 'Always within reach'],
    Art: NotchArt,
  },
  {
    eyebrow: 'Opening',
    title: 'Open it your way',
    body: 'Hover the notch to expand it, click it, or press Alt+Space. Anywhere else, Ctrl+Space opens search.',
    points: ['Hover to open', 'Click the notch', 'Alt+Space to open · Ctrl+Space to search'],
    Art: OpenArt,
  },
  {
    eyebrow: 'Panels',
    title: 'Panels that fit your day',
    body: 'Today, Desk and Activity hold your widgets. Switch tabs, then drag widgets to arrange them or move them between panels.',
    points: ['Today · Desk · Activity', 'Drag to reorder', 'Rename and reassign panels'],
    Art: PanelsArt,
  },
  {
    eyebrow: 'Compact view',
    title: 'A glance when you need it',
    body: 'The collapsed notch shows what matters now — clock, battery, now playing. Pin it open while you work.',
    points: ['Clock, battery and media', 'Pin to keep it open', 'Collapses again when you leave'],
    Art: CompactArt,
  },
  {
    eyebrow: 'Media',
    title: 'Media, front and centre',
    body: 'Control playback and seek from the media widget. The visualizer follows the real audio from your output device.',
    points: ['Play, skip and seek', 'Visualizer follows sound', 'Reports the providers you actually have'],
    Art: MediaArt,
  },
  {
    eyebrow: 'Alerts & connections',
    title: 'Stay informed, stay connected',
    body: 'Notifications arrive as brief peeks without stealing focus. Bluetooth, power and nearby sharing stay a glance away.',
    points: ['Quiet notification peeks', 'Bluetooth and battery', 'Share files with your phone'],
    Art: AlertArt,
  },
  {
    eyebrow: 'Get started',
    title: 'You’re all set',
    body: 'Everything lives in Settings — widgets, appearance, shortcuts and sharing. Open it from the gear in the header.',
    points: ['Settings from the gear icon', 'Widgets, appearance and shortcuts', 'Replay this tour any time'],
    Art: FinishArt,
  },
]

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
        <header class="first-run-tour__top">
          <span class="first-run-tour__brand" aria-hidden="true"/>
          <span class="first-run-tour__eyebrow">Getting started</span>
          <span class="first-run-tour__count">{step() + 1} / {steps.length}</span>
          <button type="button" class="first-run-tour__close" aria-label="Skip introduction" onClick={finishFirstRun}><X size={15}/></button>
        </header>

        <div class="first-run-tour__progress" role="presentation">
          <i style={{ width: `${((step() + 1) / steps.length) * 100}%` }}/>
        </div>

        <div class="first-run-tour__stage">
          <Show when={current()} keyed>
            {(active: TourStep) => (
              <div class="frt-step">
                <div class="frt-art" aria-hidden="true">
                  <Dynamic component={active.Art}/>
                </div>
                <div class="frt-copy">
                  <span class="frt-copy__eyebrow">{active.eyebrow}</span>
                  <h2 id="first-run-title">{active.title}</h2>
                  <p>{active.body}</p>
                  <ul class="frt-copy__points">
                    <For each={active.points}>{point => <li><Check size={13}/><span>{point}</span></li>}</For>
                  </ul>
                  <Show when={step()===5&&accessMessage()}><p role="status">{accessMessage()}</p></Show>
                </div>
              </div>
            )}
          </Show>
        </div>

        <footer class="first-run-tour__bottom">
          <Show when={!browserPreview&&step()===5} fallback={<button type="button" class="first-run-tour__skip" onClick={finishFirstRun}>Skip</button>}><button type="button" class="first-run-tour__skip" disabled={askingAccess()} onClick={()=>void enableAlerts()}>{askingAccess()?'Waiting for Windows…':'Enable desktop alerts'}</button></Show>
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
          <div class="first-run-tour__nav">
            <Show when={step() > 0}>
              <button type="button" class="button button--ghost first-run-tour__back" onClick={previous}>
                <ChevronLeft size={14}/>Back
              </button>
            </Show>
            <button type="button" class="button button--primary first-run-tour__next" onClick={next}>
              {isLast() ? 'Get started' : 'Next'}
              <Show when={!isLast()} fallback={<Check size={14}/>}><ChevronRight size={14}/></Show>
            </button>
          </div>
        </footer>
      </section>
    </Show>
  )
}
