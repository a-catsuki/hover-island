import { cmd, type InstalledApp } from './ipc'

/**
 * Shared logo pipeline for app lists. Installed apps are read once, logos are
 * fetched lazily (a few at a time) through `cmd.appsIcon` when the native side
 * provides it, and every result is cached in memory for the life of the window.
 */
type IconCommand = (id: string, size: number) => Promise<string | null | undefined>
const iconCommand = (): IconCommand | undefined => (cmd as unknown as { appsIcon?: IconCommand }).appsIcon

let installedPromise: Promise<InstalledApp[]> | null = null
let byName: Map<string, InstalledApp> | null = null
let installedList: InstalledApp[] = []
const icons = new Map<string, Promise<string | null>>()
const queue: (() => void)[] = []
let running = 0
const LIMIT = 4

export function loadInstalledApps(force = false): Promise<InstalledApp[]> {
  if (!installedPromise || force) {
    installedPromise = cmd.appsList().then(list => {
      installedList = list
      byName = new Map()
      for (const app of list) if (!byName.has(app.name.trim().toLowerCase())) byName.set(app.name.trim().toLowerCase(), app)
      return list
    }).catch(error => { installedPromise = null; throw error })
  }
  return installedPromise
}

/** Installed app with this display name, once the list has loaded. */
export function installedByName(name: string): InstalledApp | undefined {
  return byName?.get(name.trim().toLowerCase())
}

const NOISE = new Set(['microsoft', 'windows', 'desktop', 'app', 'new', 'the', 'for', 'workplace', 'meetings', 'classic'])
/** Name reduced to its distinctive words, so "Zoom Workplace" and "Zoom", or "Terminal" and "Windows Terminal", compare equal. */
export function canonicalAppName(name: string): string {
  const words = name.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean)
  const kept = words.filter(word => !NOISE.has(word))
  return (kept.length ? kept : words).join(' ')
}

/**
 * The installed app that best matches any of these names: an exact name first, then the
 * same distinctive words, then a name that starts with (or contains) them. Shortest wins ties.
 */
export function findInstalled(names: readonly string[]): InstalledApp | undefined {
  const wanted = names.map(name => name.trim()).filter(Boolean)
  if (!wanted.length || !installedList.length) return undefined
  for (const name of wanted) { const exact = byName?.get(name.toLowerCase()); if (exact) return exact }
  const apps = installedList.filter(app => app.kind !== 'url')
  const shortest = (list: InstalledApp[]) => list.sort((a, b) => a.name.length - b.name.length)[0]
  const keys = wanted.map(canonicalAppName).filter(key => key.length >= 3)
  for (const key of keys) { const hit = shortest(apps.filter(app => canonicalAppName(app.name) === key)); if (hit) return hit }
  for (const key of keys) { const hit = shortest(apps.filter(app => (canonicalAppName(app.name) + ' ').startsWith(key + ' '))); if (hit) return hit }
  for (const key of keys) { const hit = shortest(apps.filter(app => (' ' + canonicalAppName(app.name) + ' ').includes(' ' + key + ' '))); if (hit) return hit }
  return undefined
}

function pump() {
  while (running < LIMIT && queue.length) { running++; queue.shift()!() }
}

/** Logo as a data URL, or null when the app has none. Never rejects. */
export function loadAppIcon(app: Pick<InstalledApp, 'id' | 'icon'>, size = 64): Promise<string | null> {
  if (app.icon && app.icon.length > 32) return Promise.resolve(app.icon)
  const command = iconCommand()
  if (!command) return Promise.resolve(null)
  const key = `${app.id}:${size}`
  let pending = icons.get(key)
  if (!pending) {
    pending = new Promise<string | null>(resolve => {
      queue.push(() => {
        command(app.id, size).then(value => resolve(value && value.length > 32 ? value : null), () => resolve(null)).finally(() => { running--; pump() })
      })
      pump()
    })
    icons.set(key, pending)
  }
  return pending
}

/** Test and refresh hook: forget cached logos. */
export function clearAppIconCache() { icons.clear() }
