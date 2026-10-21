import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { Gauge, RefreshCw } from 'lucide-solid'
import type { UsageSnapshot } from '../../lib/ipc'
import { agoLabel, compactTokens, formatDuration, groupProviders, isReportStale, providerMeta, remainingPercent, reportAge, resetCountdown, resetTimeLabel, usedRatio, windowLabel, type ProviderSummary } from '../../lib/usageDisplay'
import { providerShown, refreshUsage, usage } from '../../state/usage'
import { liveSessions } from '../../state/aiActivity'
import BrandIcon from '../BrandIcon'
import AiActivityMark from '../shell/AiActivityMark'
import './UsageView.css'

type Snapshot = UsageSnapshot & { source?: string | null; resetAt?: number | null }

function providerLabel(provider: UsageSnapshot['provider']): string {
  return providerMeta(provider).label
}

function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}

function isOfficial(snapshot: Snapshot): boolean { return snapshot.source === 'official-rate-limit' }
function isLocal(snapshot: Snapshot): boolean { return snapshot.source === 'local-logs' }
function providerBrand(provider: UsageSnapshot['provider']): string {
  return providerMeta(provider).brand
}

function description(snapshot: Snapshot, now = Date.now()): string {
  if (snapshot.status === 'error' || snapshot.status === 'unknown') return snapshot.detail || `${providerLabel(snapshot.provider)} report unavailable.`
  if (isLocal(snapshot)) return `${reportAge(snapshot.updatedAt, now)} · Local activity only`
  if (isOfficial(snapshot)) {
    const reset = resetTimeLabel(snapshot.resetAt)
    const countdown = resetCountdown(snapshot.resetAt, now)
    const stale = isReportStale(snapshot.updatedAt, now)
    return [reportAge(snapshot.updatedAt, now), stale ? 'May be out of date' : null,
      countdown, reset ? `Expected ${reset}` : null].filter(Boolean).join(' · ')
  }
  return snapshot.detail || reportAge(snapshot.updatedAt, now)
}

function primary(snapshot: Snapshot): string {
  if (snapshot.status !== 'ok') return snapshot.status === 'error' ? 'Report unavailable' : 'No report available'
  const left = remainingPercent(snapshot)
  if (isLocal(snapshot)) return `${formatNumber(snapshot.used)} ${snapshot.unit ?? 'tokens'}`
  if (left != null && (isOfficial(snapshot) || snapshot.limit != null)) return `${left}% left`
  return 'Remaining unknown'
}

function secondary(snapshot: Snapshot): string {
  if (snapshot.status !== 'ok') return snapshot.detail || 'Waiting for a provider report'
  if (isLocal(snapshot)) return `Local activity · ${windowLabel(snapshot.window)}`
  const ratio = usedRatio(snapshot)
  if (ratio != null && (isOfficial(snapshot) || snapshot.limit != null)) return `${Math.round(ratio * 100)}% used`
  if (snapshot.used != null) return `${formatNumber(snapshot.used)} ${snapshot.unit ?? 'used'}`
  return isOfficial(snapshot) ? 'Provider-reported quota' : 'No quota limit reported'
}

const RING_R = 19
const RING_C = 2 * Math.PI * RING_R

/** Progress ring: shows what is left of the quota, with the provider mark in the middle. */
function Ring(props: { value: number | null; tone: string; brand: string; label: string }) {
  return <div class="usage__ring" role="img" aria-label={props.label} data-tone={props.tone}>
    <svg viewBox="0 0 44 44" aria-hidden="true">
      <circle class="usage__ring-track" cx="22" cy="22" r={RING_R} />
      <Show when={props.value != null}>
        <circle class="usage__ring-fill" cx="22" cy="22" r={RING_R} stroke-dasharray={`${RING_C * Math.max(0, Math.min(100, props.value!)) / 100} ${RING_C}`} transform="rotate(-90 22 22)" />
      </Show>
    </svg>
    <BrandIcon name={props.brand} size={16} class="usage__brand" />
  </div>
}

function SnapshotCard(props: { snapshot: Snapshot; now: number }) {
  const snapshot = () => props.snapshot
  const left = () => remainingPercent(snapshot())
  const leftUnknown = () => left() == null || snapshot().status !== 'ok'
  const stale = () => isOfficial(snapshot()) && isReportStale(snapshot().updatedAt, props.now)
  const due = () => isOfficial(snapshot()) && !!snapshot().resetAt && snapshot().resetAt! <= props.now
  const ringValue = () => isLocal(snapshot()) || snapshot().status !== 'ok' ? null : left()
  const tone = () => snapshot().status === 'error' ? 'bad' : ringValue() == null ? 'neutral' : ringValue()! < 15 ? 'bad' : ringValue()! < 40 ? 'warn' : 'good'
  const ringLabel = () => isLocal(snapshot()) ? 'Local usage activity' : `${left() ?? 'Unknown'} percent remaining`
  return (
    <article class="usage__card" classList={{ 'usage__card--error': snapshot().status === 'error', 'usage__card--stale': stale(), 'usage__card--due': due() }}>
      <Ring value={ringValue()} tone={tone()} brand={providerBrand(snapshot().provider)} label={ringLabel()} />
      <div class="usage__body">
        <div class="usage__card-label">{snapshot().label || providerLabel(snapshot().provider)}</div>
        <div class="usage__card-sub">
          <span class="usage__window-chip">{windowLabel(snapshot().window)}</span>
          <Show when={stale()}><span class="usage__state-chip usage__state-chip--stale">Out of date</span></Show>
          <Show when={due()}><span class="usage__state-chip usage__state-chip--due">Reset due</span></Show>
        </div>
        <div class="usage__detail">{description(snapshot(), props.now)}</div>
      </div>
      <div class="usage__remaining-block">
        <span class="usage__remaining" classList={{ 'usage__remaining--unknown': leftUnknown() && !isLocal(snapshot()) }}>{primary(snapshot())}</span>
        <span class="usage__used">{secondary(snapshot())}</span>
      </div>
    </article>
  )
}

/** One provider: state, quota rings when the provider reports them, today's numbers and recent sessions. */
function ProviderCard(props: { group: ProviderSummary; now: number; compact?: boolean }) {
  const group = () => props.group
  const info = () => group().activity
  const meta = () => providerMeta(group().id)
  const working = () => !!info()?.activeNow || liveSessions(props.now).some((session) => session.provider === group().id)
  const tokens = () => { const local = group().local; return local?.status === 'ok' && local.used != null ? local.used : null }
  const windowText = () => group().local?.window === '7d' ? 'week' : '24h'
  const state = () => working() ? 'Working now' : (info()?.sessions24h ?? 0) > 0 ? `Active ${agoLabel(info()?.lastActiveAt, props.now)}` : info()?.lastActiveAt ? `Idle, last used ${agoLabel(info()!.lastActiveAt, props.now)}` : 'Installed, no sessions yet'
  const leftText = () => {
    const first = group().quota[0]
    return first ? `${remainingPercent(first) ?? '?'}%` : (info()?.sessions24h ?? 0) > 0 ? String(info()!.sessions24h) : '-'
  }
  const leftCaption = () => group().quota[0] ? `${windowLabel(group().quota[0].window)} left` : (info()?.sessions24h ?? 0) === 1 ? 'session today' : 'sessions today'
  if (props.compact) return (
    <article class="usage__prov usage__prov--mini" classList={{ 'usage__prov--live': working() }}>
      <AiActivityMark provider={group().id} size={30} />
      <div class="usage__prov-main"><div class="usage__card-label">{meta().label}</div><div class="usage__detail">{state()}</div></div>
      <div class="usage__remaining-block"><span class="usage__remaining">{leftText()}</span><span class="usage__used">{leftCaption()}</span></div>
    </article>
  )
  return (
    <article class="usage__prov" classList={{ 'usage__prov--live': working(), 'usage__prov--idle': !working() && (info()?.sessions7d ?? 0) === 0 }}>
      <header class="usage__prov-head">
        <AiActivityMark provider={group().id} size={34} />
        <div class="usage__prov-main">
          <div class="usage__card-label">{meta().label}</div>
          <div class="usage__prov-state"><Show when={working()}><span class="usage__live-dot" aria-hidden="true" /></Show>{state()}</div>
        </div>
      </header>
      <Show when={group().quota.length > 0}>
        <div class="usage__prov-quota"><For each={group().quota.slice(0, 2)}>{(snapshot) => <SnapshotCard snapshot={snapshot} now={props.now} />}</For></div>
      </Show>
      <Show when={info()}>
        <dl class="usage__stats">
          <div><dt>Sessions today</dt><dd>{info()!.sessions24h}</dd></div>
          <div><dt>Avg reply</dt><dd>{info()!.avgResponseMs != null ? formatDuration(info()!.avgResponseMs) : '-'}</dd></div>
          <div><dt>Tokens, {windowText()}</dt><dd>{tokens() != null ? compactTokens(tokens()) : '-'}</dd></div>
        </dl>
        <Show when={info()!.recent.length > 0} fallback={<p class="usage__prov-empty">{group().local?.detail ?? 'No sessions yet.'}</p>}>
          <ul class="usage__recent" aria-label={`Recent ${meta().label} sessions`}>
            <For each={info()!.recent.slice(0, 3)}>{(session) => (
              <li classList={{ 'usage__recent--live': session.active }}>
                <span class="usage__recent-title" title={session.title}>{session.title}</span>
                <span class="usage__recent-meta">{[session.project, session.tokens ? `${compactTokens(session.tokens)} tokens` : null, session.active ? 'now' : agoLabel(session.lastActiveAt, props.now)].filter(Boolean).join(' · ')}</span>
              </li>
            )}</For>
          </ul>
        </Show>
      </Show>
    </article>
  )
}

export default function UsageView(props: { compact?: boolean }) {
  const [pending, setPending] = createSignal(false)
  const [refreshError, setRefreshError] = createSignal<string | null>(null)
  const groups = createMemo(() => groupProviders(usage() as Snapshot[]).filter((group) => providerShown(group.id)))
  const manual = createMemo(() => (usage() as Snapshot[]).filter((snapshot) => snapshot.provider === 'manual' && snapshot.status === 'ok'))
  const total = () => groups().length + manual().length
  // Countdowns and "stale" flags re-evaluate every 30 seconds instead of freezing at mount.
  const [now, setNow] = createSignal(Date.now())
  const tick = window.setInterval(() => setNow(Date.now()), 30000)
  onCleanup(() => window.clearInterval(tick))

  const refresh = async () => {
    if (pending()) return
    setPending(true)
    setRefreshError(null)
    try { await refreshUsage() } catch { setRefreshError('Could not refresh usage. Try again in a moment.') }
    finally { setPending(false) }
  }
  const emptyTitle = () => (usage() as Snapshot[]).some((s) => s.provider !== 'manual') ? 'All tools hidden' : 'No AI tools found'
  const emptyHint = () => (usage() as Snapshot[]).some((s) => s.provider !== 'manual') ? 'Turn one back on in Settings, AI.' : 'Codex, Claude Code, Gemini CLI, Cursor, OpenCode and Copilot show up here once installed.'

  if (props.compact) return (
    <>
      <header class="widget__head">
        <span class="widget__title"><Gauge class="icon icon--sm" strokeWidth={1.7} aria-hidden="true" />Usage</span>
        <button type="button" class="text-button usage__mini-refresh" aria-label="Refresh usage" title="Refresh usage" onClick={() => void refresh()}>
          <RefreshCw class={`icon icon--sm${pending() ? ' usage__refresh-icon--spin' : ''}`} strokeWidth={1.75} />
        </button>
      </header>
      <Show when={total() > 0} fallback={<div class="widget__empty">{emptyTitle()}.</div>}>
        <div class="usage-mini">
          <For each={groups()}>{(group) => <ProviderCard group={group} now={now()} compact />}</For>
          <For each={manual()}>{(snapshot) => <SnapshotCard snapshot={snapshot} now={now()} />}</For>
        </div>
      </Show>
      <Show when={refreshError()}><p class="inline-error" role="status">{refreshError()}</p></Show>
    </>
  )

  return (
    <div class="usage">
      <div class="usage__head">
        <div class="usage__head-left"><span class="usage__head-title">Usage</span><span class="usage__head-sub">{total()} {total() === 1 ? 'tool' : 'tools'}</span></div>
        <button type="button" class="button usage__refresh" onClick={() => void refresh()} disabled={pending()}>
          <RefreshCw class={`icon icon--sm usage__refresh-icon${pending() ? ' usage__refresh-icon--spin' : ''}`} strokeWidth={1.75} />
          <span>{pending() ? 'Refreshing' : 'Refresh'}</span>
        </button>
      </div>
      <Show when={refreshError()}>{(error) => <div class="inline-error usage__error" role="status">{error()}</div>}</Show>
      <Show when={total() > 0} fallback={<div class="usage__empty"><span class="usage__empty-glyph"><Gauge class="icon" strokeWidth={1.75} /></span><span class="usage__empty-title">{emptyTitle()}</span><span class="usage__empty-hint">{emptyHint()}</span></div>}>
        <div class="usage__grid">
          <For each={groups()}>{(group) => <ProviderCard group={group} now={now()} />}</For>
          <For each={manual()}>{(snapshot) => <SnapshotCard snapshot={snapshot} now={now()} />}</For>
        </div>
      </Show>
    </div>
  )
}
