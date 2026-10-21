import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import { RotateCcw } from 'lucide-solid'
import { DEFAULT_SETTINGS, type Settings } from '../lib/ipc'
import { FIXED_SHORTCUTS, checkShortcut, formatShortcut, sameShortcut, shortcutFromEvent, shortcutParts, type ShortcutOther } from '../lib/shortcuts'
import { applySettings, settings } from '../state/settings'
import { Group } from './controls'
import './ShortcutsPanel.css'

type ShortcutKey = 'hotkey' | 'spotlightHotkey'
interface ActionDef { id: string; key: ShortcutKey; label: string; hint: string }

/** Every shortcut the user can change. A new global shortcut only needs a row here and a settings field. */
const ACTIONS: readonly ActionDef[] = [
  { id: 'island', key: 'hotkey', label: 'Open the island', hint: 'Open or close the island from any app' },
  { id: 'search', key: 'spotlightHotkey', label: 'Search', hint: 'Open search from any app' },
]

const defaultOf = (action: ActionDef) => DEFAULT_SETTINGS[action.key]
const valueOf = (action: ActionDef) => settings[action.key]

function Keycaps(props: { parts: string[]; ghost?: boolean }) {
  return <span class="keycaps" classList={{ 'keycaps--ghost': props.ghost }}><For each={props.parts}>{part => <kbd class="keycap" classList={{ 'keycap--wide': part.length > 1 }}>{part}</kbd>}</For></span>
}

/** Rows of configurable global shortcuts. Click a chip, press the new keys, done. */
export default function ShortcutsPanel() {
  const [recordingId, setRecordingId] = createSignal<string | null>(null)
  const [live, setLive] = createSignal('')
  const [errors, setErrors] = createSignal<Record<string, string>>({})
  const [busy, setBusy] = createSignal<string | null>(null)
  const chips = new Map<string, HTMLButtonElement>()
  let flashTimer: ReturnType<typeof setTimeout> | undefined

  const setError = (id: string, message: string) => setErrors(previous => ({ ...previous, [id]: message }))
  const clearError = (id: string) => setErrors(previous => { const next = { ...previous }; delete next[id]; return next })
  const othersOf = (id: string): ShortcutOther[] => ACTIONS.filter(action => action.id !== id).map(action => ({ id: action.id, label: action.label, combo: valueOf(action) }))

  const apply = async (patch: Partial<Settings>, ids: string[], key: string) => {
    setBusy(key)
    ids.forEach(clearError)
    try {
      await applySettings(patch)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      for (const id of ids) setError(id, message.replace(/^Error:\s*/, '') || 'Windows would not register that combination. Pick another.')
    } finally {
      setBusy(null)
    }
  }

  const stop = (focusId?: string) => {
    clearTimeout(flashTimer)
    const leaving = recordingId()
    if (leaving) clearError(leaving)
    setRecordingId(null)
    setLive('')
    if (focusId) queueMicrotask(() => chips.get(focusId)?.focus())
  }
  const start = (id: string) => {
    if (busy()) return
    clearError(id)
    setLive('')
    setRecordingId(id)
  }

  const commit = (action: ActionDef, combo: string) => {
    stop(action.id)
    if (sameShortcut(combo, valueOf(action))) return
    void apply({ [action.key]: combo } as Partial<Settings>, [action.id], action.id)
  }
  const resetOne = (action: ActionDef) => {
    const check = checkShortcut(defaultOf(action), othersOf(action.id))
    stop()
    if (!check.ok) { setError(action.id, `The default, ${formatShortcut(defaultOf(action))}, is taken: ${check.message}`); return }
    void apply({ [action.key]: defaultOf(action) } as Partial<Settings>, [action.id], action.id)
  }
  const resetAll = () => {
    stop()
    const patch: Record<string, string> = {}
    for (const action of ACTIONS) patch[action.key] = defaultOf(action)
    void apply(patch as Partial<Settings>, ACTIONS.map(action => action.id), 'all')
  }
  const changed = (action: ActionDef) => !sameShortcut(valueOf(action), defaultOf(action))
  const anyChanged = () => ACTIONS.some(changed)

  // While a chip is recording, take every key press so nothing else reacts to it.
  createEffect(() => {
    const id = recordingId()
    if (!id) return
    const action = ACTIONS.find(item => item.id === id)!
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      const modifiers = event.ctrlKey || event.altKey || event.shiftKey || event.metaKey
      if (event.key === 'Escape' && !modifiers) { stop(id); return }
      if (event.key === 'Backspace' && !modifiers) { resetOne(action); return }
      const { combo, complete } = shortcutFromEvent(event)
      setLive(combo)
      if (!complete) return
      const check = checkShortcut(combo, othersOf(id))
      if (!check.ok) {
        setError(id, check.message)
        clearTimeout(flashTimer)
        flashTimer = setTimeout(() => setLive(''), 900)
        return
      }
      commit(action, check.combo)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      setLive(shortcutFromEvent(event).combo)
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!chips.get(id)?.contains(event.target as Node)) stop()
    }
    const onBlur = () => stop()
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onBlur)
    onCleanup(() => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onBlur)
    })
  })
  onCleanup(() => clearTimeout(flashTimer))

  return <>
    <Group title="Global shortcuts" description="These work from any app. Use Ctrl, Alt or Win with one other key. Changes apply right away.">
      <For each={ACTIONS}>{action => {
        const recording = () => recordingId() === action.id
        const parts = () => shortcutParts(valueOf(action))
        const preview = () => shortcutParts(live())
        return <div class="skey" data-recording={recording() ? '' : undefined}>
          <div class="set-row">
            <span class="set-row__text">
              <strong>{action.label}</strong>
              <small>{action.hint}</small>
            </span>
            <span class="set-row__control skey__ctl">
              <Show when={changed(action) && !recording()}>
                <button type="button" class="skey__reset" aria-label={`Reset ${action.label} shortcut to ${formatShortcut(defaultOf(action))}`} title={`Reset to ${formatShortcut(defaultOf(action))}`} disabled={!!busy()} onClick={() => resetOne(action)}><RotateCcw size={13} strokeWidth={2} /></button>
              </Show>
              <button
                type="button"
                class="skey__chip"
                classList={{ 'skey__chip--recording': recording(), 'skey__chip--busy': busy() === action.id || busy() === 'all', 'skey__chip--error': !!errors()[action.id] }}
                ref={element => chips.set(action.id, element)}
                aria-label={recording() ? `Recording ${action.label} shortcut. Press the new keys, Escape to cancel, Backspace to reset.` : `${action.label} shortcut, ${formatShortcut(valueOf(action)) || 'not set'}. Click to change.`}
                disabled={!!busy() && !recording()}
                onClick={() => (recording() ? stop(action.id) : start(action.id))}
              >
                <Show when={recording()} fallback={<Keycaps parts={parts()} />}>
                  <Show when={preview().length} fallback={<span class="skey__prompt">Press new keys</span>}>
                    <Keycaps parts={preview()} />
                  </Show>
                </Show>
              </button>
            </span>
          </div>
          <Show when={recording() || errors()[action.id]}>
            <p class="skey__note" classList={{ 'skey__note--error': !!errors()[action.id] }} role={errors()[action.id] ? 'alert' : 'status'}>
              {errors()[action.id] || 'Press the keys you want. Esc cancels, Backspace goes back to the default.'}
            </p>
          </Show>
        </div>
      }}</For>
      <div class="set-row">
        <span class="set-row__text"><strong>Reset all</strong><small>Back to {ACTIONS.map(action => formatShortcut(defaultOf(action))).join(' and ')}</small></span>
        <span class="set-row__control"><button type="button" class="button" disabled={!anyChanged() || !!busy()} onClick={resetAll}>Reset all</button></span>
      </div>
    </Group>

    <Group title="Built in" description="Hover Island handles these itself, so they cannot be changed or reused.">
      <For each={FIXED_SHORTCUTS}>{item => <div class="set-row">
        <span class="set-row__text"><strong>{item.label}</strong><small>{item.hint}</small></span>
        <span class="set-row__control"><Keycaps parts={shortcutParts(item.combo)} ghost /></span>
      </div>}</For>
    </Group>
  </>
}
