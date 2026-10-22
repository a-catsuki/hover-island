import type { Config, FaceResult, Human, Result } from '@vladmandic/human'
import type { FaceSample } from '../lib/ipc'

/** Offline face models use SIMD WebAssembly, avoiding WebGL shader compilation on the unlock path. */

const CAMERA = { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } as const
/** Head turned further than this (radians) is too far off-axis for a reliable descriptor. */
const FRONTAL = 0.32
/** A face narrower than this share of the frame is too far away to trust. */
const MIN_FACE_WIDTH = 0.18
/** Face mesh points (MediaPipe numbering): eye corners, then upper and lower lid, for each eye. */
const EYES = [[33, 133, 159, 145], [362, 263, 386, 374]] as const
/** Bound an ordinary inference without restarting a still-busy TensorFlow operation. */
const FRAME_TIMEOUT_MS = 1800
/** A bounded preparation pass on the accelerated CPU. */
const FIRST_FRAME_TIMEOUT_MS = 3_000
let framesDone = 0

// Every frame must be scored afresh: cached results would let one good frame vouch for later ones.
const CONFIG: Partial<Config> = {
  modelBasePath: '/models/face/',
  wasmPath: '/models/face/',
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
/** A timeout cannot cancel TensorFlow. Never start another detection on a busy engine. */
let detecting = false

const timeout = <T,>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })

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
    detecting = true
    const pending = Promise.resolve().then(() => human.detect(canvas, FULL))
    void pending.finally(() => { detecting = false }).catch(() => {})
    await timeout(pending, FIRST_FRAME_TIMEOUT_MS, 'Face models')
    framesDone = 3
  } catch (error) {
    // Only a speed-up; the first real frame compiles whatever is left.
    console.warn('Face unlock: warmup failed', error)
  }
}

async function createEngine(): Promise<Human> {
  const { Human } = await import('@vladmandic/human')
  const human = new Human({ ...CONFIG, backend: 'wasm' })
  await human.load()
  await timeout(human.tf.ready(), FRAME_TIMEOUT_MS, 'Face models')
  await warmUp(human)
  return human
}

/** SIMD WASM only. An unavailable engine offers PIN rather than allocating a second GPU engine. */
export function loadFaceEngine(): Promise<Human> {
  engine ??= createEngine().catch(error => { engine = null; throw error })
  return engine
}

/** The backend in use, for the status line. */
export const faceBackend = () => 'wasm' as const

/** One detection. Never run a second operation on a still-busy engine after a timeout. */
async function detect(input: HTMLCanvasElement, full: boolean): Promise<Result> {
  const human = await loadFaceEngine()
  if (detecting) throw new Error('Face detection is still finishing')
  detecting = true
  const pending = Promise.resolve().then(() => human.detect(input, full ? FULL : QUICK))
  void pending.finally(() => { detecting = false }).catch(() => {})
  const limit = framesDone < 3 ? FIRST_FRAME_TIMEOUT_MS : FRAME_TIMEOUT_MS
  const result = await timeout(pending, limit, 'Face detection')
  framesDone++
  // A soft error, such as the video not being ready yet; the next frame may be fine.
  if (result.error) throw new Error(result.error)
  return result
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
  private cancelFrameWait: (() => void) | null = null
  private frameCanvas: HTMLCanvasElement | null = null
  private frameContext: CanvasRenderingContext2D | null = null
  private reading = false

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
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer)
          this.video.removeEventListener('loadeddata', ready)
          if (this.cancelFrameWait === cancel) this.cancelFrameWait = null
          if (error) reject(error); else resolve()
        }
        const ready = () => finish()
        const cancel = () => finish(new Error('Camera start cancelled'))
        const timer = setTimeout(() => finish(new Error('Camera timed out')), 2500)
        this.cancelFrameWait = cancel
        this.video.addEventListener('loadeddata', ready, { once: true })
        if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) ready()
      })
    }
    if (generation !== this.generation) throw new Error('Camera start cancelled')
    // Stopped while starting: make sure the light goes off.
    if (this.stream !== stream) stream.getTracks().forEach(track => track.stop())
  }

  /** Turns the camera (and its light) off straight away. */
  stop(): void {
    this.generation++
    this.starting = null
    this.cancelFrameWait?.()
    this.stream?.getTracks().forEach(track => track.stop())
    this.stream = null
    this.video.srcObject = null
    if (this.frameCanvas) this.frameCanvas.width = this.frameCanvas.height = 0
    this.frameCanvas = null
    this.frameContext = null
  }

  /**
   * Reads one frame. A quick read finds the face, pose and eyes; a full read also runs the
   * identity, anti-spoof and liveness models. Throws when detection itself fails.
   */
  async read(options: { full?: boolean; frontalOnly?: boolean } = {}): Promise<FaceFrame> {
    // A timed-out inference may still own the capture canvas. Never overwrite
    // its pixels while TensorFlow is reading them, including on a quick retry.
    if (this.reading || detecting) throw new Error('Face detection is still finishing')
    this.reading = true
    try {
      const full = options.full ?? true
      // Fix one frame for both passes. A high-resolution or virtual camera must
      // never turn fromPixels into a monitor-sized tensor allocation.
      const sourceWidth = this.video.videoWidth || 640, sourceHeight = this.video.videoHeight || 480
      const scale = Math.min(1, 640 / sourceWidth, 480 / sourceHeight)
      const width = Math.max(1, Math.floor(sourceWidth * scale)), height = Math.max(1, Math.floor(sourceHeight * scale))
      this.frameCanvas ??= document.createElement('canvas')
      const input = this.frameCanvas
      if (input.width !== width || input.height !== height) { input.width = width; input.height = height }
      this.frameContext ??= input.getContext('2d', { willReadFrequently: true, alpha: false })
      if (!this.frameContext) throw new Error('Camera frame unavailable')
      this.frameContext.drawImage(this.video, 0, 0, width, height)
      const quick = await detect(input, false)
      let faces = quick.face.filter(face => face.score >= 0.5)
      if (faces.length === 0) return { problem: null, yaw: 0, pitch: 0, eyes: null, sample: null }
      if (faces.length > 1) return { problem: 'many', yaw: 0, pitch: 0, eyes: null, sample: null }
      const located = toFrame(faces[0], width, false, options.frontalOnly ?? true)
      if (!full || located.problem !== 'none') return located
      // Reject empty, distant, turned or multiple faces before allocating the
      // description/anti-spoof/liveness pipelines. Full scoring uses this exact image.
      const result = await detect(input, true)
      faces = result.face.filter(face => face.score >= 0.5)
      if (faces.length === 0) return { problem: null, yaw: 0, pitch: 0, eyes: null, sample: null }
      if (faces.length > 1) return { problem: 'many', yaw: 0, pitch: 0, eyes: null, sample: null }
      return toFrame(faces[0], width, true, options.frontalOnly ?? true)
    } finally {
      this.reading = false
    }
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
