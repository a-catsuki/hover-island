import { createSignal } from 'solid-js'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { cmd, onAudioCaptureReady, onAudioSpectrum, onAudioSpectrumError, type AudioSpectrumFrame } from '../lib/ipc'

export const AUDIO_BANDS = 24
export type AudioSpectrum = readonly number[]
export type AudioCaptureStatus = 'off' | 'starting' | 'active' | 'error'
export type AudioFrame = Readonly<AudioSpectrumFrame & { receivedAt: number }>

const quiet = Array.from({ length: AUDIO_BANDS }, () => 0)
const quietFrame: AudioFrame = {
  bands: quiet, waveform: Array(128).fill(0), rms: 0, peak: 0, energy: 0,
  bass: 0, mid: 0, treble: 0, flux: 0, onset: 0, sequence: 0,
  beatSequence: 0, beatAtMs: 0, capturedAtMs: 0, sampleRate: 0, receivedAt: 0,
}
const [audioSpectrum, setAudioSpectrum] = createSignal<AudioSpectrum>(quiet)
const [audioFrame, setAudioFrame] = createSignal<AudioFrame>(quietFrame)
const [audioCaptureStatus, setAudioCaptureStatus] = createSignal<AudioCaptureStatus>('off')
const [audioCaptureError, setAudioCaptureError] = createSignal('')

let subscribers = 0
let unlistenSpectrum: UnlistenFn | null = null
let unlistenError: UnlistenFn | null = null
let unlistenReady: UnlistenFn | null = null
let startup: Promise<void> | null = null
let lifecycle: Promise<void> = Promise.resolve()
let captureRunning = false
let retryTimer:ReturnType<typeof setTimeout>|undefined
let retryCount=0
let watchdogTimer:ReturnType<typeof setInterval>|undefined
let lastSpectrumAt=0
let listenerGeneration=0

const clock = () => performance.now()
const unit = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
function clearFrame(): void { setAudioSpectrum(quiet); setAudioFrame(quietFrame) }

function stopWatchdog():void {
  clearInterval(watchdogTimer)
  watchdogTimer=undefined
  lastSpectrumAt=0
}

function startWatchdog():void {
  stopWatchdog()
  lastSpectrumAt=clock()
  watchdogTimer=setInterval(()=>{
    if(!subscribers||!captureRunning||!lastSpectrumAt||clock()-lastSpectrumAt<1500||audioCaptureStatus()==='error')return
    clearFrame()
    setAudioCaptureStatus('error')
    setAudioCaptureError('System audio stopped sending data. Reconnecting…')
    scheduleRecovery()
  },500)
}

function scheduleRecovery():void {
  if(!subscribers||retryTimer)return
  retryTimer=setTimeout(()=>{retryTimer=undefined;void retryAudioCapture()},Math.min(30_000,2_000*2**Math.min(retryCount++,4)))
}

/** Restart the shared output stream after a device switch or capture failure. */
export function retryAudioCapture():Promise<void> {
  clearTimeout(retryTimer);retryTimer=undefined
  stopWatchdog()
  lifecycle=lifecycle.then(async()=>{
    if(!subscribers)return
    listenerGeneration++
    unlistenSpectrum?.();unlistenError?.();unlistenReady?.();unlistenSpectrum=null;unlistenError=null;unlistenReady=null
    try {await cmd.audioLoopbackStop()} catch { /* Start surfaces the current endpoint error. */ }
    captureRunning=false
    if(subscribers)captureRunning=await startSharedCapture()
  })
  return lifecycle
}

async function startSharedCapture(): Promise<boolean> {
  const generation=++listenerGeneration
  setAudioCaptureStatus('starting')
  setAudioCaptureError('')
  try {
    unlistenSpectrum = await onAudioSpectrum((payload) => {
      if(generation!==listenerGeneration||!subscribers)return
      const bands = Array.isArray(payload.bands) ? payload.bands : []
      if (bands.length !== AUDIO_BANDS || bands.some((value) => !Number.isFinite(value))) return
      lastSpectrumAt=clock()
      const safeBands = bands.map((value) => Math.min(1, Math.max(0, value)))
      setAudioSpectrum(safeBands)
      setAudioFrame({
        bands: safeBands,
        waveform: Array.from({length:128},(_,index)=>{
          const value=payload.waveform?.[index]??0
          return Number.isFinite(value)?Math.max(-1,Math.min(1,value)):0
        }),
        rms:unit(payload.rms),peak:unit(payload.peak),energy:unit(payload.energy),
        bass:unit(payload.bass),mid:unit(payload.mid),treble:unit(payload.treble),
        flux:unit(payload.flux),onset:unit(payload.onset),
        sequence:Number.isFinite(payload.sequence)?payload.sequence:0,
        beatSequence:Number.isFinite(payload.beatSequence)?payload.beatSequence:0,
        beatAtMs:Number.isFinite(payload.beatAtMs)?payload.beatAtMs:0,
        capturedAtMs:Number.isFinite(payload.capturedAtMs)?payload.capturedAtMs:0,
        sampleRate:Number.isFinite(payload.sampleRate)?payload.sampleRate:0,
        receivedAt:lastSpectrumAt,
      })
    })
    unlistenError = await onAudioSpectrumError((message) => {
      if(generation!==listenerGeneration||!subscribers)return
      setAudioCaptureStatus('error')
      setAudioCaptureError(message)
      clearFrame()
      scheduleRecovery()
    })
    unlistenReady = await onAudioCaptureReady(() => {
      if(generation!==listenerGeneration||!subscribers)return
      setAudioCaptureStatus('active')
      setAudioCaptureError('')
      lastSpectrumAt=clock()
      retryCount=0;clearTimeout(retryTimer);retryTimer=undefined
    })
    await cmd.audioLoopbackStart()
    // The native command only confirms that its worker spawned. WASAPI emits a
    // capture-ready event only after it opened and started a render endpoint.
    startWatchdog()
    return true
  } catch (error) {
    unlistenSpectrum?.()
    unlistenError?.()
    unlistenReady?.()
    unlistenSpectrum = null
    unlistenError = null
    unlistenReady = null
    setAudioCaptureStatus('error')
    setAudioCaptureError(String(error))
    clearFrame()
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
    stopWatchdog()
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
      listenerGeneration++
      unlistenSpectrum?.()
      unlistenError?.()
      unlistenReady?.()
      unlistenSpectrum = null
      unlistenError = null
      unlistenReady = null
      stopWatchdog()
      clearFrame()
      setAudioCaptureStatus('off')
    })
  }
}

export { audioSpectrum, audioFrame, audioCaptureStatus, audioCaptureError }
