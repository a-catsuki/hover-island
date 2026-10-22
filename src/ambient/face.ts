import type { Config, FaceResult, Human, Result } from '@vladmandic/human'
import type { FaceSample } from '../lib/ipc'

/** Face models run in this page on the GPU, offline. Only descriptors reach native code, which matches them. */

const CAMERA = { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } as const
/** Head turned further than this (radians) is too far off-axis for a reliable descriptor. */
const FRONTAL = 0.32
/** A face narrower than this share of the frame is too far away to trust. */
const MIN_FACE_WIDTH = 0.18
/** Face mesh points (MediaPipe numbering): eye corners, then upper and lower lid, for each eye. */
const EYES = [[33, 133, 159, 145], [362, 263, 386, 374]] as const
/** A frame that takes longer than this has hung the GPU backend. */
const FRAME_TIMEOUT_MS = 10_000
/** The first frames also compile GPU shaders, which slow GPUs take a while over. */
const FIRST_FRAME_TIMEOUT_MS = 30_000
let framesDone = 0
/** Backend failures in a row before switching to the slower CPU backend. */
const GPU_FAILURES = 2

// Every frame must be scored afresh: cached results would let one good frame vouch for later ones.
const CONFIG: Partial<Config> = {
  modelBasePath: '/models/face/',
  debug: false,
  cacheSensitivity: 0,
  warmup: 'none',
  // Human's image filters run in a second WebGL context, which some GPU drivers refuse.
  filter: { enabled: false },
  face: {
    enabled: true,
    detector: { rotation: true, maxDetected: 2, skipFrames: 0, skipTime: 0, minConfidence: 0.5, return: false },
    mesh: { enabled: true },
    iris: { enabled: false },
    attention: { enabled: false },
    emotion: { enabled: false },
    description: { enabled: true, skipFrames: 0, skipTime: 0 },
    antispoof: { enabled: true, skipFrames: 0, skipTime: 0 },
    liveness: { enabled: true, skipFrames: 0, skipTime: 0 },
  },
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false },
  segmentation: { enabled: false },
}

/** Detector and mesh only: enough to find the face, its pose and its eyes, several times faster. */
const QUICK: Partial<Config> = { face: { description: { enabled: false }, antispoof: { enabled: false }, liveness: { enabled: false } } }
const FULL: Partial<Config> = { face: { description: { enabled: true }, antispoof: { enabled: true }, liveness: { enabled: true } } }

let engine: Promise<Human> | null = null
let backend: 'webgl' | 'cpu' = 'webgl'
let gpuFailures = 0
/** A timeout cannot cancel TensorFlow. Never start another detection on a busy engine. */
let detecting = false

const timeout = <T,>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })

/**
 * Runs every loaded model once on zeros. The first run of a model compiles its GPU shaders,
 * which takes seconds; doing it while the screen sits idle makes the first scan as fast as the
 * rest. (Human's own warmup fetches a data: URL, which the app's content security policy blocks.)
 */
function compileModels(human: Human): void {
  const tf = human.tf
  for (const model of Object.values(human.models.models)) {
    const shape = model?.inputs?.[0]?.shape
    if (!model || !shape) continue
    try {
      tf.tidy(() => {
        const input = tf.zeros(shape.map((size: number) => (size > 0 ? size : 1)))
        const output = model.execute(input)
        // Read one value so the GPU actually runs the graph now.
        const first = Array.isArray(output) ? output[0] : output
        first.dataSync()
      })
    } catch (error) {
      // Only a speed-up; the model still compiles on its first real frame.
      console.warn('Face unlock: could not precompile a model', error)
    }
  }
}

/**
 * One full detection on a sample face at the camera's frame size, so the crop and resize steps
 * around the models are compiled too and the first real frame is as fast as the rest.
 */
async function warmUp(human: Human): Promise<void> {
  try {
    const image = new Image()
    image.src = `${CONFIG.modelBasePath}warmup.jpg`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 480
    const context = canvas.getContext('2d')
    if (!context) return
    context.fillStyle = '#000'
    context.fillRect(0, 0, canvas.width, canvas.height)
    const size = Math.min(canvas.height, image.naturalHeight * (canvas.height / image.naturalHeight))
    context.drawImage(image, (canvas.width - size) / 2, 0, size, size)
    await timeout(human.detect(canvas, FULL), FIRST_FRAME_TIMEOUT_MS, 'Face models')
    framesDone = 3
  } catch (error) {
    // Only a speed-up; the first real frame compiles whatever is left.
    console.warn('Face unlock: warmup failed', error)
  }
}

async function createEngine(kind: 'webgl' | 'cpu'): Promise<Human> {
  const { Human } = await import('@vladmandic/human')
  const human = new Human({ ...CONFIG, backend: kind })
  await human.load()
  await timeout(human.tf.ready(), FRAME_TIMEOUT_MS, 'Face models')
  compileModels(human)
  await warmUp(human)
  return human
}

/** Loads the models once, on the GPU, or on the CPU if the GPU backend fails. Safe to call early. */
export function loadFaceEngine(): Promise<Human> {
  engine ??= createEngine(backend).catch(error => {
    if (backend === 'cpu') throw error
    console.error('Face unlock: GPU backend failed, using CPU', error)
    backend = 'cpu'
    return createEngine('cpu')
  }).catch(error => { engine = null; throw error })
  return engine
}

/** The backend in use, for the status line. */
export const faceBackend = () => backend

/** One detection. Repeated backend failures switch to the CPU backend for the next frame. */
async function detect(video: HTMLVideoElement, full: boolean): Promise<Result> {
  const human = await loadFaceEngine()
  if (detecting) throw new Error('Face detection is still finishing')
  detecting = true
  const pending = Promise.resolve().then(() => human.detect(video, full ? FULL : QUICK))
  void pending.finally(() => { detecting = false }).catch(() => {})
  try {
    const limit = framesDone < 3 ? FIRST_FRAME_TIMEOUT_MS : FRAME_TIMEOUT_MS
    const result = await timeout(pending, limit, 'Face detection')
    framesDone++
    gpuFailures = 0
    // A soft error, such as the video not being ready yet; the next frame may be fine.
    if (result.error) throw new Error(result.error)
    return result
  } catch (error) {
    if (backend === 'webgl' && !(error instanceof Error && /tensor|input/i.test(error.message)) && ++gpuFailures >= GPU_FAILURES) {
      console.error('Face unlock: GPU detection keeps failing, using CPU', error)
      backend = 'cpu'
      engine = null
      framesDone = 0
    }
    throw error
  }
}

export interface FaceFrame {
  /** Why this frame cannot be used, if it cannot. */
  problem: 'none' | 'many' | 'far' | 'turned' | null
  /** Head direction, radians: positive yaw is toward the mirrored preview's right, positive pitch is up. */
  yaw: number
  pitch: number
  /** Eye openness: lid gap over eye width, averaged over both eyes. Drops sharply in a blink. */
  eyes: number | null
  /** Only on full reads of a usable face. */
  sample: FaceSample | null
}

export class FaceCamera {
  readonly video = document.createElement('video')
  private stream: MediaStream | null = null
  private starting: Promise<void> | null = null
  private generation = 0

  /** True once frames are flowing. */
  get running(): boolean {
    return this.stream !== null && !this.starting
  }

  /** Starts the camera, or joins a start already under way. */
  start(): Promise<void> {
    if (this.running) return Promise.resolve()
    if (this.starting) return this.starting
    const generation = this.generation
    const pending = this.open(generation).catch(error => {
      if (generation === this.generation) this.stop()
      throw error
    }).finally(() => {
      if (this.starting === pending) this.starting = null
    })
    this.starting = pending
    return this.starting
  }

  private async open(generation: number): Promise<void> {
    this.video.muted = true
    this.video.playsInline = true
    const stream = await navigator.mediaDevices.getUserMedia({ video: CAMERA, audio: false })
    if (generation !== this.generation) {
      stream.getTracks().forEach(track => track.stop())
      throw new Error('Camera start cancelled')
    }
    this.stream = stream
    this.video.srcObject = stream
    await this.video.play()
    if (generation !== this.generation) throw new Error('Camera start cancelled')
    // Detection skips a video that has no current frame yet.
    if (this.video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
      await timeout(new Promise(resolve => this.video.addEventListener('canplay', resolve, { once: true })), 2500, 'Camera')
    }
    if (generation !== this.generation) throw new Error('Camera start cancelled')
    // Stopped while starting: make sure the light goes off.
    if (this.stream !== stream) stream.getTracks().forEach(track => track.stop())
  }

  /** Turns the camera (and its light) off straight away. */
  stop(): void {
    this.generation++
    this.starting = null
    this.stream?.getTracks().forEach(track => track.stop())
    this.stream = null
    this.video.srcObject = null
  }

  /**
   * Reads one frame. A quick read finds the face, pose and eyes; a full read also runs the
   * identity, anti-spoof and liveness models. Throws when detection itself fails.
   */
  async read(options: { full?: boolean; frontalOnly?: boolean } = {}): Promise<FaceFrame> {
    const full = options.full ?? true
    const result = await detect(this.video, full)
    const faces = result.face.filter(face => face.score >= 0.5)
    if (faces.length === 0) return { problem: null, yaw: 0, pitch: 0, eyes: null, sample: null }
    if (faces.length > 1) return { problem: 'many', yaw: 0, pitch: 0, eyes: null, sample: null }
    return toFrame(faces[0], this.video.videoWidth || 640, full, options.frontalOnly ?? true)
  }
}

function toFrame(face: FaceResult, frameWidth: number, full: boolean, frontalOnly: boolean): FaceFrame {
  const angle = face.rotation?.angle
  // The preview is mirrored, so flip yaw to match what the user sees.
  const yaw = -(angle?.yaw ?? 0)
  const pitch = -(angle?.pitch ?? 0)
  const base = { yaw, pitch, eyes: eyeOpenness(face) }
  if (face.box[2] / frameWidth < MIN_FACE_WIDTH) return { ...base, problem: 'far', sample: null }
  if (frontalOnly && Math.hypot(yaw, pitch) > FRONTAL) return { ...base, problem: 'turned', sample: null }
  if (!full || !face.embedding || face.embedding.length < 64) return { ...base, problem: 'none', sample: null }
  return { ...base, problem: 'none', sample: { descriptor: Array.from(face.embedding), real: face.real ?? 0, live: face.live ?? 0 } }
}

export const frontal = (frame: FaceFrame) => Math.hypot(frame.yaw, frame.pitch) <= FRONTAL

function eyeOpenness(face: FaceResult): number | null {
  const mesh = face.mesh
  if (!mesh || mesh.length < 468) return null
  const gap = (a: number, b: number) => Math.hypot(mesh[a][0] - mesh[b][0], mesh[a][1] - mesh[b][1])
  const ratios = EYES.map(([outer, inner, upper, lower]) => gap(upper, lower) / Math.max(gap(outer, inner), 1e-3))
  return ratios.reduce((sum, value) => sum + value, 0) / ratios.length
}

/**
 * Watches eye openness for one blink: open, clearly closed, open again. A printed photo cannot
 * blink, so with the blink setting on a scan only counts once this has seen one.
 */
export class BlinkWatch {
  private open = 0
  private closed = false
  seen = false

  push(eyes: number | null): void {
    if (eyes === null || this.seen) return
    // Track the open level slowly so a squint does not reset it.
    if (eyes > this.open) this.open = eyes
    else this.open = this.open * 0.97 + eyes * 0.03
    if (this.open < 0.12) return
    if (!this.closed && eyes < this.open * 0.75) this.closed = true
    else if (this.closed && eyes > this.open * 0.9) this.seen = true
  }

  /** True while the eyes are near their open level: the frames worth matching. */
  eyesOpen(eyes: number | null): boolean {
    return eyes !== null && this.open >= 0.12 && eyes > this.open * 0.85
  }
}
