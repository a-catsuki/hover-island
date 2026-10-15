const MAX_ARCHIVE_ENTRIES = 500
const MAX_ARCHIVE_SOURCE_BYTES = 95 * 1024 * 1024
const MAX_BUCKET_ITEMS = 50
const MAX_PATH_BYTES = 4_096
const MAX_DEPTH = 32

interface WebkitEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
  file?: (success: (file: File) => void, failure?: (error: DOMException) => void) => void
  createReader?: () => { readEntries: (success: (entries: WebkitEntry[]) => void, failure?: (error: DOMException) => void) => void }
}

interface ArchiveItem { path: string; file: File }
interface DirectoryWalk { items: ArchiveItem[] }
interface WalkBudget { entries: number; bytes: number }

function safePath(path: string): string {
  if (!path || path.startsWith('/') || path.startsWith('\\') || path.includes('\\') || path.includes('\0')) {
    throw new Error('A folder entry has an unsafe relative path.')
  }
  const segments = path.split('/')
  if (segments.some((part) => !part || part === '.' || part === '..' || part.includes(':') || /[\u0000-\u001f]/.test(part))) {
    throw new Error('A folder entry has an unsafe relative path.')
  }
  const normalized = segments.join('/')
  if (new TextEncoder().encode(normalized).length > MAX_PATH_BYTES) throw new Error('A folder path is too long to archive.')
  return normalized
}

function entryFile(entry: WebkitEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    if (!entry.file) return reject(new Error('This browser could not read a dropped file.'))
    entry.file(resolve, reject)
  })
}

function directoryEntries(entry: WebkitEntry): Promise<WebkitEntry[]> {
  return new Promise((resolve, reject) => {
    if (!entry.createReader) return reject(new Error('This browser could not read a dropped folder.'))
    const reader = entry.createReader()
    const all: WebkitEntry[] = []
    const read = () => reader.readEntries((batch) => {
      if (!batch.length) return resolve(all)
      all.push(...batch)
      if (all.length > MAX_ARCHIVE_ENTRIES) return reject(new Error('A folder can contain at most 500 files.'))
      read()
    }, reject)
    read()
  })
}

async function collectDirectory(entry: WebkitEntry, walk: DirectoryWalk, budget: WalkBudget, prefix = '', depth = 0): Promise<void> {
  if (depth > MAX_DEPTH) throw new Error('This folder is nested too deeply to archive.')
  const path = safePath(prefix ? `${prefix}/${entry.name}` : entry.name)
  if (entry.isFile) {
    if (budget.entries >= MAX_ARCHIVE_ENTRIES) throw new Error('A folder drop can contain at most 500 files.')
    const file = await entryFile(entry)
    budget.bytes += file.size
    if (budget.bytes > MAX_ARCHIVE_SOURCE_BYTES) throw new Error('Folder drops are limited to 95 MB total.')
    budget.entries++
    walk.items.push({ path, file })
    return
  }
  if (!entry.isDirectory) return
  const children = await directoryEntries(entry)
  // Walk sequentially so a malicious or unusually large folder cannot fan out
  // into thousands of concurrent reads before the archive limits are checked.
  for (const child of children) await collectDirectory(child, walk, budget, path, depth + 1)
}

function crc32Update(crc: number, bytes: Uint8Array): number {
  let value = crc >>> 0
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  }
  return value >>> 0
}

async function crc32File(file: File): Promise<number> {
  let crc = 0xffffffff
  const reader = file.stream().getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      crc = crc32Update(crc, value)
    }
  } finally {
    reader.releaseLock()
  }
  return (~crc) >>> 0
}

function u16(view: DataView, offset: number, value: number): void { view.setUint16(offset, value, true) }
function u32(view: DataView, offset: number, value: number): void { view.setUint32(offset, value >>> 0, true) }

async function storedZip(name: string, items: ArchiveItem[]): Promise<File> {
  if (!items.length) throw new Error('That folder is empty.')
  if (items.length > MAX_ARCHIVE_ENTRIES) throw new Error('A folder can contain at most 500 files.')
  const total = items.reduce((sum, item) => sum + item.file.size, 0)
  if (total > MAX_ARCHIVE_SOURCE_BYTES) throw new Error('A folder archive is limited to 95 MB.')
  const encoder = new TextEncoder()
  const parts: BlobPart[] = []
  const central: BlobPart[] = []
  let offset = 0
  const seen = new Set<string>()

  for (const item of items) {
    const path = safePath(item.path)
    if (seen.has(path)) throw new Error(`Folder contains a duplicate path: ${path}`)
    seen.add(path)
    if (item.file.size > 0xffffffff) throw new Error('An entry is too large for a folder archive.')
    const encoded = encoder.encode(path)
    const crc = await crc32File(item.file)

    const local = new Uint8Array(30 + encoded.length)
    const localView = new DataView(local.buffer)
    u32(localView, 0, 0x04034b50); u16(localView, 4, 20); u16(localView, 6, 0x0808)
    u16(localView, 8, 0); u16(localView, 10, 0); u16(localView, 12, 0)
    u32(localView, 14, 0); u32(localView, 18, 0); u32(localView, 22, 0)
    u16(localView, 26, encoded.length); u16(localView, 28, 0); local.set(encoded, 30)
    parts.push(local, item.file)
    const descriptor = new Uint8Array(16)
    const descriptorView = new DataView(descriptor.buffer)
    u32(descriptorView, 0, 0x08074b50); u32(descriptorView, 4, crc)
    u32(descriptorView, 8, item.file.size); u32(descriptorView, 12, item.file.size)
    parts.push(descriptor)

    const record = new Uint8Array(46 + encoded.length)
    const recordView = new DataView(record.buffer)
    u32(recordView, 0, 0x02014b50); u16(recordView, 4, 20); u16(recordView, 6, 20)
    u16(recordView, 8, 0x0808); u16(recordView, 10, 0); u16(recordView, 12, 0); u16(recordView, 14, 0)
    u32(recordView, 16, crc); u32(recordView, 20, item.file.size); u32(recordView, 24, item.file.size)
    u16(recordView, 28, encoded.length); u16(recordView, 30, 0); u16(recordView, 32, 0)
    u16(recordView, 34, 0); u16(recordView, 36, 0); u32(recordView, 38, 0); u32(recordView, 42, offset)
    record.set(encoded, 46); central.push(record)
    offset += local.length + item.file.size + descriptor.length
  }

  const centralOffset = offset
  const centralSize = central.reduce((sum, part) => sum + (part instanceof Uint8Array ? part.length : 0), 0)
  parts.push(...central)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  u32(endView, 0, 0x06054b50); u16(endView, 4, 0); u16(endView, 6, 0)
  u16(endView, 8, items.length); u16(endView, 10, items.length)
  u32(endView, 12, centralSize); u32(endView, 16, centralOffset); u16(endView, 20, 0)
  parts.push(end)
  const archiveName = `${name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || 'Folder'}.zip`
  return new File(parts, archiveName, { type: 'application/zip' })
}

function uniqueName(base: string, used: Set<string>): string {
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || 'Folder'
  let name = cleaned
  let index = 2
  while (used.has(name.toLowerCase())) name = `${cleaned} (${index++})`
  used.add(name.toLowerCase())
  return name
}

async function archiveDirectories(groups: Map<string, ArchiveItem[]>): Promise<File[]> {
  const count = [...groups.values()].reduce((sum, files) => sum + files.length, 0)
  const bytes = [...groups.values()].flat().reduce((sum, item) => sum + item.file.size, 0)
  if (count > MAX_ARCHIVE_ENTRIES) throw new Error('A folder drop can contain at most 500 files.')
  if (bytes > MAX_ARCHIVE_SOURCE_BYTES) throw new Error('Folder drops are limited to 95 MB total.')
  const used = new Set<string>()
  const archives: File[] = []
  for (const [folder, items] of groups) {
    const name = uniqueName(folder, used)
    const rooted = items.map((item) => ({ ...item, path: item.path.slice(folder.length + 1) }))
    archives.push(await storedZip(name, rooted))
  }
  return archives
}

/** Returns loose files and one path-preserving ZIP per dropped folder. */
export async function filesFromDrop(data: DataTransfer): Promise<File[]> {
  const items = Array.from(data.items ?? [])
  const loose: File[] = []
  const folders = new Map<string, ArchiveItem[]>()
  const budget: WalkBudget = { entries: 0, bytes: 0 }
  let sawEntries = false
  for (const item of items) {
    const entry = (item as unknown as { webkitGetAsEntry?: () => WebkitEntry | null }).webkitGetAsEntry?.()
    if (!entry) continue
    sawEntries = true
    if (entry.isDirectory) {
      const walk: DirectoryWalk = { items: [] }
      await collectDirectory(entry, walk, budget)
      if (walk.items.length) folders.set(entry.name, [...(folders.get(entry.name) ?? []), ...walk.items])
    } else if (entry.isFile) {
      loose.push(await entryFile(entry))
    }
  }
  if (!sawEntries) loose.push(...Array.from(data.files ?? []))
  const archives = await archiveDirectories(folders)
  const result = [...loose, ...archives]
  if (!result.length) throw new Error('No readable files were found in that drop.')
  if (result.length > MAX_BUCKET_ITEMS) throw new Error('A phone bucket session can hold at most 50 uploaded items.')
  return result
}

/** Turns a webkitdirectory picker result into ZIPs while leaving picked files loose. */
export async function filesFromPicker(files: FileList | File[]): Promise<File[]> {
  const loose: File[] = []
  const folders = new Map<string, ArchiveItem[]>()
  for (const file of Array.from(files)) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath
    if (!relative) { loose.push(file); continue }
    const path = safePath(relative)
    const slash = path.indexOf('/')
    if (slash < 0) { loose.push(file); continue }
    const root = path.slice(0, slash)
    const entry = { path, file }
    const group = folders.get(root) ?? []
    group.push(entry)
    folders.set(root, group)
  }
  const result = [...loose, ...await archiveDirectories(folders)]
  if (result.length > MAX_BUCKET_ITEMS) throw new Error('A phone bucket session can hold at most 50 uploaded items.')
  return result
}
