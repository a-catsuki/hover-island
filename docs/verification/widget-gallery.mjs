import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

// Resolve Playwright the same way as scripts/ui-smoke.mjs.
const smokeRequire = createRequire(new URL('../../scripts/ui-smoke.mjs', import.meta.url))
const { chromium } = smokeRequire(process.env.PLAYWRIGHT_MODULE_PATH ?? join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
let executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH
if (!executablePath && !existsSync(chromium.executablePath())) {
  const base = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'), 'ms-playwright')
  executablePath = readdirSync(base).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])).map(name => join(base, name, 'chrome-win64/chrome.exe')).find(existsSync)
}

const here = dirname(fileURLToPath(import.meta.url))
const baseUrl = process.env.UI_GALLERY_URL ?? 'http://127.0.0.1:1420'
const sizes = {
  Small: { preset: 'small', w: 640, h: 440 },
  Medium: { preset: 'medium', w: 800, h: 560 },
  Large: { preset: 'large', w: 960, h: 640 },
}
const records = []
const browser = await chromium.launch({ headless: true, executablePath })
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 })
await context.addInitScript(() => localStorage.setItem('hover-island.preview.settings', JSON.stringify({ onboardingVersion: 1 })))
const page = await context.newPage()
page.setDefaultTimeout(30000)
page.on('pageerror', error => records.push({ type: 'pageerror', message: error.message }))

const screenshot = async (locator, file) => locator.screenshot({ path: join(here, file) })
const findWidget = async kind => {
  const back = page.getByRole('button', { name: 'Back to panel', exact: true })
  if (await back.count()) await back.click()
  const previous = page.getByRole('button', { name: 'Previous widget page', exact: true })
  while (await previous.count() && await previous.isEnabled()) await previous.click()
  for (let index = 0; index < 30; index++) {
    if (await page.locator(`[data-widget-kind="${kind}"]`).count()) return page.locator(`[data-widget-kind="${kind}"]`).first()
    const next = page.getByRole('button', { name: 'Next widget page', exact: true })
    if (!await next.count() || await next.isDisabled()) break
    await next.click()
  }
  throw new Error(`Widget not reachable: ${kind}`)
}
const selectSize = async ({ preset, w, h }) => {
  await page.evaluate(({ preset, w, h }) => {
    const current = JSON.parse(localStorage.getItem('hover-island.preview.settings') || '{}')
    const next = { ...current, onboardingVersion: 1, sizePreset: preset, expanded: { w, h } }
    localStorage.setItem('hover-island.preview.settings', JSON.stringify(next))
    window.dispatchEvent(new CustomEvent('settings://changed', { detail: next }))
  }, { preset, w, h })
  await page.waitForFunction(w => Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--expanded-w'))) === w, w)
  await page.waitForTimeout(180)
}
const metrics = async (kind, coreSelector, controlNames) => {
  const card = page.locator(`[data-widget-kind="${kind}"]`).first()
  const bounds = await card.boundingBox()
  assert.ok(bounds, `${kind} card is visible`)
  const result = await page.evaluate(({ kind, coreSelector }) => {
    const card = document.querySelector(`[data-widget-kind="${kind}"]`)
    const body = document.querySelector('.panel__body')
    const grid = document.querySelector('.widget-grid')
    const core = card?.querySelector(coreSelector)
    const rect = (node) => node ? Object.fromEntries(['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left'].map(key => [key, node.getBoundingClientRect()[key]])) : null
    const fontSize = node => node ? parseFloat(getComputedStyle(node).fontSize) : null
    return {
      card: rect(card), core: rect(core), coreFontPx: fontSize(core),
      panel: { clientHeight: body?.clientHeight ?? 0, scrollHeight: body?.scrollHeight ?? 0 },
      grid: rect(grid), viewport: { width: innerWidth, height: innerHeight },
      document: { clientHeight: document.documentElement.clientHeight, scrollHeight: document.documentElement.scrollHeight },
    }
  }, { kind, coreSelector })
  const clipping = []
  const buttonBounds = []
  for (const name of controlNames) {
    const target = name === 'Optimize memory'
      ? card.getByRole('button', { name: /^Optimize memory/ }).first()
      : card.getByRole('button', { name, exact: true }).first()
    assert.equal(await target.count(), 1, `${kind} has expected action: ${name}`)
    const rect = await target.boundingBox()
    assert.ok(rect && rect.width > 0 && rect.height > 0, `${kind} action is visible: ${name}`)
    buttonBounds.push({ name, ...rect })
  }
  const visibleButtons = card.locator('button:visible')
  for (let index = 0; index < await visibleButtons.count(); index++) {
    const button = visibleButtons.nth(index)
    const name = (await button.getAttribute('aria-label')) || (await button.innerText()).trim().replace(/\s+/g, ' ')
    const rect = await button.boundingBox()
    if (!rect) continue
    buttonBounds.push({ name, ...rect })
  }
  for (const button of buttonBounds) {
    if (button.x < bounds.x - 1 || button.y < bounds.y - 1 || button.x + button.width > bounds.x + bounds.width + 1 || button.y + button.height > bounds.y + bounds.height + 1) clipping.push(button.name)
  }
  result.buttonBounds = buttonBounds
  result.clippedActions = clipping
  assert.ok(result.panel.scrollHeight <= result.panel.clientHeight + 2, `${kind} has no outer panel scroll`)
  assert.ok(result.document.scrollHeight <= result.document.clientHeight + 2, `${kind} has no document scroll`)
  return result
}

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => document.querySelector('.pill__compact-title') || document.querySelector('.pill__compact'))
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('settings://changed', { detail: { onboardingVersion: 1 } })))
  await page.mouse.move(20, 900)
  await page.waitForTimeout(250)
  const compact = page.locator('.pill__compact-title').first()
  if (await compact.count()) await compact.click()
  else await page.locator('.pill__compact').first().click()
  await page.locator('.island--open').waitFor()
  await page.getByRole('button', { name: 'More actions', exact: true }).click()
  let menu = page.getByRole('menu', { name: 'More island actions', exact: true })
  await menu.getByRole('menuitemcheckbox', { name: /Keep island open/ }).click()
  await page.getByText('Pinned open', { exact: true }).waitFor()

  // Add the real PC controls widget once; size snapshots below are then UI-only.
  await page.getByRole('button', { name: 'More actions', exact: true }).click()
  menu = page.getByRole('menu', { name: 'More island actions', exact: true })
  await menu.getByRole('menuitem', { name: 'PC controls', exact: true }).click()
  await page.locator('[data-widget-kind="controls"]').waitFor()
  await page.waitForTimeout(250)

  for (const [label, size] of Object.entries(sizes)) {
    await selectSize(size)
    await page.getByRole('tab', { name: 'Today panel', exact: true }).click()
    const calendar = await findWidget('calendar')
    await page.locator('.cal__cell').first().waitFor()
    assert.equal(await page.locator('.cal__cell').count(), 42, `${label} calendar has six complete weeks`)
    const calendarInfo = await metrics('calendar', '.cal__num', ['Previous month', 'Next month', 'Connect calendar', 'Import calendar file', 'Add event'])
    const calendarGrid = await page.locator('.cal__grid').boundingBox()
    const lastDay = await page.locator('.cal__cell').last().boundingBox()
    assert.ok(calendarGrid && lastDay && lastDay.y + lastDay.height <= calendarGrid.y + calendarGrid.height + 1, `${label} calendar last row fits`)
    assert.ok(calendarInfo.coreFontPx >= 10, `${label} calendar numerals remain readable`)
    await screenshot(calendar, `widget-gallery-calendar-${label.toLowerCase()}.png`)
    records.push({ widget: 'calendar', size: label, ...calendarInfo, dayFontPx: calendarInfo.coreFontPx, grid: calendarGrid, finalWeek: lastDay })

    await page.getByRole('tab', { name: 'Activity panel', exact: true }).click()
    const reset = await findWidget('reset-watch')
    await reset.locator('.reset-watch__quota-value').waitFor()
    await reset.getByRole('button', { name: 'See announcements', exact: true }).waitFor()
    const resetInfo = await metrics('reset-watch', '.reset-watch__latest-title', ['Refresh reset status', 'See announcements'])
    assert.ok(resetInfo.coreFontPx >= 10, `${label} latest announcement remains readable`)
    await screenshot(reset, `widget-gallery-reset-${label.toLowerCase()}.png`)
    records.push({ widget: 'reset-watch', size: label, ...resetInfo })

    const controls = await findWidget('controls')
    await controls.locator('.quick-settings__tiles').waitFor()
    for (const text of ['Adjust sound in Windows', 'Adjust display in Windows', 'Open Windows settings', 'Adjust in Windows']) {
      assert.ok(await controls.getByText(text, { exact: true }).count(), `${label} preview exposes a Windows fallback for ${text}`)
    }
    const controlsInfo = await metrics('controls', '.quick-settings__tile strong', ['Refresh quick settings', 'Optimize memory'])
    assert.ok(controlsInfo.coreFontPx >= 10, `${label} PC controls labels remain readable`)
    await screenshot(controls, `widget-gallery-controls-${label.toLowerCase()}.png`)
    records.push({ widget: 'controls', size: label, ...controlsInfo })
  }

  const settingsPage = await context.newPage()
  await settingsPage.setViewportSize({ width: 960, height: 700 })
  settingsPage.setDefaultTimeout(30000)
  settingsPage.on('pageerror', error => records.push({ type: 'settings-pageerror', message: error.message }))
  await settingsPage.goto(`${baseUrl}/settings.html`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await settingsPage.locator('.appearance-preview').waitFor()
  await settingsPage.getByRole('heading', { name: 'Appearance', exact: true }).waitFor()
  const appearance = await settingsPage.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    preview: (() => { const node = document.querySelector('.appearance-preview'); const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom } })(),
    main: (() => { const node = document.querySelector('.settings__main'); return { clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight } })(),
  }))
  assert.ok(appearance.preview.width > 0 && appearance.preview.bottom <= 700, 'Appearance preview fits the 960×700 settings viewport')
  await screenshot(settingsPage.locator('body'), 'widget-gallery-settings-appearance-960x700.png')
  records.push({ widget: 'settings-appearance', ...appearance })

  const clipped = records.filter(item => item.clippedActions?.length)
  assert.deepEqual(clipped.map(item => ({ widget: item.widget, size: item.size, actions: item.clippedActions })), [], 'all primary controls fit inside their widget cards')
  assert.deepEqual(records.filter(item => item.type?.includes('pageerror')), [], 'no browser page errors')
  await writeFile(join(here, 'widget-gallery.json'), JSON.stringify({ baseUrl, generatedAt: new Date().toISOString(), screenshots: records }, null, 2))
  console.log(JSON.stringify({ status: 'passed', screenshots: records.length, output: here, records }, null, 2))
} catch (error) {
  await writeFile(join(here, 'widget-gallery.json'), JSON.stringify({ baseUrl, generatedAt: new Date().toISOString(), status: 'failed', error: String(error), screenshots: records }, null, 2))
  console.error(error)
  process.exitCode = 1
} finally {
  await browser.close()
}
