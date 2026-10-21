import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Sparkles } from 'lucide-solid'
import { settings } from '../../state/settings'
import { usage } from '../../state/usage'
import type { UsageProviderKind, UsageSnapshot } from '../../lib/ipc'
import { isReportStale, remainingPercent, reportAge, resetCountdown, usedRatio, windowLabel } from '../../lib/usageDisplay'
import BrandIcon from '../BrandIcon'
import './widgets.css'

interface ProviderMeta { label: string; brand: string }
const PROVIDERS: Record<UsageProviderKind, ProviderMeta> = {
  codex: { label: 'Codex', brand: 'codex' },
  'claude-code': { label: 'Claude Code', brand: 'claude' },
  cursor: { label: 'Cursor', brand: 'cursor' },
  manual: { label: 'Custom', brand: 'custom' },
}
function ProviderIcon(props: { kind: UsageProviderKind }) {
  return <BrandIcon name={PROVIDERS[props.kind].brand} size={17} class="prov-icon__brand" />
}
type DisplayRow = { kind: UsageProviderKind; label: string; snapshot?: UsageSnapshot }

export default function AiView() {
  const [now, setNow] = createSignal(Date.now())
  const [page, setPage] = createSignal(0)
  onMount(() => { const timer = setInterval(() => setNow(Date.now()), 30000); onCleanup(() => clearInterval(timer)) })
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

  return (
    <>
      <header class="widget__head">
        <span class="widget__title"><Sparkles class="icon icon--sm" strokeWidth={1.7} aria-hidden="true" />AI activity</span>
      </header>
      <Show when={rows().length > 0} fallback={<div class="widget__empty">Enable providers in Settings to track activity.</div>}>
        <div class="ai">
          <For each={rows().slice(Math.min(page(),Math.max(0,Math.ceil(rows().length/2)-1))*2,Math.min(page(),Math.max(0,Math.ceil(rows().length/2)-1))*2+2)}>{(row) => {
            const snapshot = () => row.snapshot
            const isLocal = () => snapshot()?.source === 'local-logs'
            const left = () => snapshot() ? remainingPercent(snapshot()!) : null
            const used = () => snapshot() ? usedRatio(snapshot()!) : null
            const tone = () => snapshot()?.status === 'error' ? 'var(--danger)' : 'var(--accent)'
            const main = () => {
              const s = snapshot()
              if (!s || s.status !== 'ok') return 'Unavailable'
              if (isLocal()) return `${s.used == null || !Number.isFinite(s.used) ? '—' : `${(s.used / 1000).toFixed(1)}k`} tokens`
              return left() == null ? 'Remaining unknown' : `${left()}% left`
            }
            const sub = () => {
              const s = snapshot()
              if (!s || s.status !== 'ok') return s?.detail ?? 'Waiting for provider report'
              if (isLocal()) return `Local activity · ${windowLabel(s.window)} · ${reportAge(s.updatedAt)}`
              const details = [used() == null ? null : `${Math.round(used()! * 100)}% used`, windowLabel(s.window)]
              if (s.source === 'official-rate-limit') {
                details.push(resetCountdown(s.resetAt))
                if (isReportStale(s.updatedAt)) details.push('stale')
              }
              return details.filter(Boolean).join(' · ')
            }
            const bar = () => isLocal() ? used() : left() == null ? null : left()! / 100
            return (
              <div class="ai__row">
                <ProviderIcon kind={row.kind} />
                <div class="ai__meta">
                  <span class="ai__label">{PROVIDERS[row.kind].label}{row.kind === 'codex' ? ` · ${row.label}` : ''}</span>
                  <span class="ai__bar"><Show when={bar() != null}><span class="ai__fill" style={{ width: `${Math.round(bar()! * 100)}%`, background: tone() }} /></Show></span>
                  <span class="ai__sub" title={`${sub()} · ${snapshot()?.updatedAt ? reportAge(snapshot()?.updatedAt, now()) : ''}`}>{sub()}</span>
                </div>
                <span class="ai__val" style={{ color: tone() }}>{main()}</span>
              </div>
            )
          }}</For>
        </div>
        <Show when={rows().length>2}><div class="widget-list-pager"><button class="text-button" disabled={page()===0} aria-label="Previous AI reports" onClick={()=>setPage(Math.max(0,page()-1))}>‹</button><span>{Math.min(page()+1,Math.ceil(rows().length/2))} / {Math.ceil(rows().length/2)}</span><button class="text-button" disabled={(page()+1)*2>=rows().length} aria-label="Next AI reports" onClick={()=>setPage(page()+1)}>›</button></div></Show>
      </Show>
    </>
  )
}
