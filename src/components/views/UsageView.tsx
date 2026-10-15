import { createMemo, createSignal, For, Show } from 'solid-js'
import { Gauge, RefreshCw } from 'lucide-solid'
import type { UsageSnapshot } from '../../lib/ipc'
import { isReportStale, remainingPercent, reportAge, resetCountdown, resetTimeLabel, usedRatio, windowLabel } from '../../lib/usageDisplay'
import { refreshUsage, usage } from '../../state/usage'
import BrandIcon from '../BrandIcon'
import './UsageView.css'

type Snapshot = UsageSnapshot & { source?: string | null; resetAt?: number | null }

function providerLabel(provider: UsageSnapshot['provider']): string {
  switch (provider) {
    case 'codex': return 'Codex'
    case 'claude-code': return 'Claude Code'
    case 'cursor': return 'Cursor'
    default: return 'Custom'
  }
}

function statusColor(status: UsageSnapshot['status']): string {
  if (status === 'error') return 'var(--danger)'
  if (status === 'unknown') return 'var(--warn)'
  return 'var(--accent)'
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
  if (provider === 'codex') return 'codex'
  if (provider === 'claude-code') return 'claude'
  if (provider === 'cursor') return 'cursor'
  return 'custom'
}

function description(snapshot: Snapshot, now = Date.now()): string {
  if (snapshot.status === 'error' || snapshot.status === 'unknown') return snapshot.detail || `${providerLabel(snapshot.provider)} report unavailable.`
  if (isLocal(snapshot)) return `${reportAge(snapshot.updatedAt, now)} · Local session activity only`
  if (isOfficial(snapshot)) {
    const reset = resetTimeLabel(snapshot.resetAt)
    const countdown = resetCountdown(snapshot.resetAt, now)
    const stale = isReportStale(snapshot.updatedAt, now)
    return [reportAge(snapshot.updatedAt, now), stale ? 'Report may be stale' : null,
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

function snapshotOrder(a: Snapshot, b: Snapshot): number {
  const providerOrder = ['codex', 'claude-code', 'cursor', 'manual']
  const windowOrder = (value: Snapshot) => windowLabel(value.window) === '5-hour' ? 0 : windowLabel(value.window) === 'Weekly' ? 1 : 2
  return providerOrder.indexOf(a.provider) - providerOrder.indexOf(b.provider)
    || (a.provider === 'codex' ? windowOrder(a) - windowOrder(b) : 0)
    || a.label.localeCompare(b.label)
}

function hasUsageEvidence(snapshot: Snapshot): boolean {
  return snapshot.status === 'ok'
    && (snapshot.source === 'official-rate-limit' || snapshot.source === 'local-logs' || snapshot.source === 'manual')
}

function shownSnapshots(all: Snapshot[], compact: boolean): Snapshot[] {
  all = all.filter(hasUsageEvidence)
  const codex = all.filter((s) => s.provider === 'codex' && isOfficial(s)).sort(snapshotOrder)
  if (!compact) return [...all].sort(snapshotOrder)
  // Keep Codex's two provider-reported windows together. Secondary sources are intentionally omitted
  // from the compact tile to avoid turning it into a list of unsupported-provider warnings.
  if (codex.length) return codex.slice(0, 2)
  return all.filter((s) => s.status === 'ok' && (isLocal(s) || remainingPercent(s) != null)).sort(snapshotOrder).slice(0, 2)
}

function Meter(props: { value: number | null }) {
  return <div class="usage__meter-bg" aria-hidden="true"><div class="usage__meter-fill" style={{ width: `${props.value ?? 0}%` }} /></div>
}

function SnapshotCard(props: { snapshot: Snapshot }) {
  const snapshot = () => props.snapshot
  const left = () => remainingPercent(snapshot())
  const leftUnknown = () => left() == null || snapshot().status !== 'ok'
  const stale = () => isOfficial(snapshot()) && isReportStale(snapshot().updatedAt)
  const due = () => isOfficial(snapshot()) && !!snapshot().resetAt && snapshot().resetAt! <= Date.now()
  const meterValue = () => isLocal(snapshot()) ? (usedRatio(snapshot()) == null ? null : Math.round(usedRatio(snapshot())! * 100)) : left()
  const meterLabel = () => isLocal(snapshot()) ? 'Local usage activity' : `${left() ?? 'Unknown'} percent remaining`
  return (
    <article class="usage__card" classList={{ 'usage__card--error': snapshot().status === 'error', 'usage__card--stale': stale(), 'usage__card--due': due() }}>
      <div class="usage__card-top">
        <div class="usage__card-head">
          <div class="usage__card-label"><BrandIcon name={providerBrand(snapshot().provider)} size={16} class="usage__brand" />{snapshot().label || providerLabel(snapshot().provider)}</div>
          <div class="usage__card-sub">
            <span class="usage__window-chip">{windowLabel(snapshot().window)}</span>
            <Show when={stale()}><span class="usage__state-chip usage__state-chip--stale">Report stale</span></Show>
            <Show when={due()}><span class="usage__state-chip usage__state-chip--due">Reset due · waiting for provider report</span></Show>
          </div>
        </div>
        <div class="usage__remaining-block">
          <span class="usage__remaining" classList={{ 'usage__remaining--unknown': leftUnknown() }}>{primary(snapshot())}</span>
          <span class="usage__used">{secondary(snapshot())}</span>
        </div>
      </div>
      <Show when={meterValue() != null}>
        <div class="usage__meter" role="img" aria-label={meterLabel()}>
          <Meter value={meterValue()} />
        </div>
      </Show>
      <div class="usage__detail">{description(snapshot())}</div>
    </article>
  )
}

export default function UsageView(props: { compact?: boolean }) {
  const [pending, setPending] = createSignal(false)
  const [refreshError, setRefreshError] = createSignal<string | null>(null)
  const ordered = createMemo(() => shownSnapshots(usage() as Snapshot[], !!props.compact))

  const refresh = async () => {
    if (pending()) return
    setPending(true)
    setRefreshError(null)
    try { await refreshUsage() } catch { setRefreshError('Could not refresh usage. Try again in a moment.') }
    finally { setPending(false) }
  }

  if (props.compact) return (
    <>
      <header class="widget__head">
        <span class="widget__title"><Gauge class="icon icon--sm" strokeWidth={1.7} aria-hidden="true" />Usage</span>
        <button type="button" class="text-button usage__mini-refresh" aria-label="Refresh usage" title="Refresh usage" onClick={() => void refresh()}>
          <RefreshCw class={`icon icon--sm${pending() ? ' usage__refresh-icon--spin' : ''}`} strokeWidth={1.75} />
        </button>
      </header>
      <Show when={ordered().length > 0} fallback={<div class="widget__empty">No provider usage report available.</div>}>
        <div class="usage-mini"><For each={ordered()}>{(snapshot) => <SnapshotCard snapshot={snapshot} />}</For></div>
      </Show>
      <Show when={refreshError()}><p class="inline-error" role="status">{refreshError()}</p></Show>
    </>
  )

  return (
    <div class="usage">
      <div class="usage__head">
        <div class="usage__head-left"><span class="usage__head-title">Usage</span><span class="usage__head-sub">{ordered().length} {ordered().length === 1 ? 'report' : 'reports'}</span></div>
        <button type="button" class="button usage__refresh" onClick={() => void refresh()} disabled={pending()}>
          <RefreshCw class={`icon icon--sm usage__refresh-icon${pending() ? ' usage__refresh-icon--spin' : ''}`} strokeWidth={1.75} />
          <span>{pending() ? 'Refreshing' : 'Refresh'}</span>
        </button>
      </div>
      <Show when={refreshError()}>{(error) => <div class="inline-error usage__error" role="status">{error()}</div>}</Show>
      <Show when={ordered().length > 0} fallback={<div class="usage__empty"><span class="usage__empty-glyph"><Gauge class="icon" strokeWidth={1.75} /></span><span class="usage__empty-title">No usage reports available</span><span class="usage__empty-hint">Only provider-reported quota and parsed recent local activity appear here.</span></div>}>
        <div class="usage__grid"><For each={ordered()}>{(snapshot) => <SnapshotCard snapshot={snapshot} />}</For></div>
      </Show>
    </div>
  )
}
