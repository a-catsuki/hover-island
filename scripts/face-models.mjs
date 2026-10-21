// Face unlock models, served from the app so they work offline. Only the ones the ambient page loads.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MODEL_DIR = 'node_modules/@vladmandic/human/models'
const MODELS = ['blazeface', 'facemesh', 'faceres', 'antispoof', 'liveness'].flatMap(name => [`${name}.json`, `${name}.bin`])

/** Vite plugin: serves the models at /models/face/ in dev and copies them into the build. */
export default function faceModels() {
  return {
    name: 'face-models',
    configureServer(server) {
      server.middlewares.use('/models/face', (req, res, next) => {
        const file = (req.url ?? '').split('?')[0].replace(/^\//, '')
        if (!MODELS.includes(file)) return next()
        res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream')
        res.end(readFileSync(join(MODEL_DIR, file)))
      })
    },
    generateBundle() {
      for (const file of MODELS) {
        this.emitFile({ type: 'asset', fileName: `models/face/${file}`, source: readFileSync(join(MODEL_DIR, file)) })
      }
    },
  }
}
