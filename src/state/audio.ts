import { createSignal } from 'solid-js'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { cmd, onAudioCaptureReady, onAudioSpectrum, onAudioSpectrumError, type AudioSpectrumFrame } from '../lib/ipc'

export const AUDIO_BANDS = 24
export type AudioSpectrum = readonly number[]
export type AudioCaptureStatus = 'off' | 'starting' | 'active' | 'error'
export type AudioFrame = Readonly<AudioSpectrumFrame & { receivedAt: number }>
/** `full` streams ~30 Hz with the waveform; `low` is ~15 Hz bands only (collapsed pill, ambient scenes). */
export type AudioDetail = 'full' | 'low'

const quiet = Array.from({ length: AUDIO_BANDS }, () => 0)
const noWaveform: number[] = []
const quietFrame: AudioFrame = {
  bands: quiet, waveform: noWaveform, rms: 0, peak: 0, energy: 0,
  bass: 0, mid: 0, treble: 0, flux: 0, onset: 0, sequence: 0,
  beatSequence: 0, beatAtMs: 0, capturedAtMs: 0, sampleRate: 0, receivedAt: 0,
}
const [audioSpectrum, setAudioSpectrum] = createSignal<AudioSpectrum>(quiet)
const [audioFrame, setAudioFrame] = createSignal<AudioFrame>(quietFrame)
const [audioCaptureStatus, setAudioCaptureStatus] = createSignal<AudioCaptureStatus>('off')
const [audioCaptureError, setAudioCaptureError] = createSignal('')

let subscribers = 0
let fullSubscribers = 0
let sentDetail: AudioDetail | null = null
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
let watchdogTripped=false
/** Native capture only emits while the sound changes, plus a quiet heartbeat about once a second, so a long gap means the stream is really gone. */
const WATCHDOG_MS=5000

/** Tell the native side how much detail the busiest subscriber needs. Older hosts without the command ignore it. */
function applyDetail(force = false): void {
  if (!subscribers) return
  const wanted: AudioDetail = fullSubscribers > 0 ? 'full' : 'low'
  if (!force && wanted === sentDetail) return
  sentDetail = wanted
  try {
    const result = typeof cmd.audioSetDetail === 'function' ? cmd.audioSetDetail(wanted === 'low') : undefined
    void Promise.resolve(result).catch(() => {})
  } catch { /* capture still works at the default detail */ }
}

const clock = () => typeof performance !== 'undefined' ? performance.now() : Date.now()
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
    if(!subscribers||!captureRunning||!lastSpectrumAt||clock()-lastSpectrumAt<WATCHDOG_MS||audioCaptureStatus()==='error')return
    watchdogTripped=true
    clearFrame()
    setAudioCaptureStatus('error')
    setAudioCaptureError('System audio stopped sending data. Reconnecting.')
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
  watchdogTripped=false
  setAudioCaptureStatus('starting')
  setAudioCaptureError('')
  try {
    unlistenSpectrum = await onAudioSpectrum((payload) => {
      if(generation!==listenerGeneration||!subscribers)return
      const bands = Array.isArray(payload.bands) ? payload.bands : []
      if (bands.length !== AUDIO_BANDS) return
      lastSpectrumAt=clock()
      // Frames are proof of life: recover from a watchdog trip or a missed ready event.
      if(watchdogTripped||audioCaptureStatus()==='starting'){
        watchdogTripped=false
        setAudioCaptureStatus('active');setAudioCaptureError('')
        retryCount=0;clearTimeout(retryTimer);retryTimer=undefined
      }
      const safeBands = new Array<number>(AUDIO_BANDS)
      for (let index = 0; index < AUDIO_BANDS; index++) {
        const value = bands[index]
        safeBands[index] = Number.isFinite(value) ? (value < 0 ? 0 : value > 1 ? 1 : value) : 0
      }
      setAudioSpectrum(safeBands)
      setAudioFrame({
        bands: safeBands,
        // The waveform is only sent at full detail and no current view draws it, so it is passed through untouched.
        waveform: Array.isArray(payload.waveform) ? payload.waveform : noWaveform,
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
      watchdogTripped=false
      setAudioCaptureStatus('active')
      setAudioCaptureError('')
      lastSpectrumAt=clock()
      retryCount=0;clearTimeout(retryTimer);retryTimer=undefined
    })
    await cmd.audioLoopbackStart()
    sentDetail = null
    applyDetail(true)
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
export async function subscribeAudioSpectrum(detail: AudioDetail = 'full'): Promise<() => void> {
  subscribers++
  if (detail === 'full') fullSubscribers++
  // The first subscriber's detail is sent once capture starts; later ones may raise or lower it.
  if (subscribers > 1) applyDetail()
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
    if (detail === 'full') fullSubscribers = Math.max(0, fullSubscribers - 1)
    if (subscribers !== 0) { applyDetail(); return }
    sentDetail = null
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
