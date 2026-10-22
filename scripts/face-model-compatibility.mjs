// Compare the same public sample across backends. Never persist or log descriptors.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
const { chromium } = createRequire(import.meta.url)(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
const base = join(process.env.LOCALAPPDATA, 'ms-playwright')
const executablePath = existsSync(chromium.executablePath()) ? undefined : readdirSync(base).filter(n => /^chromium-\d+$/.test(n)).sort((a,b) => +b.split('-')[1] - +a.split('-')[1]).map(n => join(base,n,'chrome-win64/chrome.exe')).find(existsSync)
const browser = await chromium.launch({ headless: true, executablePath })
const descriptors = []
try {
  for (const backend of ['webgl','wasm']) {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto('http://127.0.0.1:1420/ambient.html', { waitUntil: 'domcontentloaded' })
    const descriptor = await page.evaluate(async backend => {
      const { Human } = await import('/node_modules/.vite/deps/@vladmandic_human.js')
      const human = new Human({ backend, wasmPath: '/models/face/', modelBasePath: '/models/face/', warmup: 'none', cacheSensitivity: 0, filter: { enabled: false },
        face: { enabled: true, detector: { rotation: true, maxDetected: 2, skipFrames: 0, skipTime: 0, minConfidence: .5, return: false }, mesh: { enabled: true }, iris: { enabled: false }, attention: { enabled: false }, emotion: { enabled: false }, description: { enabled: true, skipFrames: 0, skipTime: 0 }, antispoof: { enabled: true, skipFrames: 0, skipTime: 0 }, liveness: { enabled: true, skipFrames: 0, skipTime: 0 } },
        body: { enabled: false }, hand: { enabled: false }, object: { enabled: false }, gesture: { enabled: false }, segmentation: { enabled: false } })
      await human.load()
      const image = new Image(); image.src = '/models/face/warmup.jpg'; await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480
      canvas.getContext('2d').drawImage(image,80,0,480,480)
      const result = await human.detect(canvas)
      if (result.face.length !== 1 || !result.face[0].embedding?.length) throw new Error(`${backend} did not produce a descriptor`)
      return result.face[0].embedding
    },backend)
    descriptors.push(descriptor)
    await context.close()
  }
  const [a,b] = descriptors
  assert.equal(a.length,b.length)
  const sum = a.reduce((sum,value,index) => sum + (value-b[index]) ** 2,0)
  const distance = Math.round(2500 * sum) / 100
  const similarity = distance === 0 ? 1 : Math.max(0,Math.min(1,(1-Math.sqrt(distance)/100-.2)/.6))
  assert.ok(similarity >= .58,`Cross-backend public sample similarity below native single-frame threshold: ${similarity}`)
  const record = { boundary: 'Same public Human face across WebGL and WASM in Chromium, scored with the native similarity formula. Checks embedding compatibility, not owner enrollment accuracy.', descriptorDimensions: a.length, similarity, singleFrameThreshold: .58, compatible: true }
  await writeFile('docs/verification/face-model-compatibility.json',JSON.stringify(record,null,2)+'\n')
  console.log(JSON.stringify(record,null,2))
} finally {
  descriptors.forEach(descriptor => descriptor.fill(0))
  await browser.close()
}
