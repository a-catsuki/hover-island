import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { ChevronLeft, ChevronRight, Sparkles } from 'lucide-solid'
import { settings } from '../../state/settings'
import { providerShown, usage } from '../../state/usage'
import { liveSessions } from '../../state/aiActivity'
import type { UsageSnapshot } from '../../lib/ipc'
import { agoLabel, compactTokens, formatDuration, groupProviders, isReportStale, providerMeta, remainingPercent, resetCountdown, windowLabel } from '../../lib/usageDisplay'
import AiActivityMark from '../shell/AiActivityMark'
import Ring from './Ring'
import './widgetKit.css'
import './AiView.css'

interface Tile {
  id: string
  title: string
  center: string
  caption: string
  ring: number | null
  tone: 'ok' | 'low' | 'idle' | 'warn'
  active: boolean
  hint: string
}

const COLOR = { ok: '#BF5AF2', low: '#FF9F0A', idle: '#8E8E93', warn: '#FF453A' } as const

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

  const groups = createMemo(() => groupProviders(usage()))
  const shown = createMemo(() => groups().filter((group) => providerShown(group.id)))

  const tiles = createMemo<Tile[]>(() => {
    const live = liveSessions(now())
    const out: Tile[] = []
    for (const group of shown()) {
      const meta = providerMeta(group.id)
      const info = group.activity
      const working = live.some((session) => session.provider === group.id) || !!info?.activeNow
      const extra = [info?.avgResponseMs != null ? `${formatDuration(info.avgResponseMs)} reply` : null].filter(Boolean).join(' · ')
      if (group.quota.length) {
        for (const snapshot of group.quota.slice(0, 2)) {
          const left = remainingPercent(snapshot)
          out.push({
            id: `${group.id}:${snapshot.window ?? snapshot.label}`,
            title: `${meta.label} ${windowLabel(snapshot.window)}`,
            center: left == null ? '?' : `${left}%`,
            caption: [resetCountdown(snapshot.resetAt), isReportStale(snapshot.updatedAt) ? 'stale' : null].filter(Boolean).join(' · '),
            ring: left == null ? null : left / 100,
            tone: left != null && left <= 15 ? 'low' : 'ok',
            active: working,
            hint: `${snapshot.label}: ${left ?? 'unknown'}% left${extra ? ` · ${extra}` : ''}`,
          })
        }
        continue
      }
      const sessions24h = info?.sessions24h ?? 0
      const local = group.local
      const hasTokens = local?.status === 'ok' && local.used != null && local.used > 0
      const idle = sessions24h === 0 && !working
      out.push({
        id: group.id,
        title: meta.label,
        center: hasTokens ? compactTokens(local!.used) : String(sessions24h),
        caption: working ? 'Working now' : idle ? (info?.lastActiveAt ? `Idle · ${agoLabel(info.lastActiveAt, now())}` : 'No sessions yet') : extra || (hasTokens ? 'tokens, 24h' : sessions24h === 1 ? '1 session today' : `${sessions24h} sessions today`),
        ring: idle ? 0 : 1,
        tone: idle ? 'idle' : 'ok',
        active: working,
        hint: [local?.detail, extra].filter(Boolean).join(' · ') || meta.label,
      })
    }
    return out
  })

  const columns = () => Math.max(1, Math.min(4, Math.floor(box().width / 104)))
  const gridRows = () => Math.max(1, Math.floor((box().height - 34) / 128))
  const capacity = () => columns() * gridRows()
  const pageCount = () => Math.max(1, Math.ceil(tiles().length / capacity()))
  const current = () => Math.min(page(), pageCount() - 1)
  const visible = () => tiles().slice(current() * capacity(), (current() + 1) * capacity())
  const hiddenCount = () => groups().length - shown().length

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
      <Show when={tiles().length > 0} fallback={
        <div class="wk-empty">
          <Show when={groups().length === 0} fallback={<><strong>All tools hidden</strong><p>Turn one back on in Settings, AI.</p></>}>
            <strong>No AI tools found</strong><p>Codex, Claude Code, Gemini CLI and others show up once installed.</p>
          </Show>
        </div>
      }>
        <div class="ai__grid" style={{ '--ai-cols': Math.min(columns(), visible().length) }}>
          <For each={visible()}>{(tile) => (
            <div class="ai__gauge" classList={{ 'ai__gauge--live': tile.active }} title={`${tile.hint}`}>
              <Ring value={tile.ring} color={COLOR[tile.tone]} stroke={8} label={`${tile.title}: ${tile.center}, ${tile.caption}`}>
                <span class="ai__center"><strong>{tile.center}</strong><AiActivityMark provider={tile.id.split(':')[0]} size={16} /></span>
              </Ring>
              <span class="ai__label">{tile.title}</span>
              <span class="ai__sub">{tile.caption}</span>
            </div>
          )}</For>
        </div>
        <Show when={hiddenCount() > 0}><span class="ai__hidden">{hiddenCount()} hidden in Settings</span></Show>
      </Show>
    </section>
  )
}
