// Verify the normal notch under the release's software-rendering mode.
// Browser fixtures only: native process memory is measured by --memory-check.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
const { chromium } = createRequire(import.meta.url)(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
const base = join(process.env.LOCALAPPDATA, 'ms-playwright')
const executablePath = existsSync(chromium.executablePath()) ? undefined : readdirSync(base).filter(n => /^chromium-\d+$/.test(n)).sort((a,b) => +b.split('-')[1] - +a.split('-')[1]).map(n => join(base,n,'chrome-win64/chrome.exe')).find(existsSync)
const browser = await chromium.launch({ headless: true, executablePath, args: ['--disable-gpu'] })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 })
  const errors = [], flows = []
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(() => localStorage.setItem('hover-island.preview.settings', JSON.stringify({ onboardingVersion: 1 })))
  await page.goto('http://127.0.0.1:1420/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.locator('.island__bar').waitFor()
  await page.waitForFunction(() => !document.querySelector('.tour-card'))
  const open = async () => { await page.locator('.island__bar').focus(); await page.keyboard.press('Enter'); await page.locator('.island--open').waitFor() }
  for (let i = 0; i < 5; i++) {
    await open()
    await page.getByRole('button', { name: 'Open settings', exact: true }).waitFor()
    const widgets = await page.locator('[data-widget-kind]').count()
    assert.ok(widgets > 0)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.island--open'))
  }
  flows.push('Five open/close cycles retain controls and widget rendering at 200% scale')
  await open()
  const tabs = page.locator('.panel-tabs [role="tab"]')
  const count = await tabs.count()
  assert.ok(count >= 2)
  for (let i = 0; i < count; i++) {
    await tabs.nth(i).click()
    assert.equal(await tabs.nth(i).getAttribute('aria-selected'), 'true')
    assert.ok(await page.locator('[data-widget-kind]').count())
  }
  flows.push('Each panel remains reachable and renders its widgets')
  await tabs.first().click()
  await page.mouse.move(500, 80)
  const frames = await page.evaluate(() => new Promise(resolve => {
    let first, previous, count = 0, worst = 0
    const tick = now => {
      first ??= now
      if (previous !== undefined) { count++; worst = Math.max(worst, now - previous) }
      previous = now
      if (now - first < 1500) requestAnimationFrame(tick)
      else resolve({ frames: count, meanMs: (now - first) / count, worstMs: worst })
      }; requestAnimationFrame(tick)
  }))
  await page.screenshot({ path: 'outputs_tmp/memory-shell.png' })
  assert.deepEqual(errors, [])
  const record = { testedAt: new Date().toISOString(), boundary: 'Real frontend in Chromium with software rendering and sample data. Native memory and frame reports are measured separately in the installed app.', flows, frames, errors }
  await writeFile('docs/verification/memory-shell-ui.json', JSON.stringify(record,null,2)+'\n')
  console.log(JSON.stringify(record,null,2))
} finally { await browser.close() }
