// Hardware timing only. Camera frames and user descriptors are never saved or logged.
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
const { chromium } = createRequire(import.meta.url)(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
const base = join(process.env.LOCALAPPDATA, 'ms-playwright')
const executablePath = existsSync(chromium.executablePath()) ? undefined : readdirSync(base).filter(n => /^chromium-\d+$/.test(n)).sort((a,b) => +b.split('-')[1] - +a.split('-')[1]).map(n => join(base,n,'chrome-win64/chrome.exe')).find(existsSync)
const browser = await chromium.launch({ headless: true, executablePath })
const results = { boundary: 'Real HP webcam startup; real inference on the public Human warmup face in Chromium, not owner matching or the installed WebView2.', camera: [], engines: [] }
try {
  if (!process.env.SKIP_CAMERA) {
    const context = await browser.newContext({ permissions: ['camera'] })
    const page = await context.newPage()
    await page.goto('http://127.0.0.1:1420/ambient.html', { waitUntil: 'domcontentloaded', timeout: 60000 })
    results.camera = await page.evaluate(async () => {
      const { FaceCamera } = await import('/src/ambient/face.ts')
      const camera = new FaceCamera()
      const times = []
      for (let index = 0; index < 2; index++) {
        const start = performance.now()
        try {
          await Promise.race([camera.start(), new Promise((_, reject) => setTimeout(() => reject(new Error('camera startup exceeded 10 seconds')), 10000))])
          const readyMs = performance.now() - start
          const warm = performance.now()
          await camera.start()
          times.push({ coldMs: Math.round(readyMs), readyMs: Math.round(performance.now() - warm), width: camera.video.videoWidth, height: camera.video.videoHeight })
        } catch (error) { times.push({ error: String(error) }) }
        finally { camera.stop() }
      }
      return times
    })
    console.log('Camera timing:', JSON.stringify(results.camera))
    await context.close()
  }
  for (const backend of ['webgl', 'wasm']) {
    const context = await browser.newContext()
    const page = await context.newPage()
    page.on('console', message => { if (message.type() === 'error') console.error(backend, message.text().slice(0,300)) })
    await page.goto('http://127.0.0.1:1420/ambient.html', { waitUntil: 'domcontentloaded', timeout: 60000 })
    const result = await page.evaluate(async backend => {
      const { Human } = await import('/node_modules/.vite/deps/@vladmandic_human.js')
      const start = performance.now()
      const human = new Human({ backend, wasmPath: '/models/face/', cacheSensitivity: 0, warmup: 'none', debug: false, modelBasePath: '/models/face/', filter: { enabled: false },
        face: { enabled: true, detector: { rotation: true, maxDetected: 2, skipFrames: 0, skipTime: 0, minConfidence: .5, return: false }, mesh: { enabled: true }, iris: { enabled: false }, attention: { enabled: false }, emotion: { enabled: false }, description: { enabled: true, skipFrames: 0, skipTime: 0 }, antispoof: { enabled: true, skipFrames: 0, skipTime: 0 }, liveness: { enabled: true, skipFrames: 0, skipTime: 0 } },
        body: { enabled: false }, hand: { enabled: false }, object: { enabled: false }, gesture: { enabled: false }, segmentation: { enabled: false } })
      try {
        await human.load()
        const loadMs = performance.now() - start
        const image = new Image(); image.src = '/models/face/warmup.jpg'; await image.decode()
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480
        canvas.getContext('2d').drawImage(image,80,0,480,480)
        const frames = []
        for (let index = 0; index < 4; index++) {
          const begun = performance.now()
          const result = await human.detect(canvas)
          frames.push({ ms: Math.round(performance.now() - begun), faces: result.face.length, sample: !!result.face[0]?.embedding?.length, real: result.face[0]?.real, live: result.face[0]?.live, error: result.error ?? null, models: { ...result.performance } })
        }
        return { backend, actualBackend: human.tf.getBackend(), tfjs: human.tf.version.tfjs, loadMs: Math.round(loadMs), frames }
      } catch (error) { return { backend, error: String(error) } }
    }, backend)
    results.engines.push(result)
    console.log('Engine timing:', JSON.stringify(result))
    await context.close()
  }
  await writeFile('docs/verification/face-engine-benchmark.json', JSON.stringify(results, null, 2) + '\n')
} finally { await browser.close() }
