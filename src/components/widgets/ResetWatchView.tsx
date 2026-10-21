import { onCleanup, onMount, Show, createSignal } from 'solid-js'
import { ArrowUpRight, RefreshCw, Ticket } from 'lucide-solid'
import type { ResetAnnouncement } from '../../lib/ipc'
import { effectiveResetStatus } from '../../lib/resetStatus'
import { reportAge } from '../../lib/usageDisplay'
import { cmd } from '../../lib/ipc'
import { reportError } from '../../state/feedback'
import { resetSnapshot as snapshot, resetPending as pending, resetError as error, refreshResetWatch as load } from '../../state/resetWatch'
import './widgetKit.css'
import './ResetWatchView.css'

const SOURCE_URL = 'https://codex-resets.com/'

export default function ResetWatchView() {
  const [now, setNow] = createSignal(Date.now())
  const events = () => snapshot()?.events ?? []
  const latest = () => events()[0]

  const open = (url: string) => {
    if (!url) return
    void cmd.appsOpenUrl(url).catch((cause) => reportError('Could not open source', cause))
  }
  const eventAge = (event: ResetAnnouncement) => reportAge(event.publishedAt, now()).replace('Reported ', '')
  const eventTime = (event: ResetAnnouncement) => {
    const date = new Date(event.publishedAt)
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
  }
  const expectedTime = (event: ResetAnnouncement) => event.landingAt == null ? '' : new Intl.DateTimeFormat(undefined, {
    timeZone: 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(event.landingAt)
  const kindLabel = (event: ResetAnnouncement) => {
    const kind = event.kind === 'banked' ? 'Banked' : 'Global'
    const status = effectiveResetStatus(event, now())
    return status === 'landed' ? `${kind} reset landed`
      : status === 'expected' ? `${kind} · Expected ${expectedTime(event)}`
        : status === 'awaiting_confirmation' ? `${kind} · Awaiting confirmation` : `${kind} reset announced`
  }
  const kindHint = (event: ResetAnnouncement) => event.kind === 'banked'
    ? 'Tibo reported a banked reset. Open the original post.'
    : event.status === 'landed' ? 'Tibo confirmed a global reset. Open the original post.'
      : effectiveResetStatus(event, now()) === 'expected' ? `The post estimates ${expectedTime(event)}. This is an announcement, not a confirmation. Open the original post.`
        : effectiveResetStatus(event, now()) === 'awaiting_confirmation' ? `The expected time${expectedTime(event) ? ` (${expectedTime(event)})` : ''} has passed; no landing confirmation is present. Open the original post.`
          : 'Tibo announced a global reset without a precise landing time. Open the original post.'

  onMount(() => {
    if (!snapshot()) void load()
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <section class="wk reset-watch-widget" aria-label="Codex reset radar">
      <header class="wk-head reset-watch__head">
        <span class="wk-title"><span class="wk-glyph" style={{ background: '#BF5AF2' }}><Ticket size={13} strokeWidth={2.2} aria-hidden="true" /></span><span>Reset radar</span></span>
        <a class="reset-watch__source" href={SOURCE_URL} target="_blank" rel="noreferrer">Codex Resets</a>
        <Show when={snapshot()?.stale}>
          <button type="button" class="reset-watch__stale" title={snapshot()?.error || 'Could not refresh the source. Open Codex Resets.'} aria-label="Feed refresh failed. Open source." onClick={() => open(SOURCE_URL)}>Offline</button>
        </Show>
        <button type="button" class="reset-watch__refresh" aria-label="Refresh reset announcements" title="Refresh reset announcements" disabled={pending()} onClick={() => void load(true)}>
          <RefreshCw size={14} class={pending() ? 'reset-watch__spin' : ''} aria-hidden="true" />
        </button>
      </header>

      <Show when={snapshot()} fallback={
        <div class="reset-watch__loading" role={error() ? 'alert' : 'status'}>
          <span>{error() || 'Checking announcements'}</span>
        </div>
      }>
        {(value) => <>
          <div class="reset-watch__latest-wrap">
            <Show when={latest()} fallback={<p class="reset-watch__empty">No announcements yet.</p>}>
              {(event) => <button type="button" class="reset-watch__latest" aria-label={`${event().title}. ${kindHint(event())} Open source post.`} title={kindHint(event())} onClick={() => open(event().sourceUrl)}>
                <span class={`reset-watch__badge reset-watch__badge--${event().kind}`}>{kindLabel(event())}</span>
                <span class="reset-watch__latest-title">{event().title}</span>
                <span class="reset-watch__latest-meta"><span>{event().reportedBy || 'Tibo'}</span><time datetime={eventTime(event())}>{eventAge(event())}</time><ArrowUpRight size={12} aria-hidden="true" /></span>
              </button>}
            </Show>
          </div>
          <Show when={value().error}><p class="reset-watch__error" role="status" title={value().error ?? undefined}>{value().error ?? ''}</p></Show>
        </>}
      </Show>
    </section>
  )
}
