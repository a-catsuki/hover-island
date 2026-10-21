import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import {
  ArrowDown,
  ArrowUp,
  Calculator,
  CornerDownLeft,
  FileText,
  Globe,
  Search,
  Terminal,
  X,
} from 'lucide-solid'
import type { SearchResult } from '../../lib/ipc'
import {
  closeSpotlight,
  runResult,
  setSpotlightQuery,
  spotlightLoading,
  spotlightPending,
  spotlightError,
  spotlightQuery,
  spotlightResults,
} from '../../state/spotlight'
import './SpotlightView.css'

const MAX_ROWS = 10

const KIND_LABEL: Record<string, string> = {
  app: 'Applications',
  command: 'Commands',
  file: 'Documents',
  url: 'Links',
  web: 'Web',
  calc: 'Calculator',
}

/* --------------------------------- icons --------------------------------- */

const HUES = [211, 262, 330, 14, 36, 142, 174, 195]
function hueFor(name: string): number {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0
  return HUES[hash % HUES.length]
}

/** App tile: the real icon when the backend sends one, otherwise a tinted monogram squircle. */
function ResultIcon(props: { result: SearchResult }) {
  const glyph = { size: 17, strokeWidth: 1.75, 'aria-hidden': 'true' as const }
  const kind = () => props.result.kind
  return <span class="spotlight__icon" classList={{ [`spotlight__icon--${kind()}`]: true }}
    style={kind() === 'app' && !props.result.icon ? `--hue:${hueFor(props.result.title)}` : undefined}>
    <Show when={props.result.icon} fallback={
      <Show when={kind() === 'app'} fallback={
        kind() === 'file' ? <FileText {...glyph}/> : kind() === 'url' ? <Globe {...glyph}/> : kind() === 'web' ? <Search {...glyph}/>
          : kind() === 'calc' ? <Calculator {...glyph}/> : <Terminal {...glyph}/>
      }>
        <span class="spotlight__mono" aria-hidden="true">{Array.from(props.result.title.trim())[0]?.toUpperCase() ?? '?'}</span>
      </Show>
    }>{icon => <img src={icon()} alt="" draggable={false}/>}</Show>
  </span>
}

/* ----------------------------- text highlight ---------------------------- */

interface Part {
  text: string
  match: boolean
}

function highlight(title: string, query: string): Part[] {
  const chars = Array.from(title)
  const q = Array.from(query.trim().toLowerCase())
  if (!q.length) return [{ text: title, match: false }]
  const lower = chars.map((ch) => ch.toLowerCase())
  let matchStart = -1
  for (let start = 0; start <= lower.length - q.length; start++) {
    if (q.every((ch, offset) => lower[start + offset] === ch)) {
      matchStart = start
      break
    }
  }
  if (matchStart >= 0) {
    return [
      { text: chars.slice(0, matchStart).join(''), match: false },
      { text: chars.slice(matchStart, matchStart + q.length).join(''), match: true },
      { text: chars.slice(matchStart + q.length).join(''), match: false },
    ].filter((part) => part.text.length > 0)
  }

  // Fuzzy subsequence fallback: mark each matched character without slicing UTF-16 offsets.
  const flags = new Set<number>()
  let qi = 0
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) {
      flags.add(i)
      qi++
    }
  }
  if (qi !== q.length) return [{ text: title, match: false }]
  const parts: Part[] = []
  let buffer = ''
  let isMatching = false
  for (let i = 0; i < chars.length; i++) {
    const nextMatching = flags.has(i)
    if (buffer && nextMatching !== isMatching) {
      parts.push({ text: buffer, match: isMatching })
      buffer = ''
    }
    isMatching = nextMatching
    buffer += chars[i]
  }
  if (buffer) parts.push({ text: buffer, match: isMatching })
  return parts
}

function actionHint(result: SearchResult): string {
  switch (result.action) {
    case 'launch':
      return 'Launch'
    case 'open':
      return result.kind === 'web' ? 'Search' : 'Open'
    case 'copy':
      return 'Copy'
    case 'run':
      return 'Run'
    default:
      return 'Open'
  }
}

/* -------------------------------- skeleton ------------------------------- */

function Shimmer() {
  return (
    <div class="spotlight__shimmer" aria-hidden="true">
      <For each={[0, 1, 2, 3]}>
        {() => (
          <div class="spotlight__shimmer-row">
            <span class="spotlight__shimmer-icon" />
            <span class="spotlight__shimmer-line" />
          </div>
        )}
      </For>
    </div>
  )
}

/* --------------------------------- view ---------------------------------- */

export default function SpotlightView() {
  let panelRef: HTMLDivElement | undefined
  let inputRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined
  const [active, setActive] = createSignal(0)
  // Enter pressed while results were still loading: open the first hit once they land.
  const [enterQueued, setEnterQueued] = createSignal(false)

  // Top Hit first, then the rest grouped by kind (stable, first appearance wins).
  // Navigation, Enter and the headers all use this same order.
  const rows = createMemo(() => {
    const all = spotlightResults().slice(0, MAX_ROWS)
    if (!spotlightQuery().trim() || all.length < 2) return all
    const [top, ...rest] = all
    const order: string[] = []
    for (const item of rest) if (!order.includes(item.kind)) order.push(item.kind)
    return [top, ...order.flatMap(kind => rest.filter(item => item.kind === kind))]
  })

  const entries = createMemo(() => {
    const searching = Boolean(spotlightQuery().trim())
    let prev = ''
    return rows().map((result, index) => {
      let header: string | null = null
      if (!searching) {
        if (index === 0) header = result.kind === 'app' && !spotlightResults().some(item => item.score > 0) ? 'Applications' : 'Recent'
      } else if (index === 0) header = 'Top Hit'
      else if (index === 1 || result.kind !== prev) header = KIND_LABEL[result.kind] ?? 'Results'
      prev = result.kind
      return { result, index, header }
    })
  })

  createEffect(() => {
    spotlightResults()
    setActive(0)
    if (listRef) listRef.scrollTop = 0
  })

  const scrollActiveIntoView = (index: number) => {
    listRef?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  const move = (delta: number) => {
    const len = rows().length
    if (!len || spotlightPending()) return
    const next = (active() + delta + len) % len
    setActive(next)
    scrollActiveIntoView(next)
  }

  const choose = (result: SearchResult | undefined) => {
    if (result) void runResult(result)
  }

  const submit = () => {
    if (spotlightPending()) { setEnterQueued(true); return }
    choose(rows()[active()])
  }

  createEffect(() => {
    if (!enterQueued() || spotlightPending()) return
    setEnterQueued(false)
    choose(rows()[0])
  })

  const clearQuery = () => {
    setSpotlightQuery('')
    inputRef?.focus()
  }

  onMount(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    inputRef?.focus()

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const targets = Array.from(panelRef?.querySelectorAll<HTMLElement>('input,button:not(:disabled):not([tabindex="-1"])') ?? [])
        if (!targets.length) return
        const current = targets.indexOf(document.activeElement as HTMLElement)
        const next = (current + (event.shiftKey ? -1 : 1) + targets.length) % targets.length
        event.preventDefault()
        targets[next].focus()
        return
      }
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault()
          move(1)
          break
        case 'ArrowUp':
          event.preventDefault()
          move(-1)
          break
        case 'Enter':
          // Let focused buttons (clear) handle their own Enter.
          if (event.target instanceof HTMLButtonElement && event.target.type === 'button' && !event.target.matches('[role="option"]')) break
          event.preventDefault()
          if (!event.isComposing) submit()
          break
        case 'Escape':
          event.preventDefault()
          event.stopPropagation()
          closeSpotlight()
          break
      }
    }
    window.addEventListener('keydown', onKey, true)
    onCleanup(() => { window.removeEventListener('keydown', onKey, true); previousFocus?.focus?.() })
  })

  const emptyTitle = () => spotlightError() ? 'Search unavailable' : !spotlightQuery().trim() ? 'Nothing here yet' : 'No results'
  const emptyHint = () => spotlightError() ?? (!spotlightQuery().trim() ? 'Apps and files you open will show up here.' : `Nothing matches "${spotlightQuery().trim()}". Try another name.`)

  return (
    <div class="spotlight" role="dialog" aria-modal="true" aria-label="Spotlight search" onMouseDown={event => { if (event.target === event.currentTarget) closeSpotlight() }}>
      <div class="spotlight__panel" ref={panelRef}>
        <div class="spotlight__search">
          <Search class="spotlight__glass" size={22} strokeWidth={1.9} aria-hidden="true" />
          <input
            ref={inputRef}
            class="spotlight__input"
            type="text"
            role="combobox"
            aria-label="Search apps, files and the web"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="spotlight-results"
            aria-activedescendant={rows()[active()] ? `search-result-${active()}` : undefined}
            value={spotlightQuery()}
            spellcheck={false}
            autocomplete="off"
            placeholder="Spotlight Search"
            onInput={(event) => setSpotlightQuery(event.currentTarget.value)}
          />
          <Show when={spotlightQuery().length > 0}>
            <button type="button" class="spotlight__clear" onClick={clearQuery} aria-label="Clear search">
              <X size={13} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </Show>
        </div>

        <div id="spotlight-results" class="spotlight__results" classList={{ 'is-stale': spotlightPending() && entries().length > 0 }} role="listbox" aria-label="Search results" ref={listRef} aria-busy={spotlightLoading() || spotlightPending()}>
          <Show when={!(spotlightLoading() && !entries().length)} fallback={<Shimmer />}>
            <Show
              when={entries().length > 0}
              fallback={
                <Show when={!spotlightPending()}>
                  <div class="spotlight__empty" role={spotlightError() ? 'status' : undefined}>
                    <Search size={26} strokeWidth={1.5} aria-hidden="true" />
                    <span class="spotlight__empty-title">{emptyTitle()}</span>
                    <span class="spotlight__empty-hint">{emptyHint()}</span>
                  </div>
                </Show>
              }
            >
              <For each={entries()}>
                {(entry) => (
                  <>
                    <Show when={entry.header}>
                      {(label) => <div class="spotlight__group" role="presentation">{label()}</div>}
                    </Show>
                    <button
                      type="button"
                      role="option"
                      id={`search-result-${entry.index}`}
                      aria-selected={active() === entry.index}
                      tabIndex={-1}
                      class="spotlight__row"
                      classList={{ 'is-active': active() === entry.index }}
                      data-index={entry.index}
                      onMouseMove={() => active() !== entry.index && setActive(entry.index)}
                      onClick={() => choose(entry.result)}
                    >
                      <ResultIcon result={entry.result} />
                      <span class="spotlight__meta">
                        <span class="spotlight__title">
                          <For each={highlight(entry.result.title, spotlightQuery())}>
                            {(part) => <span classList={{ 'spotlight__match': part.match }}>{part.text}</span>}
                          </For>
                        </span>
                        <Show when={entry.result.subtitle}>
                          {(subtitle) => <span class="spotlight__subtitle">{subtitle()}</span>}
                        </Show>
                      </span>
                      <span class="spotlight__hint">{actionHint(entry.result)}<CornerDownLeft size={12} strokeWidth={2.2} aria-hidden="true" /></span>
                    </button>
                  </>
                )}
              </For>
            </Show>
          </Show>
        </div>

        <Show when={spotlightError() && entries().length > 0}><p class="spotlight__error" role="alert">{spotlightError()}</p></Show>

        <div class="spotlight__footer" aria-hidden="true">
          <span class="spotlight__key"><kbd><ArrowUp size={11} strokeWidth={2.2} /></kbd><kbd><ArrowDown size={11} strokeWidth={2.2} /></kbd>navigate</span>
          <span class="spotlight__key"><kbd><CornerDownLeft size={11} strokeWidth={2.2} /></kbd>open</span>
          <span class="spotlight__key"><kbd>esc</kbd>close</span>
        </div>
      </div>
    </div>
  )
}
