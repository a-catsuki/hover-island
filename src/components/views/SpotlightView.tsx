import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import {
  AppWindow,
  ArrowDown,
  ArrowUp,
  Calculator,
  CornerDownLeft,
  FileText,
  Globe,
  Search,
  X,
} from 'lucide-solid'
import type { SearchResult } from '../../lib/ipc'
import {
  closeSpotlight,
  runResult,
  setSpotlightQuery,
  spotlightLoading,
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

function KindIcon(props: { kind: string }) {
  const icon = {
    class: 'icon icon--lg',
    strokeWidth: 1.75,
    color: 'currentColor',
    'aria-hidden': 'true' as const,
  }
  switch (props.kind) {
    case 'file':
      return <FileText {...icon} />
    case 'url':
      return <Globe {...icon} />
    case 'web':
      return <Search {...icon} />
    case 'calc':
      return <Calculator {...icon} />
    default:
      // app / command
      return <AppWindow {...icon} />
  }
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
      <For each={[0, 1, 2, 3, 4]}>
        {() => (
          <div class="spotlight__shimmer-row">
            <span class="spotlight__shimmer-icon" />
            <span class="spotlight__shimmer-meta">
              <span class="spotlight__shimmer-line" />
              <span class="spotlight__shimmer-line spotlight__shimmer-line--short" />
            </span>
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

  const rows = createMemo(() => spotlightResults().slice(0, MAX_ROWS))

  // Group headers are purely visual: order and indices stay identical to `rows()`,
  // so keyboard navigation and Enter still resolve to the same result.
  const entries = createMemo(() => {
    let prev = ''
    return rows().map((result, index) => {
      const header = result.kind !== prev ? (KIND_LABEL[result.kind] ?? 'Results') : null
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
    const el = listRef?.querySelector<HTMLElement>(`[data-index="${index}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }

  const move = (delta: number) => {
    const len = rows().length
    if (!len) return
    const next = (active() + delta + len) % len
    setActive(next)
    scrollActiveIntoView(next)
  }

  const choose = (result: SearchResult | undefined) => {
    if (result) runResult(result)
  }

  const clearQuery = () => {
    setSpotlightQuery('')
    inputRef?.focus()
  }

  onMount(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    inputRef?.focus()

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const targets = Array.from(panelRef?.querySelectorAll<HTMLElement>('input,button:not(:disabled),[tabindex="0"]') ?? [])
        const current = targets.indexOf(document.activeElement as HTMLElement)
        const next = (current + (event.shiftKey ? -1 : 1) + targets.length) % targets.length
        if (targets[next]) { event.preventDefault(); targets[next].focus() }
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
          event.preventDefault()
          choose(rows()[active()])
          break
        case 'Escape':
          event.preventDefault()
          event.stopPropagation()
          closeSpotlight()
          break
      }
    }
    window.addEventListener('keydown', onKey, true)
    onCleanup(() => { window.removeEventListener('keydown', onKey, true); previousFocus?.focus() })
  })

  return (
    <div class="spotlight" role="dialog" aria-modal="true" aria-label="Spotlight search">
      <div class="spotlight__panel" ref={panelRef}>
        <div class="spotlight__search">
          <span class="spotlight__glass">
            <Search
              class="icon icon--xl"
              strokeWidth={1.75}
              color="currentColor"
              aria-hidden="true"
            />
          </span>
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
            <button
              type="button"
              class="spotlight__clear"
              onClick={clearQuery}
              aria-label="Clear search"
            >
              <X class="spotlight__clear-icon" strokeWidth={1.75} color="currentColor" aria-hidden="true" />
            </button>
          </Show>
        </div>

        <div id="spotlight-results" class="spotlight__results" role="listbox" aria-label="Search results" ref={listRef} aria-busy={spotlightLoading()}>
          <Show when={!spotlightLoading()} fallback={<Shimmer />}>
            <Show
              when={entries().length > 0}
              fallback={
                <div
                  class="spotlight__empty"
                  classList={{ 'inline-error': Boolean(spotlightError()) }}
                  role={spotlightError() ? 'status' : undefined}
                >
                  <span class="spotlight__empty-title">
                    {spotlightError() ? 'Search unavailable' : 'No results'}
                  </span>
                  <span class="spotlight__empty-hint">
                    {spotlightError() ?? 'Try a different name or keyword.'}
                  </span>
                </div>
              }
            >
              <For each={entries()}>
                {(entry) => (
                  <>
                    <Show when={entry.header}>
                      {(label) => <div class="spotlight__group">{label()}</div>}
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
                      <span class="spotlight__icon">
                        <KindIcon kind={entry.result.kind} />
                      </span>
                      <span class="spotlight__meta">
                        <span class="spotlight__title">
                          <For each={highlight(entry.result.title, spotlightQuery())}>
                            {(part) => (
                              <span classList={{ 'spotlight__match': part.match }}>{part.text}</span>
                            )}
                          </For>
                        </span>
                        <Show when={entry.result.subtitle}>
                          {(subtitle) => <span class="spotlight__subtitle">{subtitle()}</span>}
                        </Show>
                      </span>
                      <span class="spotlight__hint">{actionHint(entry.result)}</span>
                    </button>
                  </>
                )}
              </For>
            </Show>
          </Show>
        </div>

        <Show when={spotlightError() && entries().length > 0}><p class="inline-error" role="alert" style={{ padding: '0 20px' }}>{spotlightError()}</p></Show>

        <div class="spotlight__footer">
          <span class="spotlight__key">
            <kbd>
              <ArrowUp class="kbd-icon" strokeWidth={2} color="currentColor" aria-hidden="true" />
            </kbd>
            <kbd>
              <ArrowDown class="kbd-icon" strokeWidth={2} color="currentColor" aria-hidden="true" />
            </kbd>
          </span>
          <span>navigate</span>
          <span class="spotlight__dot">·</span>
          <span class="spotlight__key">
            <kbd>
              <CornerDownLeft
                class="kbd-icon"
                strokeWidth={2}
                color="currentColor"
                aria-hidden="true"
              />
            </kbd>
          </span>
          <span>open</span>
          <span class="spotlight__dot">·</span>
          <span class="spotlight__key">
            <kbd>esc</kbd>
          </span>
          <span>close</span>
        </div>
      </div>
    </div>
  )
}
