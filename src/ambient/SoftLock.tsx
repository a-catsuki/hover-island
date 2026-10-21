import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { cmd, type FaceSample } from '../lib/ipc'
import FaceGlyph, { Padlock, type GlyphState } from './FaceGlyph'
import { BlinkWatch, FaceCamera, loadFaceEngine, type FaceFrame } from './face'

/** Matches native OPEN_GRACE: the click or key that opened the page is not an unlock attempt. */
const OPEN_GRACE_MS = 1500
const HINT_MS = 4000
const SCAN_MS = 6000
/** Ask for a blink once this much of the scan has gone by without one. */
const BLINK_PROMPT_MS = 1600
const ENGINE_WAIT_MS = 15_000
/** Frames per scan, spaced so they are not near-copies of one another. */
const SAMPLES = 3
const SAMPLE_GAP_MS = 90
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
export default function SoftLock(props: { onAwake: (awake: boolean) => void }) {
  const [phase, setPhase] = createSignal<Phase>('idle')
  const [message, setMessage] = createSignal('')
  const [awake, setAwake] = createSignal(false)
  const [enrolled, setEnrolled] = createSignal(false)
  const [lockedOut, setLockedOut] = createSignal(false)
  const camera = new FaceCamera()
  const openedAt = Date.now()
  let failTimer: ReturnType<typeof setTimeout> | undefined
  let hintTimer: ReturnType<typeof setTimeout> | undefined

  const busy = () => phase() === 'scanning' || phase() === 'success' || phase() === 'hello'
  const useFace = () => enrolled() && !lockedOut()

  const wake = () => {
    setAwake(true)
    props.onAwake(true)
    clearTimeout(hintTimer)
    hintTimer = setTimeout(() => { setAwake(false); props.onAwake(false) }, HINT_MS)
  }

  const fail = (text: string) => {
    setPhase('failed')
    setMessage(text)
    wake()
    clearTimeout(failTimer)
    failTimer = setTimeout(() => setPhase(current => current === 'failed' ? 'idle' : current), FAIL_HOLD_MS)
  }

  const hello = async () => {
    setPhase('hello')
    setMessage('')
    try {
      // On success, or when Windows locks for real instead, native code closes this window.
      const outcome = await cmd.ambientUnlock()
      if (outcome === 'cancelled') setPhase('idle')
    } catch {
      setPhase('idle')
    }
  }

  /** Frames until it has enough open-eyed samples and has seen a blink, or time runs out. */
  const collect = async () => {
    const samples: FaceSample[] = []
    const blink = new BlinkWatch()
    let problem = ''
    let lastSample = 0
    // Count from the first frame, so a slow camera start does not eat the scan.
    let started = 0
    while (!started || (Date.now() - started < SCAN_MS && !(blink.seen && samples.length >= SAMPLES))) {
      let frame: FaceFrame
      try {
        frame = await camera.read()
      } catch {
        started ||= Date.now()
        await delay(200)
        continue
      }
      started ||= Date.now()
      blink.push(frame.eyes)
      if (frame.sample && blink.eyesOpen(frame.eyes)) {
        if (samples.length < SAMPLES && Date.now() - lastSample >= SAMPLE_GAP_MS) {
          samples.push(frame.sample)
          lastSample = Date.now()
        }
        problem = ''
        setMessage(!blink.seen && Date.now() - started > BLINK_PROMPT_MS ? 'Blink to unlock' : '')
      } else if (frame.problem) {
        problem = PROBLEMS[frame.problem]
        setMessage(problem)
      }
    }
    if (!blink.seen && samples.length >= 2) problem = 'Blink to unlock'
    return { samples, blinked: blink.seen, problem }
  }

  const scan = async () => {
    setPhase('scanning')
    setMessage('')
    clearTimeout(failTimer)
    try {
      await withTimeout(loadFaceEngine(), ENGINE_WAIT_MS)
      await camera.start()
    } catch {
      camera.stop()
      return hello()
    }
    let result: Awaited<ReturnType<typeof collect>>
    try {
      result = await collect()
    } finally {
      camera.stop()
    }
    // Not enough of a face to judge: not counted as an attempt.
    if (result.samples.length < 2 || !result.blinked) return fail(result.problem || 'No Face Found')
    const verdict = await cmd.faceVerify(result.samples, result.blinked).catch(() => 'noMatch' as const)
    if (verdict === 'match') {
      setPhase('success')
      setMessage('')
    } else if (verdict === 'lockedOut') {
      setLockedOut(true)
      fail('Use your PIN to unlock')
    } else if (verdict === 'notEnrolled') {
      setEnrolled(false)
      void hello()
    } else {
      fail('Face Not Recognized')
    }
  }

  const attempt = () => {
    if (busy() || Date.now() - openedAt < OPEN_GRACE_MS) return
    void (useFace() ? scan() : hello())
  }

  onMount(() => {
    void cmd.faceStatus().then(status => {
      setEnrolled(status.enrolled)
      setLockedOut(status.attemptsLeft === 0)
      // Load the models while the screen sits idle so the first scan starts at once.
      if (status.enrolled) void loadFaceEngine().catch(() => {})
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
      camera.stop()
    })
  })

  const glyph = (): GlyphState => phase() === 'scanning' ? 'scanning' : phase() === 'success' ? 'success' : phase() === 'failed' ? 'fail' : 'face'
  const hud = () => phase() === 'scanning' || phase() === 'success' || phase() === 'failed'
  const pillLabel = () => phase() === 'hello' ? 'Windows Hello' : useFace() ? 'Press any key to use Face Unlock' : 'Press any key to unlock'

  return (
    <>
      <div class={`ambient__lock ambient__lock--${phase()}`} classList={{ 'ambient__lock--awake': (awake() && !hud()) || phase() === 'hello' }} role="status">
        <span class="ambient__lock-icon"><Padlock open={phase() === 'success'} size={17} /></span>
        <span class="ambient__lock-label">{pillLabel()}</span>
      </div>
      <div class="face-hud" classList={{ 'face-hud--show': hud() }} aria-live="polite">
        <div class="face-hud__panel">
          <FaceGlyph state={glyph()} />
          <Show when={phase() !== 'success'}>
            <p class="face-hud__label">{message() || 'Face Unlock'}</p>
          </Show>
        </div>
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
