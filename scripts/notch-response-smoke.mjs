// Real Solid UI and spring, browser/native fixtures. No installed app or profile is touched.
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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
await page.addInitScript(() => localStorage.setItem('hover-island.preview.settings', JSON.stringify({ onboardingVersion: 1 })))
try {
  await page.goto(process.env.UI_URL ?? 'http://127.0.0.1:1420/', { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.locator('.island__collapsed').waitFor()
  await page.mouse.move(20, 750)
  const result = await page.evaluate(async () => {
    const ui = await import('/src/state/ui.ts')
    const { settings } = await import('/src/state/settings.ts')
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve))
    const node = document.querySelector('.island')
    const size = () => parseFloat(node.style.getPropertyValue('--island-spring-height'))
    ui.collapseIsland()
    await new Promise(resolve => setTimeout(resolve, 500))
    const startHeight = size()
    const target = settings.expanded.h
    const frames = []
    const started = performance.now()
    ui.expandIsland()
    while (performance.now() - started < 500) {
      await nextFrame()
      frames.push({ at: performance.now() - started, height: size() })
    }
    ui.collapseIsland()
    await new Promise(resolve => setTimeout(resolve, 70))
    const beforeReverse = size()
    ui.expandIsland()
    await nextFrame()
    const afterReverse = size()
    await new Promise(resolve => setTimeout(resolve, 450))
    return { startHeight, target, firstFrameMs: frames.find(f => f.height > startHeight + 1)?.at,
      ninetyPercentMs: frames.find(f => f.height >= startHeight + (target - startHeight) * .9)?.at,
      overshootPx: Math.max(...frames.map(f => f.height)) - target, beforeReverse, afterReverse,
      finalHeight: size(), maxFrameGapMs: Math.max(...frames.slice(1).map((f,i) => f.at - frames[i].at)) }
  })
  assert.ok(result.firstFrameMs < 100, 'opening responds on the next available frame')
  assert.ok(result.ninetyPercentMs < 300, 'the panel reaches 90% without a long height lag')
  assert.ok(result.overshootPx < 3, 'the panel does not bounce past its bounds')
  assert.ok(Math.abs(result.beforeReverse - result.afterReverse) < 100, 'reopening continues from the displayed size')
  assert.ok(Math.abs(result.finalHeight - result.target) < 1)
  await page.screenshot({ path: 'docs/verification/notch-responsive-expanded.png' })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(async () => { const ui = await import('/src/state/ui.ts'); ui.collapseIsland() })
  await page.waitForTimeout(450)
  await page.evaluate(async () => { const ui = await import('/src/state/ui.ts'); ui.expandIsland() })
  await page.waitForFunction(() => !document.querySelector('.island--moving'))
  assert.deepEqual(errors, [])
  const record = { boundary: 'Browser fixture with the real Solid UI and animation code. Native WebView/GPU latency is not measured.', result, reducedMotionPassed: true, errors }
  await writeFile('docs/verification/notch-response-smoke.json', JSON.stringify(record, null, 2) + '\n')
  console.log(JSON.stringify(record, null, 2))
} finally { await browser.close() }
