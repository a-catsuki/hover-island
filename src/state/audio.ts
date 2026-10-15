import { createSignal } from 'solid-js'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { cmd, onAudioSpectrum, onAudioSpectrumError } from '../lib/ipc'

export const AUDIO_BANDS = 24
export type AudioSpectrum = readonly number[]
export type AudioCaptureStatus = 'off' | 'starting' | 'active' | 'error'

const quiet = Array.from({ length: AUDIO_BANDS }, () => 0)
const [audioSpectrum, setAudioSpectrum] = createSignal<AudioSpectrum>(quiet)
const [audioCaptureStatus, setAudioCaptureStatus] = createSignal<AudioCaptureStatus>('off')
const [audioCaptureError, setAudioCaptureError] = createSignal('')

let subscribers = 0
let unlistenSpectrum: UnlistenFn | null = null
let unlistenError: UnlistenFn | null = null
let startup: Promise<void> | null = null
let lifecycle: Promise<void> = Promise.resolve()
let captureRunning = false
let retryTimer:ReturnType<typeof setTimeout>|undefined
let retryCount=0

function scheduleRecovery():void {
  if(!subscribers||retryTimer)return
  retryTimer=setTimeout(()=>{retryTimer=undefined;void retryAudioCapture()},Math.min(30_000,2_000*2**Math.min(retryCount++,4)))
}

/** Restart the shared output stream after a device switch or capture failure. */
export function retryAudioCapture():Promise<void> {
  clearTimeout(retryTimer);retryTimer=undefined
  lifecycle=lifecycle.then(async()=>{
    if(!subscribers)return
    unlistenSpectrum?.();unlistenError?.();unlistenSpectrum=null;unlistenError=null
    try {await cmd.audioLoopbackStop()} catch { /* Start surfaces the current endpoint error. */ }
    captureRunning=false
    if(subscribers)captureRunning=await startSharedCapture()
  })
  return lifecycle
}

async function startSharedCapture(): Promise<boolean> {
  setAudioCaptureStatus('starting')
  setAudioCaptureError('')
  try {
    unlistenSpectrum = await onAudioSpectrum((payload) => {
      const bands = Array.isArray(payload.bands) ? payload.bands : []
      if (bands.length !== AUDIO_BANDS || bands.some((value) => !Number.isFinite(value))) return
      setAudioCaptureStatus('active')
      retryCount=0;clearTimeout(retryTimer);retryTimer=undefined
      setAudioSpectrum(bands.map((value) => Math.min(1, Math.max(0, value))))
    })
    unlistenError = await onAudioSpectrumError((message) => {
      setAudioCaptureStatus('error')
      setAudioCaptureError(message)
      scheduleRecovery()
    })
    await cmd.audioLoopbackStart()
    // The native command only confirms the worker thread spawned. The first validated
    // spectrum event is the evidence that WASAPI actually opened and read the endpoint.
    return true
  } catch (error) {
    unlistenSpectrum?.()
    unlistenError?.()
    unlistenSpectrum = null
    unlistenError = null
    setAudioCaptureStatus('error')
    setAudioCaptureError(String(error))
    scheduleRecovery()
    return false
  }
}

/** Acquires the one shared loopback stream; the returned disposer releases it. */
export async function subscribeAudioSpectrum(): Promise<() => void> {
  subscribers++
  if (subscribers === 1) {
    startup = lifecycle.then(async () => {
      if (subscribers === 0 || captureRunning) return
      captureRunning = await startSharedCapture()
    })
    lifecycle = startup
  }
  if (startup) await startup
  let released = false
  return () => {
    if (released) return
    released = true
    subscribers = Math.max(0, subscribers - 1)
    if (subscribers !== 0) return
    clearTimeout(retryTimer);retryTimer=undefined;retryCount=0
    const pending = startup
    startup = null
    lifecycle = lifecycle.then(async () => {
      if (subscribers !== 0) return
      await pending
      if (subscribers !== 0) return
      if (captureRunning) {
        try { await cmd.audioLoopbackStop() } catch { /* window may be closing */ }
        captureRunning = false
      }
      unlistenSpectrum?.()
      unlistenError?.()
      unlistenSpectrum = null
      unlistenError = null
      setAudioSpectrum(quiet)
      setAudioCaptureStatus('off')
    })
  }
}

export { audioSpectrum, audioCaptureStatus, audioCaptureError }
