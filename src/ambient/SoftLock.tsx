import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { cmd, type FaceCheck, type FaceSample } from '../lib/ipc'
import { saveFaceTiming } from '../lib/faceTiming'
import { settings } from '../state/settings'
import FaceGlyph, { Padlock, type GlyphState } from './FaceGlyph'
import { BlinkWatch, FaceCamera, faceBackend, loadFaceEngine, type FaceFrame } from './face'

/** Matches native OPEN_GRACE: the click or key that opened the page is not an unlock attempt. */
const OPEN_GRACE_MS = 1500
const HINT_MS = 4000
/** How long a scan looks for a matching face, from its first frame; longer when it must also see a blink. */
const SCAN_MS = 2500
const BLINK_SCAN_MS = 6000
/** Ask for a blink once this much of the scan has gone by without one. */
const BLINK_PROMPT_MS = 1600
const ENGINE_WAIT_MS = 15_000
/** Frames checked mid-scan before the scan's own (counted) check. Native code allows a few more. */
const PROBES = 3
/** Frames averaged in a check: the newest ones. */
const WINDOW = 2
/** The failure message, with the camera still on for an instant retry. */
const FAIL_HOLD_MS = 6000
/** After a scan, the camera stays on this long so a retry starts at once. */
const CAMERA_LINGER_MS = 20_000

type Phase = 'idle' | 'scanning' | 'success' | 'failed' | 'hello'

const PROBLEMS: Record<NonNullable<FaceFrame['problem']>, string> = {
  none: '',
  many: 'Only one face, please',
  far: 'Move a little closer',
  turned: 'Look at the screen',
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const withTimeout = <T,>(promise: Promise<T>, ms: number) => Promise.race([promise, delay(ms).then(() => { throw new Error('timed out') })])

/**
 * The soft lock: the notch holds a padlock, and grows into a face-scan island the way Face ID
 * does in an iPhone's Dynamic Island. Moving the mouse or pressing a key scans; each good frame
 * is checked as it arrives, so a match unlocks on the first one. Windows Hello is the fallback.
 * Native code decides every match and closes the window; this only draws and collects frames.
 */
export default function SoftLock(props: { onAwake: (awake: boolean) => void; onUnlock: () => void }) {
  const [phase, setPhase] = createSignal<Phase>('idle')
  const [message, setMessage] = createSignal('')
  const [detail, setDetail] = createSignal('')
  const [awake, setAwake] = createSignal(false)
  const [enrolled, setEnrolled] = createSignal(false)
  const [lockedOut, setLockedOut] = createSignal(false)
  const camera = new FaceCamera()
  const openedAt = Date.now()
  let failTimer: ReturnType<typeof setTimeout> | undefined
  let hintTimer: ReturnType<typeof setTimeout> | undefined
  let lingerTimer: ReturnType<typeof setTimeout> | undefined
  /** One automatic scan per wake-up, like raising a phone; after that a key or click retries. */
  let autoScanned = false

  const busy = () => phase() === 'scanning' || phase() === 'success' || phase() === 'hello'
  const useFace = () => enrolled() && !lockedOut()
  const requireBlink = () => settings.ambient.faceRequireBlink
  const keepReady = () => settings.ambient.faceCameraReady
  const settled = () => Date.now() - openedAt >= OPEN_GRACE_MS

  /** Turns the camera off after a while, or never while "keep ready" is on. */
  const linger = () => {
    clearTimeout(lingerTimer)
    if (keepReady() && useFace()) return
    lingerTimer = setTimeout(() => { if (phase() !== 'scanning') camera.stop() }, CAMERA_LINGER_MS)
  }

  const toIdle = () => {
    setPhase('idle')
    setDetail('')
    linger()
  }

  const wake = () => {
    setAwake(true)
    props.onAwake(true)
    clearTimeout(hintTimer)
    hintTimer = setTimeout(() => { setAwake(false); props.onAwake(false); autoScanned = false }, HINT_MS)
    // Moving the mouse is enough: start looking straight away.
    if (useFace() && phase() === 'idle' && !autoScanned && settled()) {
      autoScanned = true
      void scan(true)
    }
  }

  const fail = (text: string, why = '') => {
    setPhase('failed')
    setMessage(text)
    setDetail(why)
    setAwake(true)
    props.onAwake(true)
    clearTimeout(failTimer)
    failTimer = setTimeout(() => { if (phase() === 'failed') toIdle() }, FAIL_HOLD_MS)
    linger()
  }

  const hello = async () => {
    camera.stop()
    setPhase('hello')
    setMessage('')
    setDetail('')
    try {
      // On success, or when Windows locks for real instead, native code closes this window.
      const outcome = await cmd.ambientUnlock()
      if (outcome === 'cancelled') setPhase('idle')
      else if (outcome === 'verified') props.onUnlock()
    } catch {
      setPhase('idle')
    }
  }

  /**
   * Full frames until a check matches, the time runs out or native code says stop. Each usable
   * frame is checked at once with the one before it, so a clear look unlocks on the first frame.
   */
  const collect = async () => {
    const samples: FaceSample[] = []
    const blink = new BlinkWatch()
    const blinkNeeded = requireBlink()
    const limit = blinkNeeded ? BLINK_SCAN_MS : SCAN_MS
    let problem = ''
    let sawFace = false
    let frames = 0
    let probes = 0
    let check: FaceCheck | null = null
    let checked = 0
    // Count from the first frame, so a slow camera start does not eat the scan.
    let started = 0
    while (!started || Date.now() - started < limit) {
      let frame: FaceFrame
      try {
        frame = await camera.read()
      } catch {
        started ||= Date.now()
        await delay(80)
        continue
      }
      started ||= Date.now()
      frames++
      blink.push(frame.eyes)
      if (frame.problem !== null) sawFace = true
      const usable = frame.problem === 'none' && (!blinkNeeded || blink.eyesOpen(frame.eyes))
      if (frame.sample && usable) samples.push(frame.sample)
      if (usable) {
        problem = ''
        setMessage(blinkNeeded && !blink.seen && Date.now() - started > BLINK_PROMPT_MS ? 'Blink to unlock' : '')
      } else if (frame.problem) {
        problem = PROBLEMS[frame.problem]
        setMessage(problem)
      }
      const ready = samples.length > checked && (!blinkNeeded || blink.seen)
      if (ready && probes < PROBES) {
        probes++
        checked = samples.length
        check = await cmd.faceVerify(samples.slice(-WINDOW), blink.seen, false).catch(() => null)
        if (check && check.verdict !== 'noMatch') break
      }
    }
    if (blinkNeeded && !blink.seen && samples.length > 0) problem = 'Blink to unlock'
    // The scan's own check, which counts as an attempt; skipped when a probe already settled it.
    if (samples.length > 0 && (!blinkNeeded || blink.seen) && check?.verdict !== 'match' && check?.verdict !== 'lockedOut' && check?.verdict !== 'notEnrolled') {
      check = await cmd.faceVerify(samples.slice(-WINDOW), blink.seen, true).catch(() => null)
    }
    return { check, sampled: samples.length > 0, blinked: blink.seen, problem, sawFace, frames }
  }

  /** `auto` scans start from a mouse move; with nobody in front of the camera they end quietly. */
  const scan = async (auto = false) => {
    const begun = performance.now()
    setPhase('scanning')
    setMessage('')
    setDetail('')
    clearTimeout(failTimer)
    clearTimeout(lingerTimer)
    let cameraMs = 0
    let modelsMs = 0
    try {
      // The camera and the models start together; the camera is usually the slower one.
      const warm = camera.running
      await Promise.all([
        withTimeout(loadFaceEngine(), ENGINE_WAIT_MS).then(() => { modelsMs = performance.now() - begun }),
        camera.start().then(() => { cameraMs = warm ? 0 : performance.now() - begun }),
      ])
    } catch {
      camera.stop()
      return auto ? toIdle() : hello()
    }
    const result = await collect()
    const check = result.check
    const totalMs = performance.now() - begun
    if (result.sampled) saveFaceTiming({ at: Date.now(), matched: check?.verdict === 'match', totalMs, cameraMs, modelsMs, frames: result.frames, backend: faceBackend() })
    const scores = check ? `Match ${Math.round(check.score * 100)}% · real ${Math.round(check.real * 100)} · live ${Math.round(check.live * 100)} · ${(totalMs / 1000).toFixed(1)} s on the ${faceBackend() === 'cpu' ? 'CPU' : 'GPU'}` : ''
    if (check?.verdict === 'match') {
      camera.stop()
      setPhase('success')
      setMessage('')
      props.onUnlock()
      return
    }
    if (check?.verdict === 'lockedOut') {
      setLockedOut(true)
      camera.stop()
      return fail('Use your PIN to unlock', scores)
    }
    if (check?.verdict === 'notEnrolled') {
      setEnrolled(false)
      return void hello()
    }
    if (!check) {
      // Not enough of a face to judge: not counted as an attempt.
      if (auto && !result.sawFace) return toIdle()
      return fail(result.problem || 'No Face Found')
    }
    fail('Not Recognized', scores)
  }

  const attempt = () => {
    if (busy() || !settled()) return
    void (useFace() ? scan() : hello())
  }

  onMount(() => {
    void cmd.faceStatus().then(status => {
      setEnrolled(status.enrolled)
      setLockedOut(status.attemptsLeft === 0)
      if (!status.enrolled) return
      // Load the models while the screen sits idle so the first scan starts at once.
      void loadFaceEngine().catch(() => {})
      if (keepReady() && status.attemptsLeft > 0) void camera.start().catch(() => {})
    }).catch(() => {})
    const onInput = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('button')) return
      attempt()
    }
    window.addEventListener('keydown', onInput)
    window.addEventListener('pointerdown', onInput)
    window.addEventListener('pointermove', wake)
    onCleanup(() => {
      window.removeEventListener('keydown', onInput)
      window.removeEventListener('pointerdown', onInput)
      window.removeEventListener('pointermove', wake)
      clearTimeout(failTimer)
      clearTimeout(hintTimer)
      clearTimeout(lingerTimer)
      camera.stop()
    })
  })

  const glyph = (): GlyphState => phase() === 'scanning' ? 'scanning' : phase() === 'success' ? 'success' : phase() === 'failed' ? 'fail' : 'face'
  const expanded = () => phase() === 'scanning' || phase() === 'success' || phase() === 'failed'
  const label = () => phase() === 'hello' ? 'Windows Hello' : useFace() ? 'Look at your PC to unlock' : 'Press any key to unlock'

  return (
    <>
      <div class="island-scrim" classList={{ 'island-scrim--show': expanded() }} aria-hidden="true" />
      <div class={`island island--${phase()}`} classList={{ 'island--awake': (awake() && !expanded()) || phase() === 'hello', 'island--open': expanded() }} role="status" aria-live="polite">
        <div class="island__bar">
          <span class="island__lock"><Padlock open={phase() === 'success'} size={16} /></span>
          <span class="island__label">{label()}</span>
        </div>
        <div class="island__scan">
          <FaceGlyph state={glyph()} size={78} />
        </div>
      </div>
      <div class="island-note" classList={{ 'island-note--show': phase() === 'failed' || (phase() === 'scanning' && !!message()) }}>
        <p class="island-note__text">{message()}</p>
        <Show when={phase() === 'failed' && detail()}>
          <p class="island-note__detail">{detail()}</p>
        </Show>
        <Show when={phase() === 'failed'}>
          <div class="island-note__actions">
            <Show when={useFace()}>
              <button type="button" onClick={() => void scan()}>Try Again</button>
            </Show>
            <button type="button" onClick={() => void hello()}>Use PIN</button>
          </div>
        </Show>
      </div>
    </>
  )
}
