import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { cmd, type FaceCheck, type FaceSample } from '../lib/ipc'
import { saveFaceTiming } from '../lib/faceTiming'
import { FaceScan, FaceScanCancelled, FaceScanExpired, FACE_SCAN_MS, BLINK_SCAN_MS } from '../lib/faceScan'
import { settings } from '../state/settings'
import FaceGlyph, { Padlock, type GlyphState } from './FaceGlyph'
import { BlinkWatch, FaceCamera, faceBackend, loadFaceEngine, type FaceFrame } from './face'

/** Matches native OPEN_GRACE: the click or key that opened the page is not an unlock attempt. */
const OPEN_GRACE_MS = 1500
const HINT_MS = 4000
/** Ask for a blink once this much of the scan has gone by without one. */
const BLINK_PROMPT_MS = 1600
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

/**
 * The soft lock: the notch holds a padlock, and grows into a face-scan island the way Face ID
 * does in an iPhone's Dynamic Island. Moving the mouse or pressing a key scans; each good frame
 * is checked as it arrives, so a match unlocks on the first one. Windows Hello is the fallback.
 * Native code decides every match and closes the window; this only draws and collects frames.
 */
export default function SoftLock(props: { active: boolean; onAwake: (awake: boolean) => void; onUnlock: () => void }) {
  const [phase, setPhase] = createSignal<Phase>('idle')
  const [message, setMessage] = createSignal('')
  const [detail, setDetail] = createSignal('')
  const [awake, setAwake] = createSignal(false)
  const [enrolled, setEnrolled] = createSignal(false)
  const [lockedOut, setLockedOut] = createSignal(false)
  const camera = new FaceCamera()
  let openedAt = Date.now()
  let currentScan: FaceScan | undefined
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
    if (!props.active) { camera.stop(); return }
    if (keepReady() && useFace()) return
    lingerTimer = setTimeout(() => { if (phase() !== 'scanning') camera.stop() }, CAMERA_LINGER_MS)
  }

  const toIdle = () => {
    setPhase('idle')
    setDetail('')
    linger()
  }

  const wake = () => {
    if (!props.active) return
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
    currentScan?.cancel()
    currentScan = undefined
    clearTimeout(lingerTimer)
    camera.stop()
    setPhase('hello')
    setMessage('')
    setDetail('')
    try {
      // On success, or when Windows locks for real instead, native code closes this window.
      const outcome = await cmd.ambientUnlock()
      if (outcome === 'cancelled') setPhase('idle')
      // Native Hello closes/hides the page before resolving. Do not fade its next showing.
    } catch {
      setPhase('idle')
    }
  }

  /**
   * Full frames until a check matches, the time runs out or native code says stop. Each usable
   * frame is checked at once with the one before it, so a clear look unlocks on the first frame.
   */
  const collect = async (scan: FaceScan) => {
    const samples: FaceSample[] = []
    const blink = new BlinkWatch()
    const blinkNeeded = requireBlink()
    let problem = ''
    let sawFace = false
    let frames = 0
    let probes = 0
    let check: FaceCheck | null = null
    const started = Date.now()
    while (scan.remaining > 120) {
      let frame: FaceFrame
      try {
        frame = await scan.wait(camera.read())
      } catch (error) {
        if (error instanceof FaceScanCancelled || error instanceof FaceScanExpired) throw error
        await scan.wait(delay(80))
        continue
      }
      frames++
      blink.push(frame.eyes)
      if (frame.problem !== null) sawFace = true
      const usable = frame.problem === 'none' && (!blinkNeeded || blink.eyesOpen(frame.eyes))
      if (frame.sample && usable) {
        samples.push(frame.sample)
        if (samples.length > WINDOW) samples.shift()
      }
      if (usable) {
        problem = ''
        setMessage(blinkNeeded && !blink.seen && Date.now() - started > BLINK_PROMPT_MS ? 'Blink to unlock' : '')
      } else if (frame.problem) {
        problem = PROBLEMS[frame.problem]
        setMessage(problem)
      }
      const ready = frame.sample && usable && (!blinkNeeded || blink.seen)
      if (ready && probes < PROBES) {
        probes++
        check = await scan.wait(cmd.faceVerify(samples, blink.seen, false, scan.deadline))
        if (check && check.verdict !== 'noMatch') break
      }
      // Finish a clear mismatch promptly instead of running full models until the deadline.
      if (probes >= PROBES) break
      if (!usable) await scan.wait(delay(40))
    }
    if (blinkNeeded && !blink.seen && samples.length > 0) problem = 'Blink to unlock'
    // The scan's own check, which counts as an attempt; skipped when a probe already settled it.
    if (samples.length > 0 && (!blinkNeeded || blink.seen) && check?.verdict !== 'match' && check?.verdict !== 'lockedOut' && check?.verdict !== 'notEnrolled') {
      check = await scan.wait(cmd.faceVerify(samples, blink.seen, true, scan.deadline))
    }
    return { check, sampled: samples.length > 0, blinked: blink.seen, problem, sawFace, frames }
  }

  /** `auto` scans start from a mouse move; with nobody in front of the camera they end quietly. */
  const scan = async (auto = false) => {
    if (!props.active || busy()) return
    const session = new FaceScan(requireBlink() ? BLINK_SCAN_MS : FACE_SCAN_MS)
    currentScan?.cancel()
    currentScan = session
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
        session.wait(loadFaceEngine()).then(() => { modelsMs = performance.now() - begun }),
        session.wait(camera.start()).then(() => { cameraMs = warm ? 0 : performance.now() - begun }),
      ])
    const result = await collect(session)
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
    } catch (error) {
      if (session.cancelled || currentScan !== session || !props.active) return
      camera.stop()
      saveFaceTiming({ at: Date.now(), matched: false, totalMs: performance.now() - begun, cameraMs, modelsMs, frames: 0, backend: faceBackend() })
      fail(error instanceof FaceScanExpired ? 'Face scan took too long' : 'Camera unavailable', 'Try again or use your PIN')
    } finally {
      if (currentScan === session) currentScan = undefined
    }
  }

  const attempt = () => {
    if (!props.active || busy() || !settled()) return
    void (useFace() ? scan() : hello())
  }

  createEffect(() => {
    const active = props.active
    openedAt = Date.now()
    autoScanned = false
    clearTimeout(failTimer)
    clearTimeout(hintTimer)
    clearTimeout(lingerTimer)
    currentScan?.cancel()
    currentScan = undefined
    camera.stop()
    setPhase('idle')
    setMessage('')
    setDetail('')
    setAwake(false)
    props.onAwake(false)
    let stale = false
    void cmd.faceStatus().then(status => {
      if (stale) return
      setEnrolled(status.enrolled)
      setLockedOut(status.attemptsLeft === 0)
      if (!status.enrolled) return
      // Load the models while the screen sits idle so the first scan starts at once.
      void loadFaceEngine().catch(() => {})
      if (active && keepReady() && status.attemptsLeft > 0) void camera.start().catch(() => {})
    }).catch(() => {})
    onCleanup(() => { stale = true })
  })

  onMount(() => {
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
      currentScan?.cancel()
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
      <div class="island-note" classList={{ 'island-note--show': phase() === 'failed' || phase() === 'scanning' }}>
        <p class="island-note__text">{message()}</p>
        <Show when={phase() === 'failed' && detail()}>
          <p class="island-note__detail">{detail()}</p>
        </Show>
        <Show when={phase() === 'failed' || phase() === 'scanning'}>
          <div class="island-note__actions">
            <Show when={phase() === 'failed' && useFace()}>
              <button type="button" onClick={() => void scan()}>Try Again</button>
            </Show>
            <button type="button" onClick={() => void hello()}>Use PIN</button>
          </div>
        </Show>
      </div>
    </>
  )
}
