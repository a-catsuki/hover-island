// Real ambient UI with simulated camera/model/native responses. No webcam or enrollment data.
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH ?? join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
const base = join(process.env.LOCALAPPDATA, 'ms-playwright')
const executablePath = existsSync(chromium.executablePath()) ? undefined : readdirSync(base).filter(n => /^chromium-\d+$/.test(n)).sort((a,b) => +b.split('-')[1] - +a.split('-')[1]).map(n => join(base,n,'chrome-win64/chrome.exe')).find(existsSync)
const browser = await chromium.launch({ headless: true, executablePath })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = [], results = []
const pending = new Set()
await page.addInitScript(() => {
  window.facePhaseTimes = {}
  new MutationObserver(() => {
    const phase = document.querySelector('.island')?.className.match(/island--(idle|scanning|success|failed|hello)/)?.[1]
    if (phase && window.facePhaseTimes[phase] == null) window.facePhaseTimes[phase] = performance.now()
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] })
})
page.on('request', request => pending.add(new URL(request.url()).pathname))
page.on('requestfinished', request => pending.delete(new URL(request.url()).pathname))
page.on('requestfailed', request => pending.delete(new URL(request.url()).pathname))
page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message) })
page.on('console', message => { if (message.type() === 'error') console.error('Browser console:', message.text()) })
await page.route('**/src/ambient/face.ts*', route => route.fulfill({ contentType: 'application/javascript', body: `
export const faceBackend = () => 'wasm';
export const frontal = () => true;
export const loadFaceEngine = () => { window.modelLoads = (window.modelLoads || 0) + 1; return window.faceMode === 'models-hang' ? new Promise(() => {}) : Promise.resolve(); };
export class BlinkWatch { seen = false; push() {} eyesOpen() { return true; } }
export class FaceCamera {
  running = false;
  start() { window.cameraStarts = (window.cameraStarts || 0) + 1; if (window.faceMode === 'camera-hang') return new Promise(() => {}); this.running = true; return Promise.resolve(); }
  stop() { this.running = false; window.cameraStops = (window.cameraStops || 0) + 1; }
  async read() {
    window.frameReads = (window.frameReads || 0) + 1;
    if (window.faceMode === 'frame-hang') return new Promise(resolve => { window.finishFrame = resolve; });
    return { problem: 'none', eyes: .3, sample: { descriptor: Array(128).fill(.1), real: .9, live: .9 } };
  }
}` }))
await page.route('**/src/lib/preview.ts*', async route => {
  const response = await route.fetch()
  const source = (await response.text())
    .replace(/case ['"]face_verify['"]:[\s\S]*?break;/, `case "face_verify":
      (window.verifyCalls ||= []).push({count: args.samples.length, blinked: args.blinked, last: args.last, deadlineMs: args.deadlineMs});
      result = {verdict: window.faceMode === 'mismatch' ? 'noMatch' : 'match', score: .9, real: .9, live: .9}; break;`)
    .replace(/case ['"]ambient_unlock['"]:[\s\S]*?break;/, `case "ambient_unlock": window.helloCalls = (window.helloCalls || 0) + 1; result = 'cancelled'; break;`)
  await route.fulfill({ response, body: source })
})
const show = async mode => {
  await page.evaluate(mode => {
    window.faceMode = mode; window.verifyCalls = []; window.frameReads = 0;
    window.facePhaseTimes = {};
    window.dispatchEvent(new CustomEvent('ambient://hidden'));
    window.dispatchEvent(new CustomEvent('ambient://shown'));
  }, mode)
  await page.waitForTimeout(1550) // The click that opened ambient must not unlock it.
  const start = Date.now()
  await page.keyboard.press('Space')
  return start
}
try {
  await page.goto(process.env.UI_URL ?? 'http://127.0.0.1:1420/ambient.html?face=match', { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.locator('.ambient--ready').waitFor()
  await page.waitForFunction(() => (window.cameraStarts || 0) > 0)
  assert.ok(await page.getByText('Face ID', { exact: true }).first().isVisible())
  assert.ok(await page.locator('.unlock-hint').isVisible())
  assert.match(await page.locator('.unlock-hint').innerText(), /Any key.*to unlock with Face ID/s)
  await page.screenshot({ path: 'docs/verification/face-id-idle.png' })
  results.push({ flow: 'Face ID and a persistent key-to-unlock hint are visible before scanning' })
  results.push({ flow: 'Camera readiness starts as soon as enrolled ambient becomes visible, before unlock input' })
  const first = await show('match')
  await page.locator('.island--success').waitFor()
  const matchMs = Date.now() - first
  assert.ok(matchMs < 750, `fixture first-frame match took ${matchMs} ms`)
  assert.equal(await page.evaluate(() => window.frameReads), 1)
  assert.equal(await page.evaluate(() => window.verifyCalls[0].count), 1)
  assert.ok(await page.locator('.ambient--unlocking').count())
  results.push({ flow: 'First good frame unlocks without waiting for a second frame', fixtureMs: matchMs })
  for (const mode of ['camera-hang', 'models-hang', 'frame-hang']) {
    const started = await show(mode)
    await page.locator('.island--scanning').waitFor()
    assert.equal(await page.locator('.face-glyph--scanning .face-glyph__face').evaluate(node => getComputedStyle(node).opacity), '1')
    if (mode === 'frame-hang') await page.screenshot({ path: 'docs/verification/face-id-scanning.png' })
    await page.getByText(mode === 'camera-hang' ? 'Camera is getting ready' : 'Face scan took too long', { exact: true }).waitFor()
    const ms = await page.evaluate(() => window.facePhaseTimes.failed - window.facePhaseTimes.scanning)
    assert.ok(ms < 3200 && ms >= 2400, `${mode}: ${ms} ms`)
    assert.ok(await page.getByRole('button', { name: 'Use PIN', exact: true }).isVisible())
    assert.equal(await page.evaluate(() => window.verifyCalls.length), 0)
    results.push({ flow: `${mode} reaches PIN fallback`, fixtureMs: ms })
  }
  const mismatch = await show('mismatch')
  await page.getByText('Not Recognized', { exact: true }).waitFor()
  assert.ok(Date.now() - mismatch < 750)
  assert.equal(await page.evaluate(() => window.verifyCalls.filter(x => x.last).length), 1)
  results.push({ flow: 'A clear mismatch finishes promptly with one counted final check' })
  await show('frame-hang')
  await page.getByRole('button', { name: 'Use PIN', exact: true }).click()
  await page.locator('.island--idle').waitFor()
  await page.evaluate(() => window.finishFrame?.({ problem: 'none', eyes: .3, sample: { descriptor: Array(128).fill(.1), real: .9, live: .9 } }))
  await page.waitForTimeout(120)
  assert.equal(await page.evaluate(() => window.verifyCalls.length), 0, 'late frame after PIN never reaches native verification')
  results.push({ flow: 'PIN is available while scanning and cancels a late face result' })
  await show('frame-hang')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('ambient://hidden')))
  const stops = await page.evaluate(() => window.cameraStops)
  await page.evaluate(() => window.finishFrame?.({ problem: 'none', eyes: .3, sample: { descriptor: Array(128).fill(.1), real: .9, live: .9 } }))
  await page.waitForTimeout(120)
  assert.equal(await page.evaluate(() => window.verifyCalls.length), 0)
  assert.ok(stops > 0)
  results.push({ flow: 'Hiding a warm ambient page stops the camera and discards an in-flight scan' })
  await show('match')
  await page.locator('.island--success').waitFor()
  assert.equal(await page.evaluate(() => window.frameReads), 1)
  results.push({ flow: 'A reused warm page unlocks again after cancellation' })
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('ambient://hidden'))
    window.dispatchEvent(new CustomEvent('ambient://shown'))
  })
  await page.waitForTimeout(100)
  assert.equal(await page.locator('.ambient--unlocking').count(), 0)
  for (const scene of ['aurora', 'stars', 'artwork', 'ripples', 'black']) {
    await page.evaluate(async scene => {
      const { patchSettings, settings } = await import('/src/state/settings.ts')
      patchSettings({ ambient: { ...settings.ambient, scene } })
    }, scene)
    await page.locator(`.ambient--scene-${scene}`).waitFor()
    assert.equal(await page.locator('.ambient__canvas').count(), ['stars', 'ripples'].includes(scene) ? 1 : 0)
  }
  for (const clockStyle of ['classic', 'stacked', 'analog', 'words']) {
    await page.evaluate(async clockStyle => {
      const { patchSettings, settings } = await import('/src/state/settings.ts')
      patchSettings({ ambient: { ...settings.ambient, clockStyle } })
    }, clockStyle)
    await page.locator(`.ambient--clock-${clockStyle}`).waitFor()
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(async () => {
    const { patchSettings, settings } = await import('/src/state/settings.ts')
    patchSettings({ ambient: { ...settings.ambient, scene: 'stars', clockStyle: 'classic' } })
  })
  await page.waitForTimeout(100)
  const still = await page.locator('.ambient__canvas').evaluate(node => node.toDataURL())
  await page.waitForTimeout(150)
  assert.equal(await page.locator('.ambient__canvas').evaluate(node => node.toDataURL()), still, 'reduced motion keeps the canvas still')
  results.push({ flow: 'All five scenes and four clocks render; reduced motion stops canvas animation' })
  await page.screenshot({ path: 'docs/verification/instant-unlock-ambient.png' })
  await page.evaluate(async () => {
    const { patchSettings, settings, flushSettings } = await import('/src/state/settings.ts')
    patchSettings({ ambient: { ...settings.ambient, faceCameraReady: true } })
    await flushSettings()
  })
  await page.route('**/src/lib/preview.ts*', async route => {
    const response = await route.fetch()
    const source = (await response.text()).replace(/case ['"]ambient_mode['"]:[\s\S]*?break;/, 'case "ambient_mode": result = "prewarm"; break;')
    await route.fulfill({ response, body: source })
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window.modelLoads || 0) > 0)
  assert.equal(await page.evaluate(() => window.cameraStarts || 0), 0, 'prewarm must never switch the webcam on, even with keep-ready enabled')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('ambient://shown')))
  await page.waitForFunction(() => (window.cameraStarts || 0) > 0)
  const beforeHide = await page.evaluate(() => window.cameraStops || 0)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('ambient://hidden')))
  assert.ok(await page.evaluate(() => window.cameraStops || 0) > beforeHide)
  results.push({ flow: 'Hidden prewarm loads models without the webcam; keep-ready opens only when shown and stops on hide' })
  assert.deepEqual(errors, [])
  await writeFile(process.env.FACE_SMOKE_RECORD ?? 'docs/verification/instant-unlock-smoke.json', JSON.stringify({ boundary: 'Actual Solid ambient UI, simulated camera/models/native responses. Does not measure physical webcam recognition.', results, errors }, null, 2) + '\n')
  console.log(JSON.stringify(results, null, 2))
} catch (error) { console.error('Pending UI requests:', [...pending]); throw error }
finally { await browser.close() }
