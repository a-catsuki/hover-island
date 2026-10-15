type SaveCallback = (error?: unknown) => void

export interface TodoItem {
  id: string
  title: string
  completed: boolean
  createdAt: number
}

/** Current storage marker. Everything after it is versioned JSON. */
export const TODO_PREFIX = 'hover-island.todo:'
/** Format used before the versioned envelope; payload is a bare JSON array. */
const LEGACY_TODO_PREFIX = 'hover-island.todo.v1:'
export const TODO_FORMAT_VERSION = 1
const TITLE_MAX = 180

interface TodoEnvelope {
  v: number
  items: TodoItem[]
}

export interface NotesParseResult {
  items: TodoItem[]
  /** True when the stored text was a legacy scratchpad/format and was upgraded. */
  migrated: boolean
  /** 1 = versioned envelope, 0 = plain text or an unreadable payload. */
  version: number
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function clampTitle(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, TITLE_MAX) : ''
}

function coerceItem(raw: unknown, index: number): TodoItem | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const candidate = raw as Partial<Record<keyof TodoItem, unknown>>
  const title = clampTitle(candidate.title)
  if (!title.trim()) return undefined
  const id = typeof candidate.id === 'string' && candidate.id ? candidate.id : `item-${index}-${title.slice(0, 16)}`
  const createdAt = Number.isFinite(candidate.createdAt) ? Number(candidate.createdAt) : 0
  return { id, title, completed: candidate.completed === true, createdAt }
}

/** Drop anything that is not a well-formed todo, tolerating partial fields. */
export function sanitizeTodoItems(input: unknown): TodoItem[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((entry, index) => {
    const item = coerceItem(entry, index)
    return item ? [item] : []
  })
}

function envelopeItems(parsed: unknown): TodoItem[] | undefined {
  if (Array.isArray(parsed)) return sanitizeTodoItems(parsed)
  if (parsed && typeof parsed === 'object') {
    const items = (parsed as { items?: unknown }).items
    if (Array.isArray(items)) return sanitizeTodoItems(items)
  }
  return undefined
}

function importedId(title: string, index: number): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
  return `imported-${index}-${slug || 'note'}`
}

/** Turn a plain-text scratchpad into checklist items without dropping any line. */
export function migrateScratchpad(value: string): TodoItem[] {
  const lines = value.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean)
  return lines.map((title, index) => ({
    id: importedId(title, index),
    title: title.slice(0, TITLE_MAX),
    completed: false,
    createdAt: 0,
  }))
}

/** Parse the stored text blob, reporting whether an in-place upgrade is needed. */
export function parseNotes(value: string | null | undefined): NotesParseResult {
  const text = typeof value === 'string' ? value : ''

  if (text.startsWith(TODO_PREFIX)) {
    const items = envelopeItems(safeParseJson(text.slice(TODO_PREFIX.length)))
    if (items) return { items, migrated: false, version: TODO_FORMAT_VERSION }
    // Corrupt versioned payload: salvage it as plain text rather than losing it.
    return { items: migrateScratchpad(text), migrated: true, version: 0 }
  }

  if (text.startsWith(LEGACY_TODO_PREFIX)) {
    const items = sanitizeTodoItems(safeParseJson(text.slice(LEGACY_TODO_PREFIX.length)))
    return { items, migrated: items.length > 0, version: 1 }
  }

  const items = migrateScratchpad(text)
  return { items, migrated: items.length > 0, version: 0 }
}

export function decodeTodoList(value: string): TodoItem[] {
  return parseNotes(value).items
}

export function encodeTodoList(items: TodoItem[]): string {
  const envelope: TodoEnvelope = { v: TODO_FORMAT_VERSION, items: sanitizeTodoItems(items) }
  return TODO_PREFIX + JSON.stringify(envelope)
}

export interface NotesWriter {
  schedule(value: string, onSettled?: SaveCallback): void
  flush(): Promise<void>
  dispose(): Promise<void>
}

const writers = new Set<NotesWriter>()
const outstanding = new Set<Promise<void>>()

function track<T extends Promise<void>>(promise: T): T {
  outstanding.add(promise)
  void promise.then(
    () => outstanding.delete(promise),
    () => outstanding.delete(promise),
  )
  return promise
}

export function createNotesWriter(save: (value: string) => Promise<void>, delayMs = 500): NotesWriter {
  let timer: ReturnType<typeof setTimeout> | undefined
  let latestValue = ''
  let latestCallback: SaveCallback | undefined
  let revision = 0
  let dirty = false
  let chain: Promise<void> = Promise.resolve()
  const pending = new Set<Promise<void>>()

  const enqueue = (value: string, request: number, callback?: SaveCallback) => {
    let operation: Promise<void>
    operation = chain
      .catch(() => undefined)
      .then(() => save(value))
      .then(() => {
        if (request === revision) {
          dirty = false
          callback?.()
        }
      }, (error: unknown) => {
        if (request === revision) callback?.(error)
        throw error
      })
    pending.add(operation)
    track(operation)
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    )
    chain = operation.catch(() => undefined)
    return operation
  }

  const writer: NotesWriter = {
    schedule(value, onSettled) {
      latestValue = value
      latestCallback = onSettled
      dirty = true
      const request = ++revision
      clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        void enqueue(latestValue, request, latestCallback).catch(() => undefined)
      }, delayMs)
    },
    async flush() {
      while (true) {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        if (dirty) {
          const request = revision
          const operation = enqueue(latestValue, request, latestCallback)
          dirty = false
          try {
            await operation
          } catch (error) {
            if (request === revision) dirty = true
            throw error
          }
        }
        await Promise.all([...pending])
        if (!dirty && timer === undefined && pending.size === 0) return
      }
    },
    async dispose() {
      try {
        await writer.flush()
        writers.delete(writer)
      } catch (error) {
        // Keep failed writers registered so a later app-level flush can retry.
        throw error
      }
    },
  }

  writers.add(writer)
  return writer
}

export async function flushNotesWriters(): Promise<void> {
  const failures: unknown[] = []
  const results = await Promise.allSettled([...writers].map((writer) => writer.flush()))
  for (const result of results) if (result.status === 'rejected') failures.push(result.reason)

  // A disposed editor can have an IPC write in flight after its component is gone.
  while (outstanding.size > 0) {
    const writes = await Promise.allSettled([...outstanding])
    for (const result of writes) if (result.status === 'rejected') failures.push(result.reason)
  }

  if (failures.length) throw failures[0]
}

export function installNotesPagehideFlush(): () => void {
  if (typeof window === 'undefined') return () => undefined
  const flush = () => { void flushNotesWriters().catch(() => undefined) }
  window.addEventListener('pagehide', flush)
  return () => window.removeEventListener('pagehide', flush)
}
