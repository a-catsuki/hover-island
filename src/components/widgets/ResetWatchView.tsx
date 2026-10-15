import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { ArrowUpRight, ChevronRight, Clock3, RefreshCw, Ticket } from 'lucide-solid'
import type { UsageSnapshot, ResetAnnouncement } from '../../lib/ipc'
import { isReportStale, remainingPercent, reportAge, resetCountdown, windowLabel } from '../../lib/usageDisplay'
import { cmd } from '../../lib/ipc'
import { reportError } from '../../state/feedback'
import { resetSnapshot as snapshot, resetPending as pending, resetError as error, refreshResetWatch as load } from '../../state/resetWatch'
import { usage } from '../../state/usage'
import { requestWidgetDetail } from '../../state/panel'
import './ResetWatchView.css'

export default function ResetWatchView() {
  const [now, setNow] = createSignal(Date.now())
  const [historyOpen, setHistoryOpen] = createSignal(false)
  let root: HTMLElement | undefined
  let wasInDetail = false

  const events = () => snapshot()?.events ?? []
  const latest = () => events()[0]
  const quotaReports = () => usage()
    .filter((item: UsageSnapshot) => item.provider === 'codex'
      && item.source === 'official-rate-limit'
      && item.status === 'ok'
      && typeof item.resetAt === 'number'
      && Number.isFinite(item.resetAt)
      && item.resetAt > 0)
  const nextReset = () => quotaReports()
    .filter((item) => item.resetAt! > now() && !isReportStale(item.updatedAt, now()))
    .sort((left, right) => (left.resetAt ?? Infinity) - (right.resetAt ?? Infinity))[0]
  const lastQuotaReport = () => quotaReports().sort((left, right) => right.updatedAt - left.updatedAt)[0]
  const quotaIsStale = () => !nextReset() && !!lastQuotaReport() && isReportStale(lastQuotaReport()!.updatedAt, now())

  const open = (url: string) => {
    if (!url) return
    void cmd.appsOpenUrl(url).catch((cause) => reportError('Could not open source', cause))
  }
  const eventAge = (event: ResetAnnouncement) => reportAge(event.publishedAt, now()).replace('Reported ', '')
  const eventTime = (event: ResetAnnouncement) => {
    const date = new Date(event.publishedAt)
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
  }
  const kindLabel = (event: ResetAnnouncement) => event.kind === 'banked'
    ? 'Banked credits'
    : event.upcoming ? 'Reset announced' : 'Global reset'
  const kindHint = (event: ResetAnnouncement) => event.kind === 'banked'
    ? 'A community post about banked credits. This does not report your account balance.'
    : event.upcoming ? 'A community post announces a future reset; it does not predict your account reset time.' : 'A community announcement about a global reset.'

  onMount(() => {
    if (!snapshot()) void load()
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    const grid = root?.closest('.widget-grid')
    const observer = grid ? new MutationObserver(() => {
      const inDetail = !!root?.closest('.widget-grid--detail')
      if (wasInDetail && !inDetail) setHistoryOpen(false)
      wasInDetail = inDetail
    }) : undefined
    if (grid && observer) observer.observe(grid, { attributes: true, attributeFilter: ['class'] })
    onCleanup(() => { clearInterval(timer); observer?.disconnect() })
  })

  const showAnnouncements = () => {
    setHistoryOpen(true)
    requestWidgetDetail('reset-watch')
  }

  return (
    <section ref={root} class="reset-watch-widget" aria-label="Codex reset radar">
      <header class="reset-watch__head">
        <span class="reset-watch__brand"><Ticket size={15} aria-hidden="true" />Reset radar</span>
        <Show when={snapshot()?.stale}>
          <button type="button" class="reset-watch__stale" title={snapshot()?.error || 'The community feed may be out of date. Open the source feed.'} aria-label="Community feed is stale. Open source feed." onClick={() => open(snapshot()?.source ?? '')}>Feed stale</button>
        </Show>
        <Show when={events().length > 1 && !historyOpen()}><button type="button" class="reset-watch__history-link reset-watch__history-trigger" onClick={showAnnouncements}>See announcements <ChevronRight size={13} aria-hidden="true" /></button></Show>
        <button type="button" class="reset-watch__refresh" aria-label="Refresh reset status" title="Refresh reset status" disabled={pending()} onClick={() => void load(true)}>
          <RefreshCw size={14} class={pending() ? 'reset-watch__spin' : ''} aria-hidden="true" />
        </button>
      </header>

      <Show when={snapshot()} fallback={
        <div class="reset-watch__loading" role={error() ? 'alert' : 'status'}>
          <span>{error() || 'Checking reset announcements…'}</span>
        </div>
      }>
        {(value) => <>
          <div class="reset-watch__quota" aria-label="Personal Codex quota reset status" title={nextReset() ? `Official Codex rate-limit report · ${reportAge(nextReset()!.updatedAt, now())}` : quotaIsStale() ? `Last official Codex rate-limit report · ${reportAge(lastQuotaReport()!.updatedAt, now())}` : 'No current official Codex reset time is available'}>
            <span class="reset-watch__quota-icon"><Clock3 size={16} aria-hidden="true" /></span>
            <span class="reset-watch__quota-copy">
              <span class="reset-watch__eyebrow">Next Codex reset</span>
              <Show when={nextReset()} fallback={<strong class="reset-watch__quota-value reset-watch__quota-value--unknown">{quotaIsStale() ? 'Reset report is stale' : 'Reset time unavailable'}</strong>}>
                {(quota) => <strong class="reset-watch__quota-value">{resetCountdown(quota().resetAt, now()).replace(/^Resets in\s+/, '')}</strong>}
              </Show>
              <span class="reset-watch__quota-source"><Show when={nextReset()} fallback={quotaIsStale() ? 'Last provider report is out of date' : 'Waiting for an official provider report'}>{(quota) => `Official provider report · ${reportAge(quota().updatedAt, now()).replace('Reported ', '')}`}</Show></span>
            </span>
            <Show when={nextReset()}>
              {(quota) => <span class="reset-watch__quota-window" title={`${remainingPercent(quota()) ?? '—'}% remaining in this ${windowLabel(quota().window)} window`}>{windowLabel(quota().window)}</span>}
            </Show>
          </div>

          <Show when={historyOpen()} fallback={
            <div class="reset-watch__latest-wrap">
              <Show when={latest()} fallback={<p class="reset-watch__empty">No linked announcements yet.</p>}>
                {(event) => <button type="button" class="reset-watch__latest" aria-label={`${event().title}. ${kindHint(event())} Reported by ${event().reportedBy || 'community feed'}. Open source post.`} title={`${kindHint(event())} Open source post.`} onClick={() => open(event().sourceUrl)}>
                  <span class={`reset-watch__badge reset-watch__badge--${event().kind}`}>{kindLabel(event())}</span>
                  <span class="reset-watch__latest-title">{event().title}</span>
                  <span class="reset-watch__latest-meta"><span>{event().reportedBy || 'Community feed'}</span><time datetime={eventTime(event())}>{eventAge(event())}</time><ArrowUpRight size={12} aria-hidden="true" /></span>
                </button>}
              </Show>
            </div>
          }>
            <div class="reset-watch__history-head">
              <span>Announcements</span>
              <button type="button" class="reset-watch__history-link" onClick={() => setHistoryOpen(false)}>Back to latest</button>
            </div>
            <div class="reset-watch__history" aria-label="Linked reset announcement history">
              <For each={events()}>{(event) => <button type="button" class="reset-watch__history-item" aria-label={`${event.title}. ${kindHint(event)} Reported by ${event.reportedBy || 'community feed'}. Open source post.`} onClick={() => open(event.sourceUrl)}>
                <span class={`reset-watch__badge reset-watch__badge--${event.kind}`}>{kindLabel(event)}</span>
                <span class="reset-watch__history-title">{event.title}</span>
                <span class="reset-watch__history-meta"><span>{event.reportedBy || 'Community feed'}</span><time datetime={eventTime(event)}>{eventAge(event)}</time><ArrowUpRight size={11} aria-hidden="true" /></span>
              </button>}</For>
            </div>
          </Show>
          <Show when={value().error}><p class="reset-watch__error" role="status" title={value().error ?? undefined}>{value().error ?? ''}</p></Show>
        </>}
      </Show>
    </section>
  )
}
