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
const panelTabs = () => page.locator('.panel-tabs [role="tab"]')
const assertFlatPanel = async label => {
  assert.equal(await page.locator('.panel-pager, .widget-grid--detail').count(), 0, `${label} has no nested pager or detail layer`)
  assert.equal(await page.getByRole('button', { name: 'Back to panel', exact: true }).count(), 0, `${label} has no back-layer control`)
  const scroll = await page.locator('.panel__body').evaluate(node => ({ client: node.clientHeight, content: node.scrollHeight }))
  assert.ok(scroll.content <= scroll.client + 2, `${label} has no outer panel scroll`)
  const controlsScroll = await page.locator('.quick-settings__tiles').evaluateAll(nodes => nodes.map(node => ({ client: node.clientHeight, content: node.scrollHeight })))
  assert.ok(controlsScroll.every(item => item.content <= item.client + 2), `${label} has no inner Quick Controls scroll`)
}
const findWidget = async kind => {
  const tabs = panelTabs()
  for (let index = 0; index < await tabs.count(); index++) {
    const tab = tabs.nth(index)
    await tab.scrollIntoViewIfNeeded()
    await tab.click()
    await page.waitForTimeout(50)
    if (await page.locator(`[data-widget-kind="${kind}"]`).count()) {
      await assertFlatPanel(kind)
      return page.locator(`[data-widget-kind="${kind}"]`).first()
    }
  }
  throw new Error(`Widget not reachable in any panel: ${kind}`)
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
  buttonBounds.push(...await visibleButtons.evaluateAll(nodes => nodes.map(button => {
    const rect = button.getBoundingClientRect()
    return {
      name: button.getAttribute('aria-label') || button.innerText.trim().replace(/\s+/g, ' '),
      x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    }
  })))
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

  assert.equal(await page.locator('.pill__beam,.pill__move-handle').count(), 0, 'collapsed surface has no Beam button or extra move handle')
  await page.getByRole('button', { name: 'Open file beam', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Open quick controls', exact: true }).waitFor()
  const firstTab = panelTabs().first()
  await firstTab.click()
  assert.ok(await page.locator('[data-widget-kind="media"]').count(), 'default panel contains media')
  assert.ok(await page.locator('[data-widget-kind="weather"]').count(), 'default panel contains weather beside media')
  await assertFlatPanel('default panel')

  // Quick Controls is a direct toolbar action and owns a flat panel.
  await page.getByRole('button', { name: 'Open quick controls', exact: true }).click()
  await page.locator('[data-widget-kind="controls"]').waitFor()
  await page.waitForTimeout(250)

  for (const [label, size] of Object.entries(sizes)) {
    await selectSize(size)
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

    const reset = await findWidget('reset-watch')
    await reset.locator('.reset-watch__latest-title').waitFor()
    assert.equal(await reset.locator('.reset-watch__quota-value,.reset-watch__counts').count(),0)
    const resetInfo = await metrics('reset-watch', '.reset-watch__latest-title', ['Refresh reset announcements'])
    assert.ok(resetInfo.coreFontPx >= 10, `${label} latest announcement remains readable`)
    await screenshot(reset, `widget-gallery-reset-${label.toLowerCase()}.png`)
    records.push({ widget: 'reset-watch', size: label, ...resetInfo })

    const controls = await findWidget('controls')
    await controls.locator('.quick-settings__tiles').waitFor()
    for (const text of ['Open Sound settings', 'Open Display settings', 'Open Windows settings']) {
      assert.ok(await controls.getByText(text, { exact: true }).count(), `${label} preview exposes a Windows fallback for ${text}`)
    }
    const controlsInfo = await metrics('controls', '.quick-settings__tile strong', ['Refresh quick settings', 'Optimize memory'])
    const tileScroll = await controls.locator('.quick-settings__tiles').evaluate(node => ({ client: node.clientHeight, content: node.scrollHeight }))
    assert.ok(tileScroll.content <= tileScroll.client + 2, `${label} Quick Controls actions fit without inner scrolling`)
    assert.ok(controlsInfo.coreFontPx >= 10, `${label} PC controls labels remain readable`)
    await screenshot(controls, `widget-gallery-controls-${label.toLowerCase()}.png`)
    records.push({ widget: 'controls', size: label, ...controlsInfo })

    const weather = await findWidget('weather')
    await weather.locator('.weather__temp').waitFor()
    const weatherInfo = await metrics('weather', '.weather__temp', ['Location', 'Details'])
    assert.ok(weatherInfo.coreFontPx >= 20, `${label} weather temperature remains readable`)
    await screenshot(weather, `widget-gallery-weather-${label.toLowerCase()}.png`)
    records.push({ widget: 'weather', size: label, ...weatherInfo })
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
  const widgetSection = settingsPage.getByRole('button', { name: 'Widgets', exact: true })
  await widgetSection.click()
  await settingsPage.getByRole('list', { name: 'Widget pages' }).waitFor()
  const previews = settingsPage.locator('.wmp__page')
  assert.ok(await previews.count() > 0, 'Settings exposes editable phone-style page previews')
  for (let index = 0; index < await previews.count(); index++) {
    const preview = previews.nth(index)
    await preview.scrollIntoViewIfNeeded()
    const grid = preview.locator('.wmp__grid')
    const gridScroll = await grid.evaluate(node => ({ client: node.clientHeight, content: node.scrollHeight }))
    assert.ok(gridScroll.content <= gridScroll.client + 2, `Settings panel preview ${index + 1} has no inner scroll`)
    const box = await preview.boundingBox()
    const strip = preview.locator('.wmp__phone')
    const phone = await strip.boundingBox()
    assert.ok(phone && phone.width > 0 && phone.height > 0, `Settings page ${index + 1} phone preview is visible`)
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 960 + 1 && box.y + box.height <= 700 + 1, `Settings page preview ${index + 1} fits the viewport`)
    const namedControls = preview.locator('button:visible, input:visible')
    for (let controlIndex = 0; controlIndex < await namedControls.count(); controlIndex++) {
      const control = namedControls.nth(controlIndex)
      const controlName = await control.getAttribute('aria-label') || await control.getAttribute('title') || await control.innerText().catch(() => '') || await control.inputValue().catch(() => '')
      assert.ok(controlName, `Settings page ${index + 1} control ${controlIndex + 1} has an accessible name`)
    }
  }
  const initialPageCount = await previews.count()
  await screenshot(settingsPage.locator('.wmp'), 'widget-gallery-settings-widgets-960x700.png')

  // Exercise the complete editor workflow using its user-facing controls.
  await settingsPage.getByRole('button', { name: 'Add page', exact: true }).click()
  const pageTwo = settingsPage.getByRole('textbox', { name: `Page ${initialPageCount + 1} name`, exact: true })
  await pageTwo.fill('Research')
  await pageTwo.press('Tab')
  const connectionsChip = settingsPage.locator('.wmp__chip').filter({ hasText: 'Connections' })
  assert.equal(await connectionsChip.count(), 1, 'Connections can be added as a widget')
  await connectionsChip.click()
  const connectionSize = settingsPage.getByRole('group', { name: 'Connections size', exact: true })
  await connectionSize.getByRole('button', { name: /Wide/ }).click()
  const connectionsPage = settingsPage.getByRole('combobox', { name: 'Page for Connections', exact: true })
  await connectionsPage.selectOption({ label: 'Research' })
  await settingsPage.getByRole('button', { name: /Connections, wide size/ }).waitFor()

  const researchPage = settingsPage.locator('.wmp__page[aria-label="Research page preview"]')
  assert.equal(await researchPage.count(), 1, 'Renamed page remains available')
  const notesInOriginalPage = settingsPage.getByRole('button', { name: /Notes, compact size/ }).first()
  await notesInOriginalPage.click()
  const notesWidgetId = await notesInOriginalPage.getAttribute('data-widget-id')
  const notesPage = settingsPage.getByRole('combobox', { name: 'Page for Notes', exact: true })
  const notesOriginalPage = await notesPage.inputValue()
  assert.ok(notesWidgetId, 'Notes tile exposes its stable widget identity for drag validation')
  await notesInOriginalPage.dragTo(settingsPage.getByRole('button', { name: 'Research page drop target', exact: true }))
  const dragState = await settingsPage.evaluate(() => [...document.querySelectorAll('.wmp__tile')].map(tile => ({ id: tile.getAttribute('data-widget-id'), label: tile.getAttribute('aria-label'), page: tile.closest('.wmp__page')?.getAttribute('aria-label') })))
  assert.ok(dragState.some(tile => tile.id === notesWidgetId && tile.page === 'Research page preview'), 'Drag and drop moves Notes onto the Research page')
  await settingsPage.getByRole('button', { name: /Notes, compact size, position 2 of 2/ }).waitFor()
  await settingsPage.getByRole('button', { name: /Connections, wide size/ }).dragTo(settingsPage.getByRole('button', { name: /Notes, compact size, position 2 of 2/ }))
  await settingsPage.getByRole('button', { name: /Connections, wide size, position 2 of 2/ }).waitFor()
  await settingsPage.getByRole('button', { name: /Notes, compact size, position 1 of 2/ }).click()
  await settingsPage.getByRole('combobox', { name: 'Page for Notes', exact: true }).selectOption(notesOriginalPage)
  await settingsPage.getByRole('button', { name: /Connections, wide size/ }).click()
  await settingsPage.getByRole('button', { name: 'Remove', exact: true }).click()
  await settingsPage.getByRole('button', { name: 'Delete Research page', exact: true }).click()
  assert.equal(await settingsPage.getByRole('textbox', { name: /Research/ }).count(), 0, 'Deleting a page removes its editor surface')
  assert.equal(await settingsPage.locator('.wmp__page').count(), initialPageCount, 'Add and delete page controls restore the original page count')

  const editorLayout = await settingsPage.evaluate(() => {
    const content = document.querySelector('.settings__content')
    const editor = document.querySelector('.wmp')
    const rect = node => node ? { top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom, height: node.getBoundingClientRect().height } : null
    return { viewport: { width: innerWidth, height: innerHeight }, content: content ? { clientHeight: content.clientHeight, scrollHeight: content.scrollHeight } : null, editor: rect(editor) }
  })
  records.push({ widget: 'settings-editor', ...editorLayout, actions: ['add page', 'rename page', 'add widget', 'resize widget', 'drag widget between pages', 'drag reorder within page', 'remove widget', 'delete page'] })
  assert.ok(editorLayout.editor && editorLayout.editor.top >= 0 && editorLayout.editor.bottom <= 700, 'Widget editor and its controls fit in the 960×700 viewport')
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


