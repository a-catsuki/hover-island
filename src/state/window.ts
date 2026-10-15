import { createSignal } from 'solid-js'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { listen } from '../lib/ipc'

/**
 * Window focus presence. The backend emits `window://foreground` (boolean =
 * a maximized/fullscreen window is in front). The event may never fire; the
 * signal simply stays false and the notch is never veiled.
 */

const [maximizedForeground, setMaximizedForeground] = createSignal(false)

let unlisten: UnlistenFn | null = null
let started = false

export async function subscribeForeground(): Promise<() => void> {
  if (started) return () => {}
  started = true
  try {
    unlisten = await listen<boolean>('window://foreground', (event) =>
      setMaximizedForeground(Boolean(event.payload)),
    )
  } catch {
    unlisten = null
  }
  return () => {
    unlisten?.()
    unlisten = null
    started = false
  }
}

export { maximizedForeground }
