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
const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 })
await context.addInitScript(() => localStorage.setItem('hover-island.preview.settings', JSON.stringify({
  onboardingVersion: 1,
  placement: { mode: 'notch', edge: 'top' },
  interaction: { hoverOpen: false },
})))
const page = await context.newPage()
page.setDefaultTimeout(15000)
const outDir = join(process.cwd(), 'docs', 'verification', 'docking-preview')
await mkdir(outDir, { recursive: true })
const errors = []
page.on('pageerror', error => errors.push(error.message))

try {
  await page.goto(process.env.UI_URL ?? 'http://127.0.0.1:1420/', { waitUntil: 'domcontentloaded' })
  await page.locator('.island').waitFor()
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('hover-island.preview.settings') ?? 'null')?.onboardingVersion === 1)
  await page.mouse.move(500, 350)
  await page.waitForTimeout(100)
  const cases = []

  for (const [mode, edge] of [['sidebar', 'left'], ['sidebar', 'right'], ['bar', 'top'], ['bar', 'bottom']]) {
    const label = `${mode}-${edge}`
    await page.evaluate(({ mode, edge }) => {
      const key = 'hover-island.preview.settings'
      const settings = JSON.parse(localStorage.getItem(key))
      settings.placement = { ...settings.placement, mode, edge }
      localStorage.setItem(key, JSON.stringify(settings))
      window.dispatchEvent(new CustomEvent('settings://changed', { detail: settings }))
    }, { mode, edge })
    await page.mouse.move(500, 350)
    await page.waitForFunction(({ mode }) => document.querySelector('.island')?.classList.contains(`island--mode-${mode}`), { mode })
    await page.waitForFunction(({ mode, edge }) => {
      const island = document.querySelector('.island')
      return island?.classList.contains(`island--edge-${edge}`)
        && island?.classList.contains(`island--mode-${mode}`)
        && !island?.classList.contains(`island--mode-${mode === 'bar' ? 'sidebar' : 'bar'}`)
    }, { mode, edge })
    await page.waitForTimeout(180)

    const collapsed = await page.locator('.island__collapsed').boundingBox()
    const compactItemRects = await page.locator('.pill__compact-item').evaluateAll(items => items.map(item => {
      const rect = item.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }))
    if (mode === 'sidebar') {
      assert.equal(Math.round(collapsed.width), 72, `${label} collapsed rail width`)
      assert.equal(Math.round(collapsed.height), 700, `${label} collapsed rail height`)
      assert.ok(compactItemRects.length > 0, `${label} has compact essentials`)
      for (const rect of compactItemRects) {
        assert.ok(rect.x >= collapsed.x - 1 && rect.x + rect.width <= collapsed.x + collapsed.width + 1, `${label} compact item fits inside rail`)
      }
    } else {
      assert.equal(Math.round(collapsed.width), 1000, `${label} collapsed shelf width`)
    }
    await page.screenshot({ path: join(outDir, `${label}-collapsed.png`) })

    await page.locator('.island__collapsed [role="group"]').evaluate(element => element.click())
    await page.locator('.island--open').waitFor()
    await page.waitForFunction(({ mode }) => {
      const style = getComputedStyle(document.querySelector('.island'))
      const width = Number.parseFloat(style.getPropertyValue('--island-spring-width'))
      const height = Number.parseFloat(style.getPropertyValue('--island-spring-height'))
      return mode === 'sidebar' ? Math.abs(width - 420) < 1 && Math.abs(height - 700) < 1
        : Math.abs(width - 1000) < 1 && Math.abs(height - 560) < 1
    }, { mode }, { timeout: 5000 })
    await page.waitForTimeout(550)
    const expanded = await page.locator('.island__expanded').boundingBox()
    const springFrame = await page.locator('.island').evaluate(island => {
      const style = getComputedStyle(island)
      const rect = island.getBoundingClientRect()
      return {
        width: Number.parseFloat(style.getPropertyValue('--island-spring-width')),
        height: Number.parseFloat(style.getPropertyValue('--island-spring-height')),
        clipPath: style.clipPath,
        host: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }
    })
    if (mode === 'sidebar') {
      assert.equal(Math.round(expanded.width), 420, `${label} expanded panel width`)
      assert.equal(Math.round(expanded.height), 700, `${label} expanded panel height`)
      assert.equal(Math.round(springFrame.host.width), 420, `${label} native-host preview width`)
      assert.equal(Math.round(springFrame.host.height), 700, `${label} native-host preview height`)
      assert.equal(Math.round(springFrame.host.x), edge === 'left' ? 0 : 580, `${label} edge-attached host`)
      assert.match(springFrame.clipPath, edge === 'left'
        ? /^inset\(max\(0px, 50% - 350px\) max\(0px, 100% - 420px\)/
        : /^inset\(max\(0px, 50% - 350px\) 0px max\(0px, 50% - 350px\) max\(0px, 100% - 420px\)/,
      `${label} clips to its full edge-attached frame`)
    } else {
      assert.equal(Math.round(expanded.width), 1000, `${label} expanded shelf width`)
      assert.equal(Math.round(springFrame.host.width), 1000, `${label} native-host preview width`)
      assert.equal(Math.round(springFrame.host.height), 560, `${label} native-host preview height`)
      assert.ok(Math.abs(springFrame.height - 560) < 1, `${label} expanded shelf material height`)
    }
    await page.screenshot({ path: join(outDir, `${label}-expanded.png`) })
    cases.push({ mode, edge, collapsed, expanded, springFrame, compactItemRects })

    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.island--open'))
    await page.mouse.move(500, 350)
  }

  assert.deepEqual(errors, [], 'preview has no uncaught page errors')
  const report = { url: process.env.UI_URL ?? 'http://127.0.0.1:1420/', viewport: { width: 1000, height: 700 }, cases, pageErrors: errors, nativeHostValidation: 'not covered by browser preview' }
  await writeFile(join(outDir, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
}
