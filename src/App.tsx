import { createEffect, createSignal, ErrorBoundary, onCleanup, onMount, Show, untrack } from 'solid-js'
import Island from './components/shell/Island'
import SpotlightView from './components/views/SpotlightView'
import { cmd, listen, onAiEvent, onEmailCode, onExpandedChanged, onSpotlightOpen, onQuitRequested, type AppNotification } from './lib/ipc'
import { loadSettings, flushSettings, settings } from './state/settings'
import { subscribeMedia } from './state/media'
import { focusTimer } from './state/focus'
import { notifications, subscribeNotifications } from './state/notifications'
import { subscribeUsage } from './state/usage'
import { collapseIsland, syncExpanded, expandIsland, expanded } from './state/ui'
import { matchesShortcut } from './lib/shortcuts'
import { beginFirstRun, onboardingOpen, shouldShowFirstRun } from './state/onboarding'
import { closeSpotlight, openSpotlight, spotlightOpen } from './state/spotlight'
import { reportError } from './state/feedback'
import { ingestNotifications, ingestActionPeek, ingestTransferPeek, ingestAiPeek, ingestTwoFactorPeek, ingestPreferencePeek, configurePeekSound, dismissPeek } from './state/peek'
import { subscribeForeground } from './state/window'
import { tickFocus } from './state/focus'
import { browserPreview, embedPreview } from './lib/ipc'
import { flushNotes } from './components/widgets/NotesView'
import { subscribeResetWatch } from './state/resetWatch'
import { startWebsiteAlertsPolling, subscribeWebsiteAlerts, refreshWebsiteConnections, refreshWebsiteAlerts } from './state/erp'
import { safeWebsiteAlertUrl } from './lib/erpAlerts'
import { subscribeCalendarSources } from './state/calendarSources'
import { showFileBucket } from './state/panel'

export default function App() {
  let quitInFlight:Promise<void>|undefined
  const [settingsReady, setSettingsReady] = createSignal(false)
  let previousFocusCompleted = focusTimer().completed
  let focusCompletionArmed = !!focusTimer().endsAt && focusTimer().endsAt! > Date.now()
  createEffect(() => {
    const current = focusTimer()
    if (current.endsAt && current.endsAt > Date.now()) focusCompletionArmed = true
    if (current.completed && !previousFocusCompleted && focusCompletionArmed && settingsReady() && settings.widgets.some(widget => widget.kind === 'focus' && widget.enabled)) {
      focusCompletionArmed = false
      ingestAiPeek({
        id: `focus-complete:${Date.now()}`,
        kind: 'complete',
        provider: 'Focus timer',
        title: 'Focus session complete',
        body: 'Your timer has finished.',
        timestamp: Date.now(),
      })
    }
    previousFocusCompleted = current.completed
  })
  const quitSafely = () => quitInFlight ??= Promise.all([flushSettings(),flushNotes()]).then(()=>cmd.quit()).catch(error=>{reportError('Could not save before closing',error)}).finally(()=>{quitInFlight=undefined})
  // Surface genuinely new notifications as a brief peek (unless DND is on).
  createEffect(() => ingestNotifications(notifications()))
  let previousDnd:boolean|undefined
  createEffect(() => {
    if(!settingsReady())return
    const enabled=settings.dnd,changed=previousDnd!==undefined&&previousDnd!==enabled
    previousDnd=enabled
    untrack(()=>{
      if(enabled)dismissPeek()
      if(changed)ingestPreferencePeek(enabled?'Do Not Disturb On':'Do Not Disturb Off',enabled?'Alerts and sounds are silenced.':'Alerts follow your notification settings.')
    })
  })
  createEffect(() => {
    if (embedPreview || !shouldShowFirstRun(settingsReady(), settings.onboardingVersion) || onboardingOpen()) return
    beginFirstRun()
    expandIsland()
  })

  onMount(() => {
    if (embedPreview) document.documentElement.classList.add('embed')
    let disposed = false
    const cleanups: Array<() => void> = []
    cleanups.push(configurePeekSound(() => { void cmd.playAlertSound().catch(() => {}) }))
    let queuedWebsiteAlert: AppNotification | undefined
    let websiteFlushQueued=false
    const priorityRank=(value?:string)=>value==='urgent'?3:value==='high'?2:1
    cleanups.push(subscribeWebsiteAlerts((alert,connection,updateKey,category)=>{
      const item:AppNotification={id:updateKey,category,app:alert.app||connection.displayName,title:alert.title,body:alert.body,timestamp:alert.timestamp,priority:alert.priority==='urgent'?'urgent':alert.priority==='high'?'high':'normal',url:safeWebsiteAlertUrl(alert.url,connection.serverUrl)??undefined}
      if(!queuedWebsiteAlert||priorityRank(item.priority)>priorityRank(queuedWebsiteAlert.priority)||(priorityRank(item.priority)===priorityRank(queuedWebsiteAlert.priority)&&item.timestamp>queuedWebsiteAlert.timestamp))queuedWebsiteAlert=item
      if(!websiteFlushQueued){websiteFlushQueued=true;queueMicrotask(()=>{websiteFlushQueued=false;const next=queuedWebsiteAlert;queuedWebsiteAlert=undefined;if(!disposed&&next)ingestActionPeek(next)})}
    }))
    cleanups.push(startWebsiteAlertsPolling())
    cleanups.push(subscribeCalendarSources())
    const track = (work: Promise<() => void>) =>
      void work
        .then((fn) => (disposed ? fn() : cleanups.push(fn)))
        .catch((error) => reportError('Could not connect to updates', error))

    void loadSettings().then(setSettingsReady)
    tickFocus()
    const focusTick = setInterval(tickFocus,1000)
    track(subscribeMedia(media => {
      if (!settingsReady() || !settings.modules.media) return
      const artist = media.artist.trim()
      ingestActionPeek({
        id: `media-track:${media.sourceApp ?? 'player'}:${media.title}:${media.artist}:${Date.now()}`,
        app: 'Media',
        title: 'Now playing',
        body: artist ? `${media.title} — ${artist}` : media.title,
        timestamp: Date.now(),
        icon: media.thumbnail ?? null,
      })
    }))
    track(subscribeNotifications())
    track(subscribeUsage())
    track(subscribeResetWatch())
    track(listen('website://connections-changed',()=>{void refreshWebsiteConnections().then(()=>refreshWebsiteAlerts(false))}))
    track(listen<AppNotification>('device://event', event => ingestNotifications([event.payload])))
    track(listen('alert://test', () => ingestActionPeek({ id: `test-alert:${Date.now()}`, app: 'Hover Island', title: 'Test alert', body: 'Alerts, chimes and the notch are working.', timestamp: Date.now(), category: 'website', priority: 'normal' })))
    track(listen<AppNotification>('transfer://event', event => ingestTransferPeek(event.payload)))
    track(onAiEvent(ingestAiPeek))
    track(onEmailCode(ingestTwoFactorPeek))
    track(subscribeForeground())
    track(onQuitRequested(()=>{void cmd.acknowledgeQuitRequest().then(quitSafely).catch(error=>reportError('Could not close the island',error))}))
    track(onSpotlightOpen(openSpotlight))
    track(
      onExpandedChanged(syncExpanded).then((fn) => {
        void cmd.applyGeometry().catch((error) => reportError('Could not sync window', error))
        return fn
      }),
    )

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (matchesShortcut(event, settings.spotlightHotkey)) {
        event.preventDefault()
        openSpotlight()
        return
      }
      if (matchesShortcut(event, settings.hotkey)) {
        event.preventDefault()
        // The desktop binding is handled once by the native global shortcut.
        if (browserPreview) {
          if (expanded()) collapseIsland()
          else expandIsland()
        }
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyB') {
        event.preventDefault()
        expandIsland()
        showFileBucket()
        return
      }
      if (event.key === 'Escape') {
        if (spotlightOpen()) closeSpotlight()
        else {
          void flushSettings().catch(() => {})
          collapseIsland()
        }
      }
    }
    const onLeave = () => {
      void flushSettings().catch(() => {})
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pagehide', onLeave)

    onCleanup(() => {
      disposed = true
      clearInterval(focusTick)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pagehide', onLeave)
      for (const fn of cleanups) fn()
    })
  })

  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <div class="app-recovery">
          <strong>The island needs a refresh</strong>
          <p>{String(error)}</p>
          <div>
            <button class="button" onClick={reset}>
              Try again
            </button>{' '}
            <button class="button" onClick={() => void quitSafely()}>
              Quit
            </button>
          </div>
        </div>
      )}
    >
      <Show when={browserPreview && !embedPreview}><div class="preview-label">Browser preview <span>Sample data · native actions require the desktop app</span></div></Show>
      <Island />
      <Show when={spotlightOpen()}>
        <SpotlightView />
      </Show>
    </ErrorBoundary>
  )
}
