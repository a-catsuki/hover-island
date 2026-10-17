import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH ?? join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
let executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH
if (!executablePath && !existsSync(chromium.executablePath())) {
  const base = join(process.env.LOCALAPPDATA, 'ms-playwright')
  executablePath = readdirSync(base).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .map(name => join(base, name, 'chrome-win64', 'chrome.exe')).find(existsSync)
}

const outDir = fileURLToPath(new URL('./', import.meta.url))
const nativeCapture = process.env.WASAPI_BANDS_JSON
  ? JSON.parse(await readFile(process.env.WASAPI_BANDS_JSON, 'utf8'))
  : null
if (nativeCapture && (nativeCapture.packets < 1 || !Array.isArray(nativeCapture.bands) || nativeCapture.bands.length !== 24)) {
  throw new Error('WASAPI capture file must contain packets and the native 24-band payload')
}
const browser = await chromium.launch({ headless: true, executablePath })
const context = await browser.newContext({ viewport: { width: 1420, height: 920 }, reducedMotion: 'reduce' })
const page = await context.newPage()
page.setDefaultTimeout(20000)
const errors = []
page.on('pageerror', error => errors.push(error.message))

try {
  // Browser preview cannot open WASAPI. Keep its registered event callback in
  // place after that expected start failure so injected native-shape events can
  // exercise the real audio state -> canvas renderer path.
  await page.addInitScript(() => {
    const remove = window.removeEventListener
    window.removeEventListener = function(type, listener, options) {
      if (type === 'audio://spectrum') return
      return remove.call(this, type, listener, options)
    }
  })
  await page.goto(process.env.UI_URL ?? 'http://127.0.0.1:1420/', { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.locator('[data-widget-kind="media"] .viz__canvas').waitFor()
  const skipTour = page.getByRole('button', { name: 'Skip', exact: true })
  if (await skipTour.count()) await skipTour.click()
  await page.getByRole('dialog').waitFor({ state: 'detached' }).catch(() => {})
  await page.waitForTimeout(120)

  // Exercise the actual no-SMTC/empty-media fallback: the system output capture
  // must remain mounted even when Windows has no title or playback session.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('media://changed', { detail: null })))
  await page.locator('[data-widget-kind="media"] .media__empty-tile .viz__canvas').waitFor()

  const sample = async bands => page.evaluate(async bands => {
    window.dispatchEvent(new CustomEvent('audio://spectrum', { detail: { bands } }))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = document.querySelector('[data-widget-kind="media"] .viz__canvas')
    if (!canvas?.width || !canvas.height) throw new Error('Visualizer canvas has no pixels')
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let hash = 2166136261
    let rgbTotal = 0
    for (let i = 0; i < pixels.length; i++) {
      hash ^= pixels[i]
      hash = Math.imul(hash, 16777619)
      if (i % 4 !== 3) rgbTotal += pixels[i]
    }
    return {
      hash: (hash >>> 0).toString(16).padStart(8, '0'),
      pixelCount: pixels.length / 4,
      meanRgb: Number((rgbTotal / (pixels.length * 3 / 4)).toFixed(3)),
      mode: document.querySelector('[data-widget-kind="media"] .media__viz-mode')?.textContent?.trim() ?? null,
    }
  }, bands)
  const screenshot = async name => page.screenshot({ path: join(outDir, name), fullPage: false })

  const zeroInitial = await sample(Array(24).fill(0))
  const quiet = await sample(Array(24).fill(0.00598))
  await screenshot('visualizer-live-quiet.png')
  const louder = await sample(Array(24).fill(0.026))
  await screenshot('visualizer-live-louder.png')
  const isolated = await sample([0.8, ...Array(23).fill(0)])
  const zeroAfterNoise = await sample(Array(24).fill(0))
  const captured = nativeCapture ? await sample(nativeCapture.bands) : null
  if (captured) {
    assert.notEqual(captured.hash, zeroAfterNoise.hash, 'captured WASAPI bands must visibly change the mounted renderer')
    assert.notEqual(captured.mode, 'Synthetic preview', 'captured native-shaped bands must not enable synthetic preview')
    await screenshot('visualizer-live-captured.png')
  }
  assert.notEqual(quiet.hash, zeroInitial.hash, 'quiet broadband audio should change the rendered pixels')
  assert.notEqual(louder.hash, quiet.hash, 'louder broadband audio should produce a distinct rendered response')
  assert.ok(louder.meanRgb > quiet.meanRgb, 'louder broadband audio should visibly increase canvas brightness')
  assert.equal(isolated.hash, zeroAfterNoise.hash, 'single-bin input should return to the stable idle/silence rendering')
  assert.ok(![zeroInitial, quiet, louder, isolated, zeroAfterNoise].some(frame => frame.mode === 'Synthetic preview'), 'synthetic preview must stay disabled')

  const styleIds = await page.locator('[data-widget-kind="media"] .media__viz-select option').evaluateAll(options =>
    options.map(option => option.value).filter(value => value !== 'off'))
  const styleFrames = {}
  for (const id of styleIds) {
    await page.locator('[data-widget-kind="media"] .media__viz-select').selectOption(id)
    const silent = await sample(Array(24).fill(0))
    const live = await sample(Array.from({ length: 24 }, (_, index) => 0.006 + index * 0.0007))
    assert.notEqual(live.hash, silent.hash, `${id} should respond to the measured spectrum instead of idle animation`)
    styleFrames[id] = { silentHash: silent.hash, liveHash: live.hash, liveMeanRgb: live.meanRgb }
    await screenshot(`visualizer-style-${id}.png`)
  }

  const fixture = await page.evaluate(async () => {
    const harness = await import('/docs/verification/file-drop-toast-harness.tsx')
    const root = document.createElement('div')
    document.body.append(root)
    const mounted = harness.mountFileDropToast(root)
    const inspect = () => {
      const toast = root.querySelector('[role="status"]')
      const progress = root.querySelector('progress')
      return {
        label: toast?.getAttribute('aria-label'),
        text: toast?.textContent?.replace(/\s+/g, ' ').trim(),
        targetCount: root.querySelectorAll('[data-drop-target]').length,
        progressHasValue: progress?.hasAttribute('value') ?? false,
        progressValue: progress?.value ?? null,
        indeterminate: progress?.position === -1,
      }
    }
    mounted.setState({ count: 2, target: 'beam', edge: 'top', mode: 'notch', phase: 'pending', message: 'Adding to Beam' })
    const pending = inspect()
    mounted.setState({ count: 2, target: 'beam', edge: 'top', mode: 'notch', phase: 'complete', message: 'Added to Beam' })
    const complete = inspect()
    mounted.setState({ count: 2, target: 'beam', edge: 'top', mode: 'notch', phase: 'error', message: 'Could not add files', progress: 0.4 })
    const error = inspect()
    mounted.dispose()
    root.remove()
    return { pending, complete, error }
  })
  assert.equal(fixture.pending.targetCount, 0, 'pending action should not show the two drag destinations')
  assert.equal(fixture.pending.progressHasValue, false, 'pending work without a known fraction should be indeterminate')
  assert.equal(fixture.pending.indeterminate, true)
  assert.equal(fixture.complete.targetCount, 0)
  assert.equal(fixture.complete.progressValue, 1, 'completion should fill progress')
  assert.equal(fixture.error.targetCount, 0)
  assert.equal(fixture.error.progressValue, 0.4, 'an error can retain known partial progress')
  assert.deepEqual(errors, [])

  const ambient = await page.evaluate(async () => {
    const metrics = await import('/src/lib/audioMetrics.ts')
    const palette = await import('/src/lib/albumPalette.ts')
    const quietEnergy = metrics.audioMetrics(Array(24).fill(0.00598)).energy
    const loudEnergy = metrics.audioMetrics(Array(24).fill(0.026)).energy
    const dynamics = metrics.createAudioDynamics()
    for (let i = 0; i < 40; i++) dynamics.update(Array(24).fill(0.006), true, 1 / 30)
    const kick = dynamics.update([...Array(7).fill(0.16), ...Array(17).fill(0.006)], true, 1 / 30)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="4" height="8" fill="#1c376e"/><rect x="4" width="4" height="4" fill="#e05648"/><rect x="4" y="4" width="4" height="4" fill="#f7bc60"/></svg>`
    const source = `data:image/svg+xml,${encodeURIComponent(svg)}`
    const firstPalette = await palette.getAlbumPalette(source)
    const secondPalette = await palette.getAlbumPalette(source)
    return { quietEnergy, loudEnergy, kickPunch: kick.punch, firstPalette, secondPalette }
  })
  assert.ok(ambient.quietEnergy > 0.2 && ambient.loudEnergy > ambient.quietEnergy + 0.15, 'ambient transfer should retain quiet-to-loud dynamics')
  assert.ok(ambient.kickPunch > 0.2, 'bass onset should create a punch envelope')
  assert.ok(ambient.firstPalette?.dominant && ambient.firstPalette?.secondary && ambient.firstPalette?.highlight, 'album thumbnail should yield three lighting colors')
  assert.deepEqual(ambient.secondPalette, ambient.firstPalette, 'album palette cache should return a stable result')

  const proof = {
    testedAt: new Date().toISOString(),
    viewport: { width: 1420, height: 920, reducedMotion: true },
    visualizer: {
      event: 'audio://spectrum',
      payload: 'validated 24-band arrays; synthetic preview remained disabled',
      canvasPixelHashes: { zeroInitial, quiet, louder, isolated, zeroAfterNoise },
      assertions: ['quiet broadband differs from silence', 'louder broadband differs from quiet and is brighter', 'single-bin input equals the stable silence baseline'],
      screenshots: ['visualizer-live-quiet.png', 'visualizer-live-louder.png'],
      perStyle: styleFrames,
      stylesChecked: styleIds,
      noMediaSessionFallback: 'media://changed(null) keeps the visualizer mounted and listening without SMTC metadata',
      nativeCaptureBridge: captured ? {
        source: 'WASAPI default-render numeric spectrum from owned-audio-smoke.ps1',
        bands: nativeCapture.bands,
        packets: nativeCapture.packets,
        screenshot: 'visualizer-live-captured.png',
        rendered: captured,
      } : null,
      limitation: captured
        ? 'Native capture bands were relayed through the preview event adapter into the exact renderer listener; this does not prove Tauri app.emit transport.'
        : 'Browser-injected event regression; set WASAPI_BANDS_JSON from the owned native smoke for physical capture-to-renderer verification.',
    },
    fileDropToast: {
      component: 'Solid component mounted directly from the Vite dev server',
      phases: fixture,
      assertions: ['pending/complete/error phases hide both drag targets', 'unknown progress is indeterminate', 'complete progress is 1'],
    },
    albumAmbient: {
      quietEnergy: ambient.quietEnergy,
      loudEnergy: ambient.loudEnergy,
      kickPunch: ambient.kickPunch,
      palette: ambient.firstPalette,
      assertions: ['quiet-to-loud dB drive remains ordered', 'bass onset creates a pulse', 'data-URL thumbnail palette extracts and caches three colors'],
    },
    pageErrors: errors,
  }
  await writeFile(join(outDir, 'visualizer-live-events.json'), JSON.stringify(proof, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify(proof, null, 2))
} finally {
  await browser.close()
}
