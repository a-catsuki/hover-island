// Face unlock models, served from the app so they work offline. Only the ones the ambient page loads.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MODEL_DIR = 'node_modules/@vladmandic/human/models'
const MODELS = ['blazeface', 'facemesh', 'faceres', 'antispoof', 'liveness'].flatMap(name => [`${name}.json`, `${name}.bin`])
const WASM_DIR = 'node_modules/@tensorflow/tfjs-backend-wasm/dist'
const WASM_FILES = ['tfjs-backend-wasm.wasm', 'tfjs-backend-wasm-simd.wasm', 'tfjs-backend-wasm-threaded-simd.wasm']
/** Human's own warmup face, served as a file: its built-in warmup fetches a data: URL, which the app's CSP blocks. */
const WARMUP = 'warmup.jpg'

function warmupImage() {
  const source = readFileSync('node_modules/@vladmandic/human/src/sample.ts', 'utf8')
  const base64 = source.match(/export const face: string = `([^`]+)`/)?.[1]
  if (!base64) throw new Error('face-models: Human warmup face not found')
  return Buffer.from(base64.replace(/\s+/g, ''), 'base64')
}

/** Vite plugin: serves the models at /models/face/ in dev and copies them into the build. */
export default function faceModels() {
  return {
    name: 'face-models',
    configureServer(server) {
      server.middlewares.use('/models/face', (req, res, next) => {
        const file = (req.url ?? '').split('?')[0].replace(/^\//, '')
        if (file === WARMUP) {
          res.setHeader('Content-Type', 'image/jpeg')
          return res.end(warmupImage())
        }
        if (WASM_FILES.includes(file)) {
          res.setHeader('Content-Type', 'application/wasm')
          return res.end(readFileSync(join(WASM_DIR, file)))
        }
        if (!MODELS.includes(file)) return next()
        res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream')
        res.end(readFileSync(join(MODEL_DIR, file)))
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: `models/face/${WARMUP}`, source: warmupImage() })
      for (const file of MODELS) {
        this.emitFile({ type: 'asset', fileName: `models/face/${file}`, source: readFileSync(join(MODEL_DIR, file)) })
      }
      for (const file of WASM_FILES) {
        this.emitFile({ type: 'asset', fileName: `models/face/${file}`, source: readFileSync(join(WASM_DIR, file)) })
      }
    },
  }
}
