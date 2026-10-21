import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Bell, Check, ChevronDown, ChevronUp, GripVertical, ListTodo, Loader, Plus, Trash2 } from 'lucide-solid'
import { cmd } from '../../lib/ipc'
import { reminderForNote, toggleNoteReminder } from '../../state/reminders'
import {
  createNotesWriter,
  encodeTodoList,
  flushNotesWriters,
  installNotesPagehideFlush,
  parseNotes,
  type TodoItem,
} from './notesPersistence'
import './NotesView.css'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

const TITLE_MAX = 180

export function flushNotes(): Promise<void> {
  return flushNotesWriters()
}

export default function NotesView() {
  const [items, setItems] = createSignal<TodoItem[]>([])
  const [draft, setDraft] = createSignal('')
  const [state, setState] = createSignal<SaveState>('idle')
  const [loadFailed, setLoadFailed] = createSignal(false)
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [editDraft, setEditDraft] = createSignal('')
  const [dragId, setDragId] = createSignal<string | null>(null)
  const [dragOver, setDragOver] = createSignal<number | null>(null)
  const [dragY, setDragY] = createSignal(0)
  const [settleId, setSettleId] = createSignal<string | null>(null)
  let flashTimer: ReturnType<typeof setTimeout> | undefined
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let dirty = false
  const rowEls = new Map<string, HTMLLIElement>()

  const writer = createNotesWriter((value) => cmd.notesSet(value))
  const removePagehideFlush = installNotesPagehideFlush()

  const activeCount = () => items().filter((item) => !item.completed).length
  const doneCount = () => items().filter((item) => item.completed).length
  const statusLabel = () =>
    state() === 'saving' ? 'Saving' : state() === 'saved' ? 'Saved' : state() === 'error' ? 'Not saved' : ''

  const load = () => {
    flushNotesWriters()
      .then(() => cmd.notesGet())
      .then((notes) => {
        setLoadFailed(false)
        if (dirty) return
        const parsed = parseNotes(notes?.text ?? '')
        setItems(parsed.items)
        // Upgrade an older plain-text scratchpad in place so nothing is re-parsed twice.
        if (parsed.migrated && parsed.items.length > 0) writer.schedule(encodeTodoList(parsed.items))
      })
      .catch(() => { setLoadFailed(true); setState('error') })
  }

  // Reminders can tick a linked task off; pick the change up without reopening the widget.
  const reloadFromReminders = () => load()
  onMount(() => { load(); window.addEventListener('hover-island:notes-changed', reloadFromReminders) })
  onCleanup(() => {
    clearTimeout(flashTimer)
    clearTimeout(settleTimer)
    window.removeEventListener('hover-island:notes-changed', reloadFromReminders)
    removePagehideFlush()
    void writer.dispose().catch(() => undefined)
  })

  const persist = (next: TodoItem[], settle?: string) => {
    dirty = true
    setItems(next)
    setState('saving')
    if (settle) {
      setSettleId(settle)
      clearTimeout(settleTimer)
      settleTimer = setTimeout(() => setSettleId(null), 340)
    }
    writer.schedule(encodeTodoList(next), (error) => {
      if (error) {
        setState('error')
        return
      }
      dirty = false
      setState('saved')
      clearTimeout(flashTimer)
      flashTimer = setTimeout(() => setState('idle'), 1600)
    })
  }

  const revealTask = (id: string) => {
    requestAnimationFrame(() => rowEls.get(id)?.scrollIntoView({ block: 'nearest' }))
  }

  const addItem = (event: SubmitEvent) => {
    event.preventDefault()
    const title = draft().trim()
    if (!title) return
    const id = createTodoId()
    persist([...items(), { id, title: title.slice(0, TITLE_MAX), completed: false, createdAt: Date.now() }])
    setDraft('')
    revealTask(id)
  }

  const toggleItem = (id: string) => {
    persist(items().map((item) => item.id === id ? { ...item, completed: !item.completed } : item))
  }

  const deleteItem = (id: string) => {
    if (editingId() === id) setEditingId(null)
    rowEls.delete(id)
    persist(items().filter((item) => item.id !== id))
  }

  const clearCompleted = () => {
    if (editingId() && items().find((item) => item.id === editingId() && item.completed)) setEditingId(null)
    for (const item of items()) if (item.completed) rowEls.delete(item.id)
    persist(items().filter((item) => !item.completed))
  }

  const moveItem = (from: number, to: number) => {
    const list = items()
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return
    const next = list.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    persist(next, moved.id)
  }

  const startEdit = (item: TodoItem) => {
    setEditingId(item.id)
    setEditDraft(item.title)
  }

  const commitEdit = () => {
    const id = editingId()
    if (!id) return
    setEditingId(null)
    const title = editDraft().trim()
    const current = items().find((item) => item.id === id)
    if (!current) return
    if (!title) {
      rowEls.delete(id)
      persist(items().filter((item) => item.id !== id))
      return
    }
    const nextTitle = title.slice(0, TITLE_MAX)
    if (nextTitle === current.title) return
    persist(items().map((item) => item.id === id ? { ...item, title: nextTitle } : item))
  }

  const onRowKeyDown = (event: KeyboardEvent, item: TodoItem, index: number) => {
    if (event.target !== event.currentTarget) return
    switch (event.key) {
      case ' ':
      case 'Enter':
        event.preventDefault()
        toggleItem(item.id)
        break
      case 'Delete':
      case 'Backspace':
        event.preventDefault()
        deleteItem(item.id)
        break
      case 'ArrowUp':
        event.preventDefault()
        if (event.altKey) moveItem(index, index - 1)
        break
      case 'ArrowDown':
        event.preventDefault()
        if (event.altKey) moveItem(index, index + 1)
        break
      case 'e':
      case 'E':
      case 'F2':
        event.preventDefault()
        startEdit(item)
        break
    }
  }

  let dragState: { id: string; from: number; startY: number; rects: number[] } | null = null

  const beginDrag = (event: PointerEvent, item: TodoItem) => {
    if (event.button !== 0) return
    const list = items()
    const from = list.findIndex((entry) => entry.id === item.id)
    if (from < 0) return
    const handle = event.currentTarget as HTMLButtonElement
    handle.setPointerCapture(event.pointerId)
    const rects = list.map((entry) => {
      const rect = rowEls.get(entry.id)?.getBoundingClientRect()
      return rect ? rect.top + rect.height / 2 : 0
    })
    dragState = { id: item.id, from, startY: event.clientY, rects }
    setDragId(item.id)
    setDragOver(from)
    setDragY(0)
  }

  const onDragMove = (event: PointerEvent) => {
    const moving = dragState
    if (!moving) return
    setDragY(event.clientY - moving.startY)
    let target = moving.from
    let best = Number.POSITIVE_INFINITY
    moving.rects.forEach((mid, index) => {
      const distance = Math.abs(mid - event.clientY)
      if (distance < best) {
        best = distance
        target = index
      }
    })
    setDragOver(target)
  }

  const clearDrag = (event: PointerEvent) => {
    dragState = null
    try {
      (event.currentTarget as HTMLButtonElement).releasePointerCapture(event.pointerId)
    } catch {
      // Pointer already released.
    }
    setDragId(null)
    setDragOver(null)
    setDragY(0)
  }

  const endDrag = (event: PointerEvent) => {
    const moving = dragState
    if (!moving) return
    const target = dragOver() ?? moving.from
    clearDrag(event)
    if (target !== moving.from) moveItem(moving.from, target)
  }

  return (
    <section class="todo" aria-label="Task list">
      <header class="todo__head">
        <span class="todo__title-wrap">
          <span class="todo__glyph" aria-hidden="true"><ListTodo size={14} strokeWidth={2} /></span>
          <span class="todo__heading">Tasks</span>
        </span>
        <span class="todo__status" classList={{ 'todo__status--error': state() === 'error' }} aria-live="polite">
          {state() === 'saving'
            ? <><Loader size={11} class="todo__spin" strokeWidth={2} aria-hidden="true" />{statusLabel()}</>
            : statusLabel()}
        </span>
        {loadFailed() && <button type="button" class="todo__retry" onClick={load}>Retry</button>}
        <span class="todo__count" title={doneCount() > 0 ? `${doneCount()} completed` : undefined}>{activeCount()}</span>
      </header>

      <form class="todo__add" onSubmit={addItem}>
        <button class="todo__add-button" type="submit" aria-label="Add task" title="Add task" disabled={!draft().trim() || loadFailed()}>
          <Plus size={14} strokeWidth={2.4} aria-hidden="true" />
        </button>
        <input
          class="todo__input"
          type="text"
          aria-label="Add a task"
          placeholder="Add a task"
          maxLength={TITLE_MAX}
          value={draft()}
          disabled={loadFailed()}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
      </form>

      <Show
        when={items().length > 0}
        fallback={<div class="todo__empty"><strong>All done</strong><span>Add a task above.</span></div>}
      >
        <ul class="todo__list" aria-label="Tasks">
          <For each={items()}>{(item, index) => {
            onCleanup(() => rowEls.delete(item.id))
            return (
              <li
                class="todo__task"
                classList={{
                  'todo__task--done': item.completed,
                  'todo__task--dragging': dragId() === item.id,
                  'todo__task--drop': dragId() !== null && dragOver() === index() && dragId() !== item.id,
                  'todo__task--settle': settleId() === item.id,
                }}
                tabindex={0}
                role="listitem"
                style={dragId() === item.id ? { transform: `translateY(${dragY()}px)` } : undefined}
                onKeyDown={(event) => onRowKeyDown(event, item, index())}
                ref={(el) => { rowEls.set(item.id, el) }}
              >
                <button
                  type="button"
                  class="todo__drag"
                  tabindex={-1}
                  aria-label={`Reorder ${item.title}`}
                  title="Drag to reorder"
                  onPointerDown={(event) => beginDrag(event, item)}
                  onPointerMove={onDragMove}
                  onPointerUp={endDrag}
                  onPointerCancel={clearDrag}
                >
                  <GripVertical size={13} aria-hidden="true" />
                </button>

                <button
                  type="button"
                  class="todo__check"
                  role="checkbox"
                  aria-checked={item.completed}
                  aria-label={item.completed ? `Reopen ${item.title}` : `Complete ${item.title}`}
                  title={item.completed ? 'Reopen task' : 'Mark complete'}
                  onClick={() => toggleItem(item.id)}
                >
                  <Check size={12} strokeWidth={3} aria-hidden="true" />
                </button>

                <Show
                  when={editingId() === item.id}
                  fallback={(
                    <span
                      class="todo__title"
                      title={item.title}
                      onDblClick={() => startEdit(item)}
                    >
                      {item.title}
                    </span>
                  )}
                >
                  <input
                    class="todo__edit"
                    type="text"
                    aria-label={`Edit ${item.title}`}
                    maxLength={TITLE_MAX}
                    value={editDraft()}
                    onInput={(event) => setEditDraft(event.currentTarget.value)}
                    onBlur={commitEdit}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        commitEdit()
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        setEditingId(null)
                      }
                    }}
                    ref={(el) => queueMicrotask(() => { el.focus(); el.select() })}
                  />
                </Show>

                <div class="todo__actions">
                  <button
                    type="button"
                    class="todo__action"
                    aria-label={`Move ${item.title} up`}
                    title="Move up"
                    disabled={index() === 0}
                    onClick={() => moveItem(index(), index() - 1)}
                  >
                    <ChevronUp size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    class="todo__action"
                    aria-label={`Move ${item.title} down`}
                    title="Move down"
                    disabled={index() === items().length - 1}
                    onClick={() => moveItem(index(), index() + 1)}
                  >
                    <ChevronDown size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    class="todo__action todo__action--bell"
                    classList={{ 'todo__action--on': !!reminderForNote(item.id) }}
                    aria-label={reminderForNote(item.id) ? `Remove reminder for ${item.title}` : `Remind me about ${item.title}`}
                    title={reminderForNote(item.id) ? 'Remove reminder' : 'Remind me'}
                    onClick={() => void toggleNoteReminder(item)}
                  >
                    <Bell size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    class="todo__action todo__action--delete"
                    aria-label={`Delete ${item.title}`}
                    title="Delete task"
                    onClick={() => deleteItem(item.id)}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </div>
              </li>
            )
          }}</For>
        </ul>
      </Show>

      <Show when={doneCount() > 0}>
        <div class="todo__foot">
          <button type="button" class="todo__clear" onClick={clearCompleted}>Clear completed</button>
        </div>
      </Show>
    </section>
  )
}

function createTodoId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}
