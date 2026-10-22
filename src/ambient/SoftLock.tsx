import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { cmd, listen, type FaceSample } from '../lib/ipc'
import { settings } from '../state/settings'
import { FaceOrb, Padlock, type GlyphState } from './FaceGlyph'
import { BlinkWatch, FaceCamera, loadFaceEngine, type FaceFrame } from './face'

/** Matches native OPEN_GRACE: the click or key that opened the page is not an unlock attempt. */
const OPEN_GRACE_MS = 1500
const HINT_MS = 4000
/** How long a scan looks for a usable face; longer when it must also see a blink. */
const SCAN_MS = 3000
const BLINK_SCAN_MS = 6000
/** Ask for a blink once this much of the scan has gone by without one. */
const BLINK_PROMPT_MS = 1600
const ENGINE_WAIT_MS = 15_000
/** Identity frames per scan: two back-to-back frames, the least native code accepts. */
const SAMPLES = 2
/** The failure panel, with the camera still on for an instant retry. */
const FAIL_HOLD_MS = 6000

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
 * The soft lock: a padlock in the notch and a face-scan panel. A key press or click tries face
 * unlock when a face is enrolled, and Windows Hello otherwise or after too many misses.
 * Native code decides every match and closes the window; this only draws and collects frames.
 */
export default function SoftLock(props: { onAwake: (awake: boolean) => void; onUnlock?: () => void }) {
  const [phase, setPhase] = createSignal<Phase>('idle')
  const [message, setMessage] = createSignal('')
  const [detail, setDetail] = createSignal('')
  const [awake, setAwake] = createSignal(false)
  const [enrolled, setEnrolled] = createSignal(false)
  const [lockedOut, setLockedOut] = createSignal(false)
  const camera = new FaceCamera()
  let openedAt = Date.now()
  let failTimer: ReturnType<typeof setTimeout> | undefined
  let hintTimer: ReturnType<typeof setTimeout> | undefined
  /** One automatic scan per wake-up, like raising a phone; after that a key or click retries. */
  let autoScanned = false

  const busy = () => phase() === 'scanning' || phase() === 'success' || phase() === 'hello'
  const useFace = () => enrolled() && !lockedOut()
  const requireBlink = () => settings.ambient.faceRequireBlink
  const settled = () => Date.now() - openedAt >= OPEN_GRACE_MS

  const toIdle = () => {
    setPhase('idle')
    setDetail('')
    camera.stop()
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
    } catch {
      setPhase('idle')
    }
  }

  /**
   * Quick frames (face, pose, eyes) until one is usable, then a full frame for identity, until it
   * has enough samples (and a blink, if required) or time runs out.
   */
  const collect = async () => {
    const samples: FaceSample[] = []
    const blink = new BlinkWatch()
    const blinkNeeded = requireBlink()
    const limit = blinkNeeded ? BLINK_SCAN_MS : SCAN_MS
    let problem = ''
    let sawFace = false
    // Straight to a full read: a face is usually there already, and every frame saved counts.
    let full = true
    // Count from the first frame, so a slow camera start does not eat the scan.
    let started = 0
    const done = () => samples.length >= SAMPLES && (!blinkNeeded || blink.seen)
    while (!started || (Date.now() - started < limit && !done())) {
      let frame: FaceFrame
      try {
        frame = await camera.read({ full })
      } catch {
        started ||= Date.now()
        full = false
        await delay(100)
        continue
      }
      started ||= Date.now()
      blink.push(frame.eyes)
      if (frame.problem !== null) sawFace = true
      const usable = frame.problem === 'none' && blink.eyesOpen(frame.eyes)
      if (frame.sample && usable && samples.length < SAMPLES) samples.push(frame.sample)
      if (usable) {
        problem = ''
        setMessage(blinkNeeded && !blink.seen && Date.now() - started > BLINK_PROMPT_MS ? 'Blink to unlock' : '')
      } else if (frame.problem) {
        problem = PROBLEMS[frame.problem]
        setMessage(problem)
      }
      // Run the heavy models only on frames that are worth it.
      full = usable && samples.length < SAMPLES
    }
    if (blinkNeeded && !blink.seen && samples.length >= SAMPLES) problem = 'Blink to unlock'
    return { samples, blinked: blink.seen, problem, sawFace }
  }

  /** `auto` scans start from a mouse move; with nobody in front of the camera they end quietly. */
  const scan = async (auto = false) => {
    setPhase('scanning')
    setMessage('')
    setDetail('')
    clearTimeout(failTimer)
    try {
      // The camera and the models start together; the camera is usually the slower one.
      await Promise.all([withTimeout(loadFaceEngine(), ENGINE_WAIT_MS), camera.start()])
    } catch {
      camera.stop()
      return auto ? toIdle() : hello()
    }
    const result = await collect()
    // Not enough of a face to judge: not counted as an attempt.
    if (result.samples.length < SAMPLES || (requireBlink() && !result.blinked)) {
      if (auto && !result.sawFace) return toIdle()
      return fail(result.problem || 'No Face Found')
    }
    const check = await cmd.faceVerify(result.samples, result.blinked).catch(() => null)
    const scores = check ? `Match ${Math.round(check.score * 100)}% (needs 55) · real ${Math.round(check.real * 100)} · live ${Math.round(check.live * 100)}` : ''
    if (check?.verdict === 'match') {
      camera.stop()
      setPhase('success')
      setMessage('')
      props.onUnlock?.()
    } else if (check?.verdict === 'lockedOut') {
      setLockedOut(true)
      camera.stop()
      fail('Use your PIN to unlock', scores)
    } else if (check?.verdict === 'notEnrolled') {
      setEnrolled(false)
      void hello()
    } else {
      fail('Face Not Recognized', scores)
    }
  }

  const attempt = () => {
    if (busy() || !settled()) return
    void (useFace() ? scan() : hello())
  }

  const refreshStatus = () => void cmd.faceStatus().then(status => {
    setEnrolled(status.enrolled)
    setLockedOut(status.attemptsLeft === 0)
    // Load the models while the screen sits idle so the first scan starts at once.
    if (status.enrolled) void loadFaceEngine().catch(() => {})
  }).catch(() => {})

  onMount(() => {
    refreshStatus()
    // Native code keeps this page warm between showings (see ambient.rs): reset for each one.
    const unlisten: Array<() => void> = []
    void listen('ambient://shown', () => {
      openedAt = Date.now()
      autoScanned = false
      clearTimeout(failTimer)
      setPhase('idle')
      setMessage('')
      setDetail('')
      refreshStatus()
    }).then(stop => unlisten.push(stop)).catch(() => {})
    void listen('ambient://hidden', () => {
      clearTimeout(failTimer)
      clearTimeout(hintTimer)
      toIdle()
      setAwake(false)
      props.onAwake(false)
    }).then(stop => unlisten.push(stop)).catch(() => {})
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
      camera.stop()
      unlisten.forEach(stop => stop())
    })
  })

  const glyph = (): GlyphState => phase() === 'scanning' ? 'scanning' : phase() === 'success' ? 'success' : phase() === 'failed' ? 'fail' : 'face'
  const hud = () => phase() === 'scanning' || phase() === 'success' || phase() === 'failed'
  const pillLabel = () => phase() === 'hello' ? 'Windows Hello' : useFace() ? 'Look at your PC to unlock' : 'Press any key to unlock'

  return (
    <>
      <div class="ambient__lock" classList={{ [`ambient__lock--${phase()}`]: true, 'ambient__lock--awake': (awake() && !hud()) || phase() === 'hello' }} role="status">
        <span class="ambient__lock-icon"><Padlock open={phase() === 'success'} size={17} /></span>
        <span class="ambient__lock-label">{pillLabel()}</span>
      </div>
      <div class="face-hud" classList={{ 'face-hud--show': hud() }} aria-live="polite">
        <FaceOrb state={glyph()} />
        <p class="face-hud__label" classList={{ 'face-hud__label--hidden': phase() === 'success' }}>{message() || (phase() === 'failed' ? '' : 'Looking for you')}</p>
        <Show when={phase() === 'failed' && detail()}>
          <p class="face-hud__detail">{detail()}</p>
        </Show>
        <Show when={phase() === 'failed'}>
          <div class="face-hud__actions">
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
