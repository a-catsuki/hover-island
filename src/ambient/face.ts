import type { Config, FaceResult, Human } from '@vladmandic/human'
import type { FaceSample } from '../lib/ipc'

/** Face models run in this page on the GPU, offline. Only descriptors reach native code, which matches them. */

const CAMERA = { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } as const
/** Head turned further than this (radians) is too far off-axis for a reliable descriptor. */
const FRONTAL = 0.32
/** A face narrower than this share of the frame is too far away to trust. */
const MIN_FACE_WIDTH = 0.18
/** Face mesh points (MediaPipe numbering): eye corners, then upper and lower lid, for each eye. */
const EYES = [[33, 133, 159, 145], [362, 263, 386, 374]] as const

// Every frame must be scored afresh: cached results would let one good frame vouch for later ones.
const CONFIG: Partial<Config> = {
  backend: 'webgl',
  modelBasePath: '/models/face/',
  debug: false,
  cacheSensitivity: 0,
  warmup: 'none',
  filter: { enabled: true, equalization: true },
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

let engine: Promise<Human> | null = null

/** Loads the models once. Safe to call early to hide the first-scan delay. */
export function loadFaceEngine(): Promise<Human> {
  engine ??= import('@vladmandic/human').then(async ({ Human }) => {
    const human = new Human(CONFIG)
    await human.load()
    // Compiles the detector's GPU shaders now, so the first real scan starts faster. Human's own
    // warmup fetches a data: URL, which the app's content security policy blocks.
    const blank = document.createElement('canvas')
    blank.width = blank.height = 128
    await human.detect(blank)
    return human
  }).catch(error => { engine = null; throw error })
  return engine
}

export interface FaceFrame {
  /** Why this frame cannot be used, if it cannot. */
  problem: 'none' | 'many' | 'far' | 'turned' | null
  /** Head direction, radians: positive yaw is toward the mirrored preview's right, positive pitch is up. */
  yaw: number
  pitch: number
  /** Eye openness: lid gap over eye width, averaged over both eyes. Drops sharply in a blink. */
  eyes: number | null
  sample: FaceSample | null
}

export class FaceCamera {
  readonly video = document.createElement('video')
  private stream: MediaStream | null = null

  async start(): Promise<void> {
    this.video.muted = true
    this.video.playsInline = true
    this.stream = await navigator.mediaDevices.getUserMedia({ video: CAMERA, audio: false })
    this.video.srcObject = this.stream
    await this.video.play()
  }

  /** Turns the camera (and its light) off straight away. */
  stop(): void {
    this.stream?.getTracks().forEach(track => track.stop())
    this.stream = null
    this.video.srcObject = null
  }

  async read(human: Human, frontalOnly = true): Promise<FaceFrame> {
    const result = await human.detect(this.video)
    const faces = result.face.filter(face => face.score >= 0.5)
    if (faces.length === 0) return { problem: null, yaw: 0, pitch: 0, eyes: null, sample: null }
    if (faces.length > 1) return { problem: 'many', yaw: 0, pitch: 0, eyes: null, sample: null }
    return toFrame(faces[0], this.video.videoWidth || 640, frontalOnly)
  }
}

function toFrame(face: FaceResult, frameWidth: number, frontalOnly: boolean): FaceFrame {
  const angle = face.rotation?.angle
  // The preview is mirrored, so flip yaw to match what the user sees.
  const yaw = -(angle?.yaw ?? 0)
  const pitch = -(angle?.pitch ?? 0)
  const base = { yaw, pitch, eyes: eyeOpenness(face) }
  if (face.box[2] / frameWidth < MIN_FACE_WIDTH) return { ...base, problem: 'far', sample: null }
  if (!face.embedding || face.embedding.length < 64) return { ...base, problem: 'none', sample: null }
  if (frontalOnly && Math.hypot(yaw, pitch) > FRONTAL) return { ...base, problem: 'turned', sample: null }
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
 * blink, so a scan only counts once this has seen one.
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
