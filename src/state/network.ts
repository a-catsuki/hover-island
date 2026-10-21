import { createSignal } from 'solid-js'
import { cmd, listen, type NetworkInfo, type NetworkSpeedProgress, type NetworkSpeedtestResult } from '../lib/ipc'

/**
 * State for the Network widget. It lives outside the component so a speed test keeps running
 * (and its result is kept) while the island is closed.
 */
const HISTORY_KEY = 'hover-island.network.history.v1'
const HOST_KEY = 'hover-island.network.host.v1'
const MAX_HISTORY = 8
const MAX_SERIES = 48
const PING_EVERY_MS = 2500

export interface SpeedRecord { at: number; down: number; up: number; latency: number; jitter: number }
export interface SpeedState {
  running: boolean
  phase: NetworkSpeedProgress['phase'] | 'idle'
  /** live throughput of the current phase */
  mbps: number
  /** 0..1 through the current phase */
  progress: number
  down: number | null
  up: number | null
  latency: number | null
  jitter: number | null
  error: string | null
}

export interface PingStats { min: number; avg: number; max: number; jitter: number; loss: number; last: number | null; count: number }

export const PING_TARGETS = [
  { value: '1.1.1.1', label: 'Cloudflare', detail: '1.1.1.1' },
  { value: '8.8.8.8', label: 'Google', detail: '8.8.8.8' },
  { value: '9.9.9.9', label: 'Quad9', detail: '9.9.9.9' },
] as const

const idle = (): SpeedState => ({ running: false, phase: 'idle', mbps: 0, progress: 0, down: null, up: null, latency: null, jitter: null, error: null })

function readHistory(): SpeedRecord[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is SpeedRecord => item && [item.at, item.down, item.up, item.latency, item.jitter].every(Number.isFinite)).slice(0, MAX_HISTORY)
  } catch { return [] }
}
function readHost(): string {
  try { return (localStorage.getItem(HOST_KEY) ?? '').trim().slice(0, 120) || PING_TARGETS[0].value } catch { return PING_TARGETS[0].value }
}

const [speed, setSpeed] = createSignal<SpeedState>(idle())
const [history, setHistory] = createSignal<SpeedRecord[]>(readHistory())
const [host, setHostSignal] = createSignal(readHost())
const [series, setSeries] = createSignal<(number | null)[]>([])
const [info, setInfo] = createSignal<NetworkInfo | null>(null)
const [pingError, setPingError] = createSignal<string | null>(null)
export { speed, history, host, series, info, pingError }

let unlisten: (() => void) | undefined

function remember(result: NetworkSpeedtestResult) {
  const record: SpeedRecord = { at: result.finishedAt || Date.now(), down: result.downloadMbps, up: result.uploadMbps, latency: result.latencyMs, jitter: result.jitterMs }
  const next = [record, ...history()].slice(0, MAX_HISTORY)
  setHistory(next)
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)) } catch { /* history is a convenience */ }
}

export function clearSpeedHistory() {
  setHistory([])
  try { localStorage.removeItem(HISTORY_KEY) } catch { /* ignore */ }
}

export async function startSpeedtest(): Promise<void> {
  if (speed().running) return
  setSpeed({ ...idle(), running: true, phase: 'latency' })
  unlisten?.()
  const stop = await listen<NetworkSpeedProgress>('network://speedtest', event => {
    const p = event.payload
    if (!speed().running) return
    setSpeed(prev => ({
      ...prev, phase: p.phase, mbps: p.mbps, progress: p.progress,
      latency: p.latencyMs ?? prev.latency, jitter: p.jitterMs ?? prev.jitter,
      down: p.downloadMbps ?? prev.down, up: p.uploadMbps ?? prev.up,
    }))
  }).catch(() => undefined)
  unlisten = stop
  try {
    const result = await cmd.networkSpeedtest()
    if (result.cancelled) {
      setSpeed({ ...idle(), phase: 'cancelled', down: result.downloadMbps || null, latency: result.latencyMs || null, jitter: result.jitterMs || null })
    } else {
      remember(result)
      setSpeed({ ...idle(), phase: 'done', down: result.downloadMbps, up: result.uploadMbps, latency: result.latencyMs, jitter: result.jitterMs, progress: 1 })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'The speed test failed. Check your connection.'
    setSpeed({ ...idle(), phase: 'error', error: message })
  } finally {
    unlisten?.()
    unlisten = undefined
  }
}

export function cancelSpeedtest(): void {
  if (speed().running) void cmd.networkSpeedtestCancel().catch(() => undefined)
}

export function setPingHost(value: string): void {
  const next = value.trim().slice(0, 120) || PING_TARGETS[0].value
  if (next === host()) return
  setHostSignal(next)
  setSeries([])
  setPingError(null)
  try { localStorage.setItem(HOST_KEY, next) } catch { /* ignore */ }
}

/** Rolling stats over the recent probes. */
export function pingStats(values: (number | null)[]): PingStats | null {
  if (!values.length) return null
  const window = values.slice(-24)
  const good = window.filter((value): value is number => value !== null)
  const last = window[window.length - 1]
  if (!good.length) return { min: 0, avg: 0, max: 0, jitter: 0, loss: 100, last: null, count: window.length }
  const jitter = good.length > 1 ? good.slice(1).reduce((sum, value, index) => sum + Math.abs(value - good[index]), 0) / (good.length - 1) : 0
  return {
    min: Math.min(...good), max: Math.max(...good), avg: good.reduce((sum, value) => sum + value, 0) / good.length,
    jitter, loss: (window.length - good.length) / window.length * 100, last: last ?? null, count: window.length,
  }
}

/* A shared probe loop: it runs while at least one Network widget is on screen and pauses during a speed test. */
let watchers = 0
let loop: number | undefined
let infoTimer: number | undefined
let generation = 0

async function probe(token: number) {
  if (token !== generation) return
  if (!speed().running && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
    const target = host()
    try {
      const result = await cmd.networkPing(target, 3)
      if (token === generation && target === host()) {
        setSeries(prev => [...prev, ...result.samplesMs].slice(-MAX_SERIES))
        setPingError(result.address === null ? 'Could not find that host.' : null)
      }
    } catch (error) {
      if (token === generation) setPingError(error instanceof Error ? error.message : typeof error === 'string' ? error : 'Could not measure latency.')
    }
  }
  if (token === generation && watchers > 0) loop = window.setTimeout(() => void probe(token), PING_EVERY_MS)
}
async function refreshInfo() {
  try { setInfo(await cmd.networkInfo()) } catch { /* connection info is best effort */ }
}

export function watchNetwork(): () => void {
  watchers += 1
  if (watchers === 1) {
    const token = ++generation
    void probe(token)
    void refreshInfo()
    infoTimer = window.setInterval(() => void refreshInfo(), 15000)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    watchers -= 1
    if (watchers === 0) {
      generation += 1
      window.clearTimeout(loop)
      window.clearInterval(infoTimer)
      loop = undefined
      infoTimer = undefined
    }
  }
}
