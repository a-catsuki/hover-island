import { createSignal, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js'
import { cmd, type FaceSample } from '../lib/ipc'
import FaceGlyph from './FaceGlyph'
import { FaceCamera, faceBackend, frontal, loadFaceEngine, type FaceFrame } from './face'

const TICKS = 72
/** Head turned at least this far (radians) lights the ticks it points at. */
const TURN = 0.16
const TICK_SPREAD = 11 * Math.PI / 180
const COMPLETE = 0.85
/** A slow mover may finish with less of the ring once enough time has passed. */
const RELAXED = 0.6
const RELAXED_AFTER_MS = 25_000
const SAMPLE_GAP_MS = 200
/** Descriptors kept per scan, the most frontal first. */
const KEEP = 6
const MIN_KEEP = 3
const MIN_REAL = 0.5
const MIN_LIVE = 0.5
/** With no face for this long, say why that may be. */
const NO_FACE_HINT_MS = 6000
/** Detection failures in a row before the error is shown. */
const SHOW_ERROR_AFTER = 3

type Step = 'intro' | 'loading' | 'scan' | 'between' | 'saving' | 'done' | 'error'

const tickAngle = (index: number) => (index / TICKS) * Math.PI * 2

/**
 * Face enrollment, modelled on setting up a phone's face unlock: frame your face, roll your head
 * around to fill a ring of ticks, twice. Only frontal, live-looking descriptors are kept.
 */
export default function EnrollApp() {
  const [step, setStep] = createSignal<Step>('intro')
  const [pass, setPass] = createSignal<1 | 2>(1)
  const [lit, setLit] = createSignal<boolean[]>(Array(TICKS).fill(false))
  const [prompt, setPrompt] = createSignal('Position your face within the frame.')
  const [error, setError] = createSignal('')
  const [status, setStatus] = createSignal('')
  const camera = new FaceCamera()
  const kept: FaceSample[][] = [[], []]
  let preview: HTMLDivElement | undefined
  let running = false

  const litCount = () => lit().filter(Boolean).length

  const cancel = () => {
    running = false
    camera.stop()
    void cmd.ambientClose()
  }

  const light = (yaw: number, pitch: number) => {
    if (Math.hypot(yaw, pitch) < TURN) return
    // Screen space: x right, y down; looking up lights the top of the ring.
    const heading = Math.atan2(-pitch, yaw)
    setLit(current => current.map((on, index) => {
      if (on) return true
      const gap = Math.abs(Math.atan2(Math.sin(tickAngle(index) - heading), Math.cos(tickAngle(index) - heading)))
      return gap <= TICK_SPREAD
    }))
  }

  const runScan = async () => {
    const index = pass() - 1
    const candidates: { sample: FaceSample; turn: number }[] = []
    const started = Date.now()
    let lastSample = 0
    let lastFace = Date.now()
    let frames = 0
    let failures = 0
    setLit(Array(TICKS).fill(false))
    setStep('scan')
    setStatus('')
    running = true
    // Quick frames drive the ring; a full frame (identity models) only when a sample is due.
    let full = false
    while (running) {
      let frame: FaceFrame
      try {
        frame = await camera.read({ full, frontalOnly: false })
        full = false
        failures = 0
        frames++
      } catch (problem) {
        if (!running) return
        if (++failures >= SHOW_ERROR_AFTER) setStatus(`Face detection is not working: ${problem instanceof Error ? problem.message : String(problem)}`)
        await new Promise(resolve => setTimeout(resolve, 300))
        continue
      }
      if (!running) return
      if (frame.problem === null) {
        const lost = Date.now() - lastFace
        setPrompt(lost > NO_FACE_HINT_MS ? 'No face found. Try facing a light, or sitting a little further back.' : 'Position your face within the frame.')
        if (lost > NO_FACE_HINT_MS) setStatus(`Checked ${frames} frames on the ${faceBackend() === 'cpu' ? 'CPU' : 'GPU'}`)
        continue
      }
      lastFace = Date.now()
      setStatus('')
      if (frame.problem === 'many') {
        setPrompt('Make sure only your face is in the frame.')
        continue
      }
      if (frame.problem === 'far') {
        setPrompt('Move a little closer.')
        continue
      }
      setPrompt('Move your head slowly to complete the circle.')
      light(frame.yaw, frame.pitch)
      full = frontal(frame) && Date.now() - lastSample >= SAMPLE_GAP_MS
      const sample = frame.sample
      if (sample && frontal(frame) && sample.real >= MIN_REAL && sample.live >= MIN_LIVE && Date.now() - lastSample >= SAMPLE_GAP_MS) {
        lastSample = Date.now()
        candidates.push({ sample, turn: Math.hypot(frame.yaw, frame.pitch) })
      }
      const share = litCount() / TICKS
      const enough = candidates.length >= MIN_KEEP
      if (enough && (share >= COMPLETE || (share >= RELAXED && Date.now() - started > RELAXED_AFTER_MS))) {
        running = false
        kept[index] = candidates.sort((a, b) => a.turn - b.turn).slice(0, KEEP).map(entry => entry.sample)
        setLit(Array(TICKS).fill(true))
        await new Promise(resolve => setTimeout(resolve, 700))
        if (pass() === 1) {
          setStep('between')
        } else {
          await save()
        }
        return
      }
    }
  }

  const save = async () => {
    camera.stop()
    setStep('saving')
    try {
      await cmd.faceEnrollSave([...kept[0], ...kept[1]].map(sample => sample.descriptor))
      setStep('done')
    } catch (problem) {
      setError(String(problem))
      setStep('error')
    }
  }

  const begin = async () => {
    setStep('loading')
    try {
      await loadFaceEngine()
      await camera.start()
      preview?.replaceChildren(camera.video)
      setPass(1)
      void runScan()
    } catch {
      camera.stop()
      setError('The camera is not available. Check that no other app is using it, and that camera access for desktop apps is on in Windows Settings > Privacy.')
      setStep('error')
    }
  }

  const second = () => {
    setPass(2)
    void runScan()
  }

  onMount(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel() }
    window.addEventListener('keydown', onKey)
    onCleanup(() => { window.removeEventListener('keydown', onKey); running = false; camera.stop() })
  })

  const scanning = () => step() === 'scan' || step() === 'between' || step() === 'loading'

  return (
    <main class="enroll">
      <Show when={step() !== 'done'}>
        <button type="button" class="enroll__cancel" onClick={cancel}>Cancel</button>
      </Show>
      <div class="enroll__body">
        <Show when={scanning()} fallback={
          <div class="enroll__glyph"><FaceGlyph state={step() === 'done' ? 'success' : step() === 'saving' ? 'scanning' : 'face'} size={120} /></div>
        }>
          <div class="enroll__frame">
            <svg class="enroll__ring" viewBox="0 0 400 400" aria-hidden="true">
              <For each={lit()}>{(on, index) => {
                const angle = tickAngle(index())
                const cos = Math.cos(angle)
                const sin = Math.sin(angle)
                return <line class="enroll__tick" classList={{ 'enroll__tick--lit': on }} x1={200 + cos * 168} y1={200 + sin * 168} x2={200 + cos * 186} y2={200 + sin * 186} />
              }}</For>
            </svg>
            <div class="enroll__preview" ref={preview} />
          </div>
        </Show>
        <Switch>
          <Match when={step() === 'intro'}>
            <h1>How to Set Up Face Unlock</h1>
            <p>First, position your face in the camera frame. Then move your head in a circle to show all the angles of your face.</p>
            <button type="button" class="enroll__primary" onClick={() => void begin()}>Get Started</button>
          </Match>
          <Match when={step() === 'loading'}>
            <p class="enroll__prompt">Starting the camera…</p>
          </Match>
          <Match when={step() === 'scan'}>
            <p class="enroll__prompt">{prompt()}</p>
            <Show when={status()}>
              <p class="enroll__status">{status()}</p>
            </Show>
          </Match>
          <Match when={step() === 'between'}>
            <h1>First Face Unlock scan complete.</h1>
            <p>Now move your head slowly to complete the circle a second time.</p>
            <button type="button" class="enroll__primary" onClick={second}>Continue</button>
          </Match>
          <Match when={step() === 'saving'}>
            <p class="enroll__prompt">Saving…</p>
          </Match>
          <Match when={step() === 'done'}>
            <h1>Face Unlock is now set up.</h1>
            <p>Press any key on the ambient screen and look at your PC to unlock it. Windows Hello stays available as a backup.</p>
            <button type="button" class="enroll__primary" onClick={cancel}>Done</button>
          </Match>
          <Match when={step() === 'error'}>
            <h1>Face Unlock could not be set up.</h1>
            <p>{error()}</p>
            <button type="button" class="enroll__primary" onClick={cancel}>Close</button>
          </Match>
        </Switch>
      </div>
    </main>
  )
}
