import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
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
const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
await context.addInitScript(() => localStorage.setItem('hover-island.preview.settings', JSON.stringify({
  onboardingVersion: 1,
  placement: { mode: 'notch', edge: 'top' },
  interaction: { hoverOpen: false },
  hideBehindWindows: false,
})))
const page = await context.newPage()
page.setDefaultTimeout(15000)
const errors = []
page.on('pageerror', error => errors.push(error.message))

try {
  await page.goto(process.env.UI_URL ?? 'http://127.0.0.1:1420/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.locator('.island').waitFor()
  if (!(await page.locator('.island--open').count())) {
    const compact = page.locator('.pill__compact-title').first()
    if (await compact.count()) await compact.click()
    else await page.locator('.island__collapsed').click()
    await page.locator('.island--open').waitFor()
  }

  await page.getByRole('button', { name: 'More actions', exact: true }).click()
  await page.getByRole('menuitemcheckbox', { name: /Arrange widgets/ }).click()
  await page.locator('.widget-grid--arranging').waitFor()

  const cards = page.locator('.widget-grid .widget[data-widget-id]')
  const count = await cards.count()
  assert.ok(count >= 2, 'at least two widgets are available to reorder')
  const firstId = await cards.nth(0).getAttribute('data-widget-id')
  const source = cards.nth(count - 1)
  const sourceId = await source.getAttribute('data-widget-id')
  const sourceBox = await source.boundingBox()
  const firstBox = await cards.nth(0).boundingBox()

  // Browser preview retains its legacy HTML drag fallback for older smoke
  // scripts. Disable that DOM attribute here so this exercise is pointer-only.
  await page.locator('.widget-grid .widget[data-widget-id]').evaluateAll(nodes => nodes.forEach(node => { node.draggable = false }))
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 6, sourceBox.y + sourceBox.height / 2, { steps: 2 })
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2, { steps: 8 })
  await page.waitForFunction(() => document.querySelector('.widget--dragging') && document.querySelector('.widget--drop'))
  assert.equal(await page.locator('.widget-grid .widget[data-widget-id]').first().getAttribute('data-widget-id'), firstId, 'hover feedback does not reorder before release')
  await page.mouse.up()
  await page.waitForFunction(sourceId => document.querySelector('.widget-grid .widget[data-widget-id]')?.getAttribute('data-widget-id') === sourceId, sourceId)
  assert.deepEqual(errors, [], 'pointer reorder does not produce uncaught errors')

  const panelTab = page.getByRole('tab', { name: 'Desk panel', exact: true })
  const panelBox = await panelTab.boundingBox()
  const newSource = page.locator('.widget-grid .widget[data-widget-id]').first()
  const newSourceBox = await newSource.boundingBox()
  const movedId = await newSource.getAttribute('data-widget-id')
  await page.mouse.move(newSourceBox.x + newSourceBox.width / 2, newSourceBox.y + newSourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(newSourceBox.x + newSourceBox.width / 2 + 6, newSourceBox.y + newSourceBox.height / 2, { steps: 2 })
  await page.mouse.move(panelBox.x + panelBox.width / 2, panelBox.y + panelBox.height / 2, { steps: 8 })
  await page.waitForFunction(() => document.querySelector('.panel-tabs__drop'))
  await page.mouse.up()
  await page.waitForFunction(() => document.querySelector('[data-panel-id="desk"]')?.getAttribute('aria-selected') === 'true')
  assert.ok(await page.locator(`.widget-grid .widget[data-widget-id="${movedId}"]`).count(), 'dropping on a panel tab moves the widget to that panel')
  assert.deepEqual(errors, [], 'panel transfer does not produce uncaught errors')

  console.log(JSON.stringify({
    url: process.env.UI_URL ?? 'http://127.0.0.1:1420/',
    interaction: 'Playwright mouse pointer events with capture; browser-preview draggable attributes are disabled during this smoke run.',
    widgetReorder: `${sourceId} moved before ${firstId} only after pointer release.`,
    panelTransfer: `${movedId} moved to Desk after release on the Desk tab.`,
    nativeBoundary: 'This smoke verifies renderer pointer handling, not Windows Tauri OS file drag delivery.',
    pageErrors: errors,
  }, null, 2))
} finally {
  await browser.close()
}
