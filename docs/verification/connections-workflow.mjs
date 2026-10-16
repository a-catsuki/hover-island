import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import assert from 'node:assert/strict'

const require = createRequire(new URL('../../scripts/ui-smoke.mjs', import.meta.url))
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH ?? join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
let executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH
if (!executablePath && !existsSync(chromium.executablePath())) {
  const base = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'), 'ms-playwright')
  executablePath = readdirSync(base).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])).map(name => join(base, name, 'chrome-win64/chrome.exe')).find(existsSync)
}

const here = dirname(fileURLToPath(import.meta.url))
const baseUrl = process.env.UI_CONNECTIONS_URL ?? 'http://127.0.0.1:1420'
const browser = await chromium.launch({ headless: true, executablePath })
const context = await browser.newContext({ viewport: { width: 1100, height: 900 } })
await context.addInitScript(() => localStorage.setItem('hover-island.preview.settings', JSON.stringify({ onboardingVersion: 1 })))

const mockFeedModule = `
let connections = []
let pollCount = 0
globalThis.__websiteFeedFixture = { get pollCount() { return pollCount }, failChecks: false }
export const websiteAlertsIpc = {
  connectionsGet: async () => connections.map(item => ({ ...item })),
  add: async (serverUrl, displayName, adapter) => {
    if (globalThis.__websiteFeedFixture.addError) throw new Error(globalThis.__websiteFeedFixture.addError)
    const parsed = new URL(serverUrl)
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') throw new Error('Website connections require HTTPS')
    const connection = { id: 'fixture-' + (connections.length + 1), displayName, serverUrl: parsed.origin, adapter, pairedAt: new Date().toISOString() }
    connections.push(connection)
    return { ...connection }
  },
  remove: async id => { connections = connections.filter(item => item.id !== id); return connections.map(item => ({ ...item })) },
  alertsGet: async () => {
    pollCount++
    if (globalThis.__websiteFeedFixture.failChecks) throw new Error('Feed timed out')
    return { connections: connections.map(item => ({ ...item })), sites: connections.map(connection => ({ connection: { ...connection }, events: [], baselineComplete: true, error: null })) }
  },
}
`

await context.route('**/src/lib/erpIpc.ts*', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: mockFeedModule }))
const page = await context.newPage()
page.setDefaultTimeout(20000)
const errors = []
page.on('pageerror', error => errors.push(error.message))

try {
  await page.goto(`${baseUrl}/settings.html`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.getByRole('button', { name: 'Connections', exact: true }).click()
  await page.locator('.conn__native').waitFor()
  await page.getByText('No alert feeds connected.', { exact: false }).waitFor()
  assert.equal(await page.locator('.website-connection').count(), 0, 'No website is shown as connected by default')
  const shortcuts = page.locator('.conn__shortcuts')
  assert.equal(await shortcuts.getAttribute('open'), null, 'Website shortcuts are collapsed by default')
  await shortcuts.locator('summary').click()
  assert.ok(await shortcuts.getByText('Gmail', { exact: true }).count(), 'Gmail is presented only inside the shortcut list')
  assert.equal(await shortcuts.getByRole('switch', { name: 'Save Gmail shortcut' }).getAttribute('aria-checked'), 'false', 'A shortcut is not mislabeled as a connected account')

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('notifications://changed', { detail: [{ id: 'source-1', app: 'Example Mail', title: 'Message arrived', body: 'Test event', timestamp: Date.now() }] })))
  const observed = page.locator('.conn__observed-row').filter({ hasText: 'Example Mail' })
  await observed.getByRole('button', { name: 'Add app', exact: true }).click()
  const nativeCard = page.locator('.conn__native-card').filter({ hasText: 'Example Mail' })
  await nativeCard.waitFor()
  const mute = nativeCard.getByRole('button', { name: 'Mute Example Mail alerts', exact: true })
  await mute.click()
  const routeTest = nativeCard.getByRole('button', { name: 'Test Example Mail alert routing', exact: true })
  assert.equal(await routeTest.isDisabled(), true, 'Muted native sources cannot send a routing test')
  await nativeCard.getByRole('button', { name: 'Show Example Mail alerts', exact: true }).click()
  await routeTest.click()
  await page.getByRole('status').filter({ hasText: 'Routing test sent for Example Mail' }).waitFor()

  await page.getByRole('heading', { name: 'Website alert feeds', exact: true }).waitFor()
  const websiteForm = page.locator('.website-connections__form')
  await websiteForm.getByLabel('Website name').fill('Demo feed')
  await websiteForm.getByLabel('Website address').fill('https://alerts.example.test')
  assert.equal(await websiteForm.locator('input[type="password"]').isVisible(), false, 'Advanced bearer key is hidden until requested')
  await websiteForm.getByText('Advanced feed settings', { exact: true }).click()
  await websiteForm.getByLabel(/Alert feed path/).fill('/api/alerts')
  await websiteForm.getByLabel(/Bearer key/).fill('test-only-secret')
  await websiteForm.getByRole('button', { name: 'Validate and connect', exact: true }).click()
  const feedCard = page.locator('.website-connection').filter({ hasText: 'Demo feed' })
  await feedCard.getByText(/Feed responding/, { exact: false }).waitFor()
  assert.match(await page.locator('.website-connections__statusbar').innerText(), /Last checked/)

  await page.evaluate(() => { globalThis.__websiteFeedFixture.failChecks = true })
  await page.locator('.website-connections__statusbar').getByRole('button', { name: 'Check feeds now', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Feed timed out' }).waitFor()
  await page.evaluate(() => { globalThis.__websiteFeedFixture.failChecks = false })
  await page.locator('.website-connections__statusbar').getByRole('button', { name: 'Retry feed checks', exact: true }).click()
  await page.getByRole('alert').waitFor({ state: 'detached' })
  await page.screenshot({ path: join(here, 'connections-workflow-1100x900.png'), fullPage: true })
  await feedCard.getByRole('button', { name: 'Remove Demo feed', exact: true }).click()
  await page.getByText('No alert feeds connected.', { exact: false }).waitFor()
  assert.equal(await page.locator('.website-connection').count(), 0, 'Removing a feed clears its connected state')
  assert.deepEqual(errors, [], 'The Connections screen has no browser errors')

  console.log(JSON.stringify({ status: 'passed', baseUrl, workflow: ['no false website connections', 'collapsed shortcut catalog', 'observed native source add', 'muted routing-test guard', 'native routing test', 'advanced feed setup', 'healthy feed state', 'poll error and retry', 'feed removal'], screenshot: 'connections-workflow-1100x900.png' }, null, 2))
} catch (error) {
  await page.screenshot({ path: join(here, 'connections-workflow-failed.png'), fullPage: true }).catch(() => {})
  console.error(error)
  process.exitCode = 1
} finally {
  await browser.close()
}
