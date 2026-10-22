// Actual production engine and local assets under the app's CSP. No webcam or owner data.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
const { chromium } = createRequire(import.meta.url)(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
const base = join(process.env.LOCALAPPDATA, 'ms-playwright')
const executablePath = existsSync(chromium.executablePath()) ? undefined : readdirSync(base).filter(n => /^chromium-\d+$/.test(n)).sort((a,b) => +b.split('-')[1] - +a.split('-')[1]).map(n => join(base,n,'chrome-win64/chrome.exe')).find(existsSync)
const csp = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).app.security.csp
const browser = await chromium.launch({ headless: true, executablePath, args: ['--disable-gpu'] })
try {
  const page = await browser.newPage()
  const external = []
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:1420/')) external.push(request.url()) })
  await page.route('**/ambient.html', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } })
  })
  await page.goto('http://127.0.0.1:1420/ambient.html', { waitUntil: 'domcontentloaded', timeout: 60000 })
  const result = await page.evaluate(async () => {
    const violations = []
    document.addEventListener('securitypolicyviolation', event => violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }))
    const { loadFaceEngine, FaceCamera } = await import('/src/ambient/face.ts')
    const start = performance.now()
    const human = await loadFaceEngine()
    const readyMs = Math.round(performance.now() - start)
    const image = new Image(); image.src = '/models/face/warmup.jpg'; await image.decode()
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480
    canvas.getContext('2d').drawImage(image,80,0,480,480)
    const frames = []
    for (let index = 0; index < 2; index++) {
      const start = performance.now()
      const reading = await human.detect(canvas)
      frames.push({ ms: Math.round(performance.now()-start), faces: reading.face.length, embedding: !!reading.face[0]?.embedding?.length, real: reading.face[0]?.real, live: reading.face[0]?.live, error: reading.error ?? null })
    }
    // Exercise the actual bounded capture + quick/full path with the public
    // sample as a synthetic video frame. No getUserMedia or owner data.
    const camera = new FaceCamera()
    Object.defineProperty(camera, 'video', { value: canvas })
    const scanFrames = []
    for (let index = 0; index < 2; index++) {
      const began = performance.now(), frame = await camera.read()
      scanFrames.push({ ms: Math.round(performance.now() - began), problem: frame.problem, descriptor: !!frame.sample?.descriptor.length, real: frame.sample?.real, live: frame.sample?.live })
    }
    camera.stop()
    const backend = human.tf.backend()
    const memory = { ...human.tf.memory(), wasmHeapBytes: backend.wasm?.HEAPU8?.byteLength ?? null }
    return { backend: human.tf.getBackend(), readyMs, frames, scanFrames, memory, violations }
  })
  assert.equal(result.backend, 'wasm')
  assert.ok(result.frames.every(frame => frame.faces === 1 && frame.embedding && !frame.error && frame.real >= .5 && frame.live >= .5))
  assert.ok(result.scanFrames.every(frame => frame.problem === 'none' && frame.descriptor && frame.real >= .5 && frame.live >= .5 && frame.ms < 1800))
  assert.deepEqual(result.violations, [])
  assert.deepEqual(external, [])
  const record = { boundary: 'Actual production engine with the exact app CSP, local WASM and public sample face in Chromium. No webcam, owner match or installed WebView2.', csp, ...result, externalRequests: external.length }
  await writeFile(process.env.FACE_CSP_RECORD ?? 'docs/verification/face-wasm-csp.json', JSON.stringify(record,null,2)+'\n')
  console.log(JSON.stringify(record,null,2))
} finally { await browser.close() }
