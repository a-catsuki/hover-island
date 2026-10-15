import type { CompactItem, Settings } from './ipc'

export const COMPACT_ITEMS: { id: CompactItem; label: string; hint: string }[] = [
  { id: 'media', label: 'Media controls', hint: 'Track and playback buttons' },
  { id: 'clock', label: 'Clock', hint: 'Local time' },
  { id: 'weather', label: 'Weather', hint: 'Local temperature and conditions' },
  { id: 'battery', label: 'Battery', hint: 'Battery level and charging state' },
  { id: 'ai', label: 'AI usage', hint: 'Your lowest remaining quota' },
]

const VALID = new Set<CompactItem>(COMPACT_ITEMS.map(item => item.id))

export function compactItemLimit(size: Settings['sizePreset']): number {
  return size === 'small' ? 2 : size === 'large' ? 4 : 3
}

export function normalizeCompactItems(items: readonly string[] | null | undefined, size: Settings['sizePreset']): CompactItem[] {
  const unique = [...new Set((items ?? []).filter((item): item is CompactItem => VALID.has(item as CompactItem)))]
  return unique.slice(0, compactItemLimit(size))
}

export function toggleCompactItem(items: readonly string[], item: CompactItem, size: Settings['sizePreset']): CompactItem[] {
  const current = normalizeCompactItems(items, size)
  return current.includes(item)
    ? current.filter(value => value !== item)
    : current.length < compactItemLimit(size) ? [...current, item] : current
}
