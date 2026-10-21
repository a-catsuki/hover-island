import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { ChevronLeft, ChevronRight, Sparkles } from 'lucide-solid'
import { settings } from '../../state/settings'
import { usage } from '../../state/usage'
import type { UsageProviderKind, UsageSnapshot } from '../../lib/ipc'
import { isReportStale, remainingPercent, reportAge, resetCountdown, usedRatio, windowLabel } from '../../lib/usageDisplay'
import BrandIcon from '../BrandIcon'
import Ring from './Ring'
import './widgetKit.css'
import './AiView.css'

interface ProviderMeta { label: string; brand: string }
const PROVIDERS: Record<UsageProviderKind, ProviderMeta> = {
  codex: { label: 'Codex', brand: 'codex' },
  'claude-code': { label: 'Claude Code', brand: 'claude' },
  cursor: { label: 'Cursor', brand: 'cursor' },
  manual: { label: 'Custom', brand: 'custom' },
}
function ProviderIcon(props: { kind: UsageProviderKind }) {
  return <BrandIcon name={PROVIDERS[props.kind].brand} size={18} class="prov-icon__brand" />
}
type DisplayRow = { kind: UsageProviderKind; label: string; snapshot?: UsageSnapshot }

export default function AiView() {
  const [now, setNow] = createSignal(Date.now())
  const [page, setPage] = createSignal(0)
  const [box, setBox] = createSignal({ width: 342, height: 201 })
  let root: HTMLElement | undefined
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000)
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(([entry]) => setBox({ width: entry.contentRect.width, height: entry.contentRect.height }))
    if (resize && root) resize.observe(root)
    onCleanup(() => { clearInterval(timer); resize?.disconnect() })
  })
  const enabled = createMemo(() => {
    const flags = settings.usage
    return (Object.keys(PROVIDERS) as UsageProviderKind[]).filter((kind) => {
      if (kind === 'claude-code') return flags.claudeCode
      if (kind === 'manual') return flags.manual
      return flags[kind as 'codex' | 'cursor']
    })
  })

  const rows = createMemo(() => {
    const all = usage()
    const result: DisplayRow[] = []
    for (const kind of enabled()) {
      const candidates = all.filter((item) => item.provider === kind)
      if (kind === 'codex') {
        const quota = candidates.filter((item) => item.source === 'official-rate-limit')
        if (quota.length) {
          const ordered = [...quota].sort((a, b) => (windowLabel(a.window) === '5-hour' ? -1 : 1) - (windowLabel(b.window) === '5-hour' ? -1 : 1))
          for (const snapshot of ordered.slice(0, 2)) result.push({ kind, label: windowLabel(snapshot.window), snapshot })
          continue
        }
      }
      const snapshot = candidates.find((item) => item.source === 'local-logs')
        ?? candidates.find((item) => item.status === 'ok')
        ?? candidates[0]
      if (snapshot) result.push({ kind, label: PROVIDERS[kind].label, snapshot })
    }
    return result
  })

  const columns = () => Math.max(1, Math.min(4, Math.floor(box().width / 104)))
  const gridRows = () => Math.max(1, Math.floor((box().height - 34) / 128))
  const capacity = () => columns() * gridRows()
  const pageCount = () => Math.max(1, Math.ceil(rows().length / capacity()))
  const current = () => Math.min(page(), pageCount() - 1)
  const visible = () => rows().slice(current() * capacity(), (current() + 1) * capacity())

  return (
    <section class="wk ai" aria-label="AI activity" ref={root}>
      <header class="wk-head">
        <span class="wk-title"><span class="wk-glyph" style={{ background: '#BF5AF2' }}><Sparkles size={13} strokeWidth={2.2} aria-hidden="true" /></span><span>AI activity</span></span>
        <Show when={pageCount() > 1}>
          <span class="wk-tools">
            <button class="wk-icon-btn" aria-label="Previous AI reports" disabled={current() === 0} onClick={() => setPage(current() - 1)}><ChevronLeft size={15} /></button>
            <span class="wk-sub">{current() + 1}/{pageCount()}</span>
            <button class="wk-icon-btn" aria-label="Next AI reports" disabled={current() >= pageCount() - 1} onClick={() => setPage(current() + 1)}><ChevronRight size={15} /></button>
          </span>
        </Show>
      </header>
      <Show when={rows().length > 0} fallback={<div class="wk-empty"><strong>No providers</strong><p>Turn on a provider in Settings.</p></div>}>
        <div class="ai__grid" style={{ '--ai-cols': Math.min(columns(), visible().length) }}>
          <For each={visible()}>{(row) => {
            const snapshot = () => row.snapshot
            const isLocal = () => snapshot()?.source === 'local-logs'
            const ok = () => snapshot()?.status === 'ok'
            const left = () => snapshot() ? remainingPercent(snapshot()!) : null
            const color = () => !ok() ? '#FF453A' : left() != null && left()! <= 15 ? '#FF9F0A' : '#BF5AF2'
            const ringValue = () => !ok() ? null : isLocal() ? 1 : left() == null ? null : left()! / 100
            const center = () => !ok() ? '!' : isLocal() ? `${snapshot()!.used == null || !Number.isFinite(snapshot()!.used) ? '-' : `${(snapshot()!.used! / 1000).toFixed(1)}k`}` : left() == null ? '?' : `${left()}%`
            const caption = () => {
              const s = snapshot()
              if (!s || !ok()) return s?.detail ?? 'Waiting for report'
              if (isLocal()) return 'tokens, last 24h'
              const bits = [resetCountdown(s.resetAt)]
              if (s.source === 'official-rate-limit' && isReportStale(s.updatedAt)) bits.push('stale')
              return bits.join(' · ')
            }
            return (
              <div class="ai__gauge" title={`${caption()} · ${snapshot()?.updatedAt ? reportAge(snapshot()?.updatedAt, now()) : ''}`}>
                <Ring value={ringValue()} color={color()} stroke={8} label={`${PROVIDERS[row.kind].label}${row.kind === 'codex' ? ` ${row.label}` : ''}: ${isLocal() ? center() + ' tokens' : center() + ' left'}`}>
                  <span class="ai__center"><strong>{center()}</strong><ProviderIcon kind={row.kind} /></span>
                </Ring>
                <span class="ai__label">{PROVIDERS[row.kind].label}{row.kind === 'codex' ? ` ${row.label}` : ''}</span>
                <span class="ai__sub">{caption()}</span>
              </div>
            )
          }}</For>
        </div>
      </Show>
    </section>
  )
}
