import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync } from 'node:fs'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH ?? join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
let executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH
if (!executablePath && !existsSync(chromium.executablePath())) {
  const base = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'), 'ms-playwright')
  executablePath = readdirSync(base).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])).map(name => join(base, name, 'chrome-win64/chrome.exe')).find(existsSync)
}

const here = dirname(fileURLToPath(import.meta.url))
const baseUrl = process.env.UI_GALLERY_URL ?? 'http://127.0.0.1:1420'
const panels = { today: 'Today', 'overflow-today-2': 'Today 2', 'overflow-today-2-2': 'Today 2', 'overflow-today-2-2-2': 'Today 2', desk: 'Desk', activity: 'Activity' }
const panelOrder = ['today', 'overflow-today-2', 'overflow-today-2-2', 'overflow-today-2-2-2', 'desk', 'activity']
const widgets = [
  { id: 'media-usercase', kind: 'media', enabled: true, order: 0, panel: 'today', size: 'compact' },
  { id: 'weather-usercase', kind: 'weather', enabled: true, order: 1, panel: 'today', size: 'wide' },
  { id: 'focus-usercase', kind: 'focus', enabled: true, order: 2, panel: 'overflow-today-2', size: 'compact' },
  { id: 'calendar-usercase', kind: 'calendar', enabled: true, order: 3, panel: 'overflow-today-2-2-2', size: 'full' },
]
const browser = await chromium.launch({ headless: true, executablePath })
const context = await browser.newContext({ viewport: { width: 960, height: 700 }, deviceScaleFactor: 1 })
// Seed only the very first load. A reload must prove that the app itself
// persisted the user's edits instead of the fixture overwriting them again.
await context.addInitScript(({ panels, panelOrder, widgets }) => {
  if (localStorage.getItem('hover-island.preview.seeded')) return
  localStorage.setItem('hover-island.preview.settings', JSON.stringify({ onboardingVersion: 1, panels, panelOrder, widgets }))
  localStorage.setItem('hover-island.preview.seeded', '1')
}, { panels, panelOrder, widgets })
const page = await context.newPage()
page.setDefaultTimeout(20000)
const errors = []
page.on('pageerror', error => errors.push(error.message))
try {
  await page.goto(`${baseUrl}/settings.html`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.locator('.appearance-preview').waitFor()
  await page.evaluate(() => {
    window.addEventListener('pointermove', event => { const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-drop-page]'); document.documentElement.dataset.dragTrace = `${event.pointerId}:${event.clientX},${event.clientY}:${hit?.getAttribute('data-drop-page') ?? 'none'}` }, true)
    window.addEventListener('mousemove', event => { const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-drop-page]'); document.documentElement.dataset.mouseTrace = `${event.clientX},${event.clientY}:${hit?.getAttribute('data-drop-page') ?? 'none'}` }, true)
    window.addEventListener('pointercancel', event => { document.documentElement.dataset.cancelTrace = String(event.pointerId) }, true)
  })
  await page.getByRole('button', { name: 'Widgets', exact: true }).click()
  const tabs = page.locator('.wmp__page-jumps [role="tab"]')
  await tabs.first().waitFor()
  assert.equal(await tabs.count(), 4, 'three generated duplicate pages normalize into one generated Calendar page while Desk and Activity remain')
  assert.equal(await page.locator('.wmp__page').count(), 1, 'the editor shows one focused page preview')
  const today = page.locator('.wmp__phone').filter({ has: page.locator('.wmp__screen-head').getByText('Today', { exact: true }) })
  assert.equal(await today.count(), 1)
  const todayTiles = today.locator('.wmp__tile')
  assert.equal(await todayTiles.count(), 3, 'Media, Weather, and Focus repack together after the empty-cell migration')
  const bounds = await Promise.all(['media-usercase', 'weather-usercase', 'focus-usercase'].map(id => today.locator(`[data-widget-id="${id}"]`).evaluate(node => ({ row: getComputedStyle(node).gridRowStart, column: getComputedStyle(node).gridColumnStart, width: getComputedStyle(node).gridColumnEnd, height: getComputedStyle(node).gridRowEnd }))))
  assert.deepEqual(bounds, [
    { row: '1', column: '1', width: 'span 1', height: 'span 1' },
    { row: '2', column: '1', width: 'span 2', height: 'span 1' },
    { row: '1', column: '2', width: 'span 1', height: 'span 1' },
  ], 'Focus occupies the empty top-right cell above wide Weather')
  await page.locator('.wmp').screenshot({ path: join(here, 'widget-editor-regression.png') })

  await page.getByRole('button', { name: 'Add page', exact: true }).click()
  const research = page.locator('.wmp__page-jumps [role="tab"]').last()
  await research.click()
  const name = page.getByRole('textbox', { name: /Page \d+ name/ }).last()
  await name.fill('Research')
  await name.press('Tab')
  const notes = page.locator('.wmp__chip').filter({ hasText: 'Notes' })
  await notes.click()
  console.log('after-add-notes', JSON.stringify(JSON.parse(await page.evaluate(() => localStorage.getItem('hover-island.preview.settings'))).widgets.map(({id,kind,panel}) => ({id,kind,panel}))))
  await page.getByRole('combobox', { name: 'Page for Notes', exact: true }).selectOption({ label: 'Research' })
  console.log('after-page-select', JSON.stringify(JSON.parse(await page.evaluate(() => localStorage.getItem('hover-island.preview.settings'))).widgets.map(({id,kind,panel}) => ({id,kind,panel}))))
  const noteTile = page.locator('.wmp__tile').filter({ hasText: 'Notes' })
  await noteTile.waitFor()
  const todayTab = page.locator('.wmp__page-jumps [role="tab"]').filter({ hasText: 'Today' }).first()
  await todayTab.click()
  const focusTile = page.locator('.wmp__tile[data-widget-id="focus-usercase"]')
  const [from, to] = await Promise.all([focusTile.boundingBox(), research.boundingBox()])
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 })
  console.log('cross-page target diagnostic', JSON.stringify(await page.evaluate(({ x, y }) => ({ live: document.querySelector('.wmp__live')?.textContent, active: document.querySelector('.wmp__page-jump--drop')?.getAttribute('data-drop-page'), trace: document.documentElement.dataset.dragTrace, mouse: document.documentElement.dataset.mouseTrace, cancel: document.documentElement.dataset.cancelTrace, hit: document.elementFromPoint(x,y)?.closest('[data-drop-page]')?.getAttribute('data-drop-page') }), { x: to.x + to.width / 2, y: to.y + to.height / 2 })))
  await page.mouse.up()
  console.log('cross-page drop diagnostic', JSON.stringify(await page.evaluate(() => ({ selected: document.querySelector('.wmp__page')?.dataset.panelId, source: JSON.parse(localStorage.getItem('hover-island.preview.settings')).widgets.find(widget => widget.id === 'focus-usercase')?.panel, live: document.querySelector('.wmp__live')?.textContent, dragging: document.querySelector('.wmp__tile--dragging')?.getAttribute('data-widget-id'), drop: document.querySelector('.wmp__page-jump--drop')?.textContent }))))
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('hover-island.preview.settings')).widgets.find(widget => widget.id === 'focus-usercase')?.panel?.startsWith('panel-'))
  await page.locator('.wmp__tile[data-widget-id="focus-usercase"]').waitFor()
  const emptyCell = page.locator('.wmp__empty-cell[data-drop-row="2"][data-drop-column="1"]')
  const [fromCell, toCell] = await Promise.all([page.locator('.wmp__tile[data-widget-id="focus-usercase"]').boundingBox(), emptyCell.boundingBox()])
  await page.mouse.move(fromCell.x + fromCell.width / 2, fromCell.y + fromCell.height / 2)
  await page.mouse.down()
  await page.mouse.move(toCell.x + toCell.width / 2, toCell.y + toCell.height / 2, { steps: 6 })
  await page.mouse.up()
  await page.waitForFunction(() => { const tile = document.querySelector('[data-widget-id="focus-usercase"]'); return getComputedStyle(tile).gridRowStart === '2' && getComputedStyle(tile).gridColumnStart === '1' })
  // The preview store debounces its localStorage write; the reload below must
  // read the persisted drop, not a stale debounce window.
  await page.waitForFunction(() => {
    const saved = JSON.parse(localStorage.getItem('hover-island.preview.settings') ?? '{}')
    const focus = saved.widgets?.find(widget => widget.id === 'focus-usercase')
    return focus?.panel?.startsWith('panel-') && focus?.slot?.row === 2 && focus?.slot?.column === 1
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Widgets', exact: true }).click()
  assert.equal(await page.locator('.wmp__page-jumps [role="tab"]').filter({ hasText: 'Research' }).count(), 1, 'renamed user page survives reload')
  await page.locator('.wmp__page-jumps [role="tab"]').filter({ hasText: 'Research' }).click()
  assert.equal(await page.locator('.wmp__tile[data-widget-id="focus-usercase"]').count(), 1, 'cross-page pointer drag survives reload')
  const persisted = await page.locator('.wmp__tile[data-widget-id="focus-usercase"]').evaluate(node => ({ row: getComputedStyle(node).gridRowStart, column: getComputedStyle(node).gridColumnStart }))
  assert.deepEqual(persisted, { row: '2', column: '1' }, 'empty-cell placement survives reload')
  assert.deepEqual(errors, [], 'no browser runtime errors')
  console.log(JSON.stringify({ status: 'passed', title: 'generated duplicate pages / wide-widget hole / native pointer capture / persisted cross-page move', screenshot: join(here, 'widget-editor-regression.png') }, null, 2))
} finally {
  await browser.close()
}
