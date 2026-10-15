import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH ?? join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
let executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH
if (!executablePath && !existsSync(chromium.executablePath())) {
  const base = join(process.env.LOCALAPPDATA, 'ms-playwright')
  executablePath = readdirSync(base).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .map(name => join(base, name, 'chrome-win64', 'chrome.exe')).find(existsSync)
}

const outDir = fileURLToPath(new URL('./', import.meta.url))
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
  assert.notEqual(quiet.hash, zeroInitial.hash, 'quiet broadband audio should change the rendered pixels')
  assert.notEqual(louder.hash, quiet.hash, 'louder broadband audio should produce a distinct rendered response')
  assert.ok(louder.meanRgb > quiet.meanRgb, 'louder broadband audio should visibly increase canvas brightness')
  assert.equal(isolated.hash, zeroAfterNoise.hash, 'single-bin input should return to the stable idle/silence rendering')
  assert.ok(![zeroInitial, quiet, louder, isolated, zeroAfterNoise].some(frame => frame.mode === 'Synthetic preview'), 'synthetic preview must stay disabled')

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

  const proof = {
    testedAt: new Date().toISOString(),
    viewport: { width: 1420, height: 920, reducedMotion: true },
    visualizer: {
      event: 'audio://spectrum',
      payload: 'validated 24-band arrays; synthetic preview remained disabled',
      canvasPixelHashes: { zeroInitial, quiet, louder, isolated, zeroAfterNoise },
      assertions: ['quiet broadband differs from silence', 'louder broadband differs from quiet and is brighter', 'single-bin input equals the stable silence baseline'],
      screenshots: ['visualizer-live-quiet.png', 'visualizer-live-louder.png'],
      limitation: 'Browser-injected event regression; does not prove physical WASAPI capture.',
    },
    fileDropToast: {
      component: 'Solid component mounted directly from the Vite dev server',
      phases: fixture,
      assertions: ['pending/complete/error phases hide both drag targets', 'unknown progress is indeterminate', 'complete progress is 1'],
    },
    pageErrors: errors,
  }
  await writeFile(join(outDir, 'visualizer-live-events.json'), JSON.stringify(proof, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify(proof, null, 2))
} finally {
  await browser.close()
}
