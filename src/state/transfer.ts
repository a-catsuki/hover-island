import { createSignal } from 'solid-js'
import { browserPreview, cmd, type TransferStatus } from '../lib/ipc'

const EMPTY: TransferStatus = {
  active: false,
  phoneUrl: null,
  desktopUrl: null,
  qrDataUrl: null,
  expiresAt: null,
  files: [],
  saveFolder: '',
  maxFileBytes: 100 * 1024 * 1024,
  maxBucketBytes: 500 * 1024 * 1024,
  error: null,
}

export interface TransferUploadProgress {
  id: string
  name: string
  loaded: number
  total: number
  error?: string
  /** Object URL preview for locally staged images; UI only, revoked by this module. */
  previewUrl?: string
}

function makeUploadPreview(file: File): string | undefined {
  try {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return undefined
    const type = typeof file.type === 'string' ? file.type : ''
    if (!type.startsWith('image/')) return undefined
    return URL.createObjectURL(file)
  } catch {
    return undefined
  }
}

function releaseUploadPreview(item: TransferUploadProgress | undefined): void {
  if (!item?.previewUrl) return
  try {
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(item.previewUrl)
    }
  } catch {
    /* previews are best-effort */
  }
}

const [transfer, setTransfer] = createSignal<TransferStatus>(EMPTY)
const [uploads, setUploads] = createSignal<TransferUploadProgress[]>([])
let uploadQueue: Promise<void> = Promise.resolve()
let lifecycleQueue: Promise<void> = Promise.resolve()
let sessionRevision = 0
let refreshRevision = 0
let uploadGeneration = 0
let currentXhr: XMLHttpRequest | null = null
let startOperation: { revision: number; promise: Promise<string | null> } | null = null

function enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const task = lifecycleQueue.then(operation, operation)
  lifecycleQueue = task.then(() => undefined, () => undefined)
  return task
}

export async function refreshTransfer(): Promise<void> {
  const revision = sessionRevision
  const request = ++refreshRevision
  if (browserPreview) {
    if (revision === sessionRevision && request === refreshRevision) setTransfer(EMPTY)
    return
  }
  try {
    const snapshot = await cmd.transferStatus()
    if (revision === sessionRevision && request === refreshRevision) {
      setTransfer((current) => ({ ...snapshot, error: current.error ?? snapshot.error ?? null }))
    }
  } catch (error) {
    if (revision === sessionRevision && request === refreshRevision) {
      setTransfer((current) => ({ ...current, error: String(error) }))
    }
  }
}

export function startTransfer(): Promise<string | null> {
  if (browserPreview) return Promise.resolve('Phone bucket is available in the desktop app.')
  if (startOperation?.revision === sessionRevision) return startOperation.promise

  const revision = ++sessionRevision
  const promise = enqueueLifecycle(async () => {
    if (revision !== sessionRevision) return 'Session start was cancelled.'
    try {
      const snapshot = await cmd.transferStart()
      if (revision === sessionRevision) setTransfer({ ...snapshot, error: null })
      return null
    } catch (error) {
      const message = String(error)
      if (revision === sessionRevision) {
        setTransfer((current) => ({ ...current, error: message }))
      }
      return message
    }
  })
  startOperation = { revision, promise }
  void promise.then(() => {
    if (startOperation?.promise === promise) startOperation = null
  })
  return promise
}

export function stopTransfer(): Promise<string | null> {
  if (browserPreview) return Promise.resolve(null)
  const revision = ++sessionRevision
  uploadGeneration += 1
  const xhr = currentXhr
  currentXhr = null
  xhr?.abort()
  setUploads((items) => {
    for (const item of items) releaseUploadPreview(item)
    return []
  })

  return enqueueLifecycle(async () => {
    try {
      await cmd.transferStop()
      if (revision === sessionRevision) setTransfer({ ...EMPTY })
      return null
    } catch (error) {
      const message = String(error)
      if (revision === sessionRevision) {
        setTransfer((current) => ({ ...current, error: message }))
      }
      return message
    }
  })
}

/** Uploads browser File bytes directly to the authenticated local server. */
export function transferUpload(file: File, onProgress?: (fraction: number) => void): Promise<void> {
  const generation = uploadGeneration
  const task = uploadQueue.then(() => {
    if (generation !== uploadGeneration) throw new Error('Upload cancelled because the phone bucket was stopped.')
    return transferUploadNow(file, onProgress, generation)
  })
  uploadQueue = task.catch(() => {})
  return task
}

async function transferUploadNow(file: File, onProgress: ((fraction: number) => void) | undefined, generation: number): Promise<void> {
  if (browserPreview) {
    throw new Error('Phone bucket uploads are available in the desktop app.')
  }
  if (file.size > transfer().maxFileBytes) {
    throw new Error(`This file exceeds the ${Math.round(transfer().maxFileBytes / (1024 * 1024))} MB per-file limit.`)
  }
  if (!transfer().active) {
    const error = await startTransfer()
    if (error) throw new Error(error)
  }
  if (generation !== uploadGeneration) {
    throw new Error('Upload cancelled because the phone bucket was stopped.')
  }
  const current = transfer()
  if (!current.active || !current.desktopUrl) {
    throw new Error('The phone bucket could not start. Try again from the Nearby panel.')
  }
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const progress: TransferUploadProgress = { id, name: file.name, loaded: 0, total: file.size, previewUrl: makeUploadPreview(file) }
  setUploads((items) => {
    const next = [...items, progress]
    for (const dropped of next.slice(0, Math.max(0, next.length - 5))) releaseUploadPreview(dropped)
    return next.slice(-5)
  })
  let requestXhr: XMLHttpRequest | null = null
  try {
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      requestXhr = xhr
      currentXhr = xhr
      xhr.open('PUT', `${current.desktopUrl}/api/files?name=${encodeURIComponent(file.name)}`)
      xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      xhr.timeout = 10 * 60 * 1000
      xhr.upload.onprogress = (event) => {
        const loaded = event.lengthComputable ? event.loaded : Math.min(file.size, event.loaded)
        const total = event.lengthComputable ? event.total : file.size
        setUploads((items) => items.map((item) => item.id === id ? { ...item, loaded, total } : item))
        onProgress?.(total > 0 ? loaded / total : 1)
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve()
        else {
          let message = `Upload failed (${xhr.status})`
          try { message = JSON.parse(xhr.responseText)?.error || message } catch { /* use status */ }
          reject(new Error(message))
        }
      }
      xhr.onerror = () => reject(new Error('Could not connect to the local phone bucket.'))
      xhr.ontimeout = () => reject(new Error('Upload timed out.'))
      xhr.onabort = () => reject(new Error('Upload was cancelled.'))
      xhr.send(file)
    })
    if (generation !== uploadGeneration) {
      throw new Error('Upload cancelled because the phone bucket was stopped.')
    }
    onProgress?.(1)
    await refreshTransfer()
    setUploads((items) => {
      releaseUploadPreview(items.find((item) => item.id === id))
      return items.filter((item) => item.id !== id)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setUploads((items) => items.map((item) => item.id === id ? { ...item, error: message } : item))
    throw error
  } finally {
    if (currentXhr === requestXhr) currentXhr = null
  }
}

export { transfer, uploads }
