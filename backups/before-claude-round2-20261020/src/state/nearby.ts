import { createSignal } from 'solid-js'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { cmd, type NearbyStatus } from '../lib/ipc'

const EMPTY: NearbyStatus = {
  running: false,
  deviceName: '',
  port: 0,
  peers: [],
  transfers: [],
  detail: null,
}

const [nearby, setNearby] = createSignal<NearbyStatus>(EMPTY)

let unlisten: UnlistenFn | null = null
let timer: number | undefined
let started = false
let refs = 0

export function refreshNearby(): Promise<void> {
  return cmd
    .nearbyStatus()
    .then((s) => {
      setNearby(s)
    })
    .catch((e) => { setNearby((s) => ({ ...s, detail: `Nearby status unavailable: ${String(e)}` })) })
}

export async function startNearby(): Promise<void> {
  try {
    setNearby(await cmd.nearbyStart())
  } catch (e) {
    setNearby((s) => ({ ...s, running: false, detail: String(e) }))
  }
}

export async function stopNearby(): Promise<void> {
  try {
    await cmd.nearbyStop()
  } catch (e) {
    setNearby((s) => ({ ...s, detail: String(e) }))
  }
  await refreshNearby()
}

export async function approveNearby(sessionId: string, approved: boolean): Promise<string | null> {
  try {
    await cmd.nearbyApprove(sessionId, approved)
    await refreshNearby()
    return null
  } catch (e) {
    await refreshNearby()
    return String(e)
  }
}

export async function sendNearby(target: string, paths: string[]): Promise<string | null> {
  try {
    await cmd.nearbySend(target, paths)
    return null
  } catch (e) {
    return String(e)
  }
}

/** Reference-counted subscribe + subscribe to `nearby://changed`. Returns a cleanup fn. */
export async function subscribeNearby(): Promise<() => void> {
  refs += 1
  if (!started) {
    started = true
    void refreshNearby()
    try {
      unlisten = await listen<NearbyStatus>('nearby://changed', (e) => setNearby(e.payload))
    } catch {
      unlisten = null
    }
    timer = window.setInterval(() => void refreshNearby(), 2000)
  }

  return () => {
    refs = Math.max(0, refs - 1)
    if (refs === 0 && started) {
      started = false
      unlisten?.()
      unlisten = null
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    }
  }
}

export { nearby }
