import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_MODULE_PATH ?? join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'),
)
let executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH
if (!executablePath && !existsSync(chromium.executablePath())) {
  const base = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'), 'ms-playwright')
  executablePath = readdirSync(base)
    .filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .map(name => join(base, name, 'chrome-win64/chrome.exe'))
    .find(existsSync)
}
const browser = await chromium.launch({ headless: true, executablePath })
const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 })
await context.addInitScript(() => localStorage.setItem('hover-island.preview.settings', JSON.stringify({
  onboardingVersion: 1,
  placement: { mode: 'notch', edge: 'top' },
  interaction: { hoverOpen: false },
  sizePreset: 'large',
  compactItems: ['media', 'clock', 'weather', 'battery'],
})))
const page = await context.newPage()
page.setDefaultTimeout(15000)
const outDir = join(process.cwd(), 'docs', 'verification', 'notch-motion-preview')
await mkdir(outDir, { recursive: true })
const errors = []
page.on('pageerror', error => errors.push(error.message))

try {
  await page.goto(process.env.UI_URL ?? 'http://127.0.0.1:1420/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.locator('.island').waitFor()
  const cases = []
  for (const edge of ['left', 'right']) {
    await page.evaluate(edge => {
      const key = 'hover-island.preview.settings'
      const settings = JSON.parse(localStorage.getItem(key))
      settings.placement = { ...settings.placement, mode: 'notch', edge }
      localStorage.setItem(key, JSON.stringify(settings))
      window.dispatchEvent(new CustomEvent('settings://changed', { detail: settings }))
    }, edge)
    await page.waitForFunction(edge => {
      const island = document.querySelector('.island')
      return island?.classList.contains('island--notch-side') && island.classList.contains(`island--edge-${edge}`)
    }, edge)
    await page.mouse.move(edge === 'left' ? 1100 : 100, 400)
    await page.waitForTimeout(150)
    const collapsed = await page.locator('.island__collapsed').boundingBox()
    const host = await page.locator('.island-stage').boundingBox()
    assert.equal(Math.round(collapsed.width), 56, `${edge} side-notch width`)
    assert.equal(Math.round(collapsed.height), 144, `${edge} side-notch height`)
    assert.equal(Math.round(collapsed.x), edge === 'left' ? 0 : 1144, `${edge} pill sits on the monitor edge`)
    assert.equal(Math.round(collapsed.y), 328, `${edge} pill stays vertically centered`)
    const items = await page.locator('.pill__compact-item').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }))
    assert.equal(await page.locator('.pill__beam').count(), 0, 'collapsed surface has no Beam button')
    assert.equal(await page.locator('.island__move-handle').count(), 0, 'collapsed surface has no separate move handle')
    assert.equal(items.length, 4, `${edge} pill fits the large preset's four compact essentials`)
    for (const item of items) {
      assert.ok(item.x >= collapsed.x - 1 && item.x + item.width <= collapsed.x + collapsed.width + 1, `${edge} essential fits inside the vertical pill`)
      assert.ok(item.y >= collapsed.y - 1 && item.y + item.height <= collapsed.y + collapsed.height + 1, `${edge} essential fits vertically`)
    }
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('island://proximity', { detail: { x: 5, y: -4 } })))
    await page.waitForFunction(() => {
      const island = document.querySelector('.island')
      return island?.style.getPropertyValue('--magnet-x') !== ''
        && Math.abs(Number.parseFloat(island.style.getPropertyValue('--magnet-x'))) > 0.1
    })
    const motion = await page.locator('.island').evaluate(island => ({
      x: Number.parseFloat(island.style.getPropertyValue('--magnet-x')),
      y: Number.parseFloat(island.style.getPropertyValue('--magnet-y')),
      open: island.classList.contains('island--open'),
    }))
    assert.ok(Math.abs(motion.x) <= 6 && Math.abs(motion.y) <= 6, `${edge} magnetic pull is bounded`)
    assert.equal(motion.open, false, `${edge} magnetic pull does not open the pill`)
    await page.screenshot({ path: join(outDir, `notch-${edge}-collapsed.png`) })
    cases.push({ edge, host, collapsed, itemCount: items.length, motion, collapsedActions: 'none' })
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('island://proximity', { detail: { x: 0, y: 0 } })))
    await page.waitForFunction(() => {
      const island = document.querySelector('.island')
      return Math.abs(Number.parseFloat(island.style.getPropertyValue('--magnet-x') || '0')) < 0.2
        && Math.abs(Number.parseFloat(island.style.getPropertyValue('--magnet-y') || '0')) < 0.2
    })
  }
  assert.deepEqual(errors, [], 'preview has no uncaught page errors')
  const report = { url: process.env.UI_URL ?? 'http://127.0.0.1:1420/', viewport: { width: 1200, height: 800 }, cases, pageErrors: errors, nativeCursorWorker: 'not covered by browser preview' }
  await writeFile(join(outDir, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
}
