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
const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 })
await context.addInitScript(() => localStorage.setItem('hover-island.preview.settings', JSON.stringify({
  onboardingVersion: 1,
  placement: { mode: 'notch', edge: 'top' },
  interaction: { hoverOpen: true, openDelayMs: 120, closeDelayMs: 300 },
  hideBehindWindows: false,
})))
const page = await context.newPage()
page.setDefaultTimeout(15000)
const errors = []
const output = join(process.cwd(), 'docs', 'verification', 'drop-toast-preview')
await mkdir(output, { recursive: true })
page.on('pageerror', error => errors.push(error.message))

async function setPlacement(edge, mode = 'notch') {
  await page.evaluate(({ edge, mode }) => {
    const key = 'hover-island.preview.settings'
    const settings = JSON.parse(localStorage.getItem(key))
    settings.placement = { ...settings.placement, mode, edge }
    localStorage.setItem(key, JSON.stringify(settings))
    window.dispatchEvent(new CustomEvent('settings://changed', { detail: settings }))
  }, { edge, mode })
  await page.waitForFunction(edge => document.querySelector('.island')?.classList.contains(`island--edge-${edge}`), edge)
}

async function dispatchFileDrag(type, x, y) {
  await page.evaluate(({ type, x, y }) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['synthetic preview bytes'], 'preview-only.txt', { type: 'text/plain' }))
    const event = new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: transfer })
    document.querySelector('.island-stage').dispatchEvent(event)
  }, { type, x, y })
}

function center(rect) { return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } }

try {
  await page.goto(process.env.UI_URL ?? 'http://127.0.0.1:1420/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.locator('.island').waitFor()
  const edgeCases = []

  const placements = [
    ...['top', 'bottom', 'left', 'right'].map(edge => ({ edge, mode: 'notch' })),
    ...['left', 'right'].map(edge => ({ edge, mode: 'sidebar' })),
    ...['top', 'bottom'].map(edge => ({ edge, mode: 'bar' })),
  ]
  for (const { edge, mode } of placements) {
    await setPlacement(edge, mode)
    await dispatchFileDrag('dragover', 600, 400)
    const toast = page.locator('.file-drop-toast')
    await toast.waitFor()
    await page.waitForFunction(side => {
      const style = document.querySelector('.island')?.style
      return Math.abs(Number.parseFloat(style?.getPropertyValue('--island-spring-width') ?? '0') - (side ? 420 : 366)) < .5
        && Math.abs(Number.parseFloat(style?.getPropertyValue('--island-spring-height') ?? '0') - (side ? 110 : 92)) < .5
    }, edge === 'left' || edge === 'right')
    const bounds = await toast.boundingBox()
    const stage = await page.locator('.island-stage').boundingBox()
    const host = await page.locator('.island').boundingBox()
    const side = edge === 'left' || edge === 'right'
    const frame = { width: side ? 420 : 366, height: side ? 110 : 92 }
    frame.x = side ? (edge === 'left' ? host.x : host.x + host.width - frame.width) : host.x + (host.width - frame.width) / 2
    frame.y = side ? host.y + (host.height - frame.height) / 2 : edge === 'top' ? host.y : host.y + host.height - frame.height
    const targets = {}
    for (const name of ['recycle', 'beam']) {
      const target = page.locator(`[data-drop-target="${name}"]`)
      const rect = await target.boundingBox()
      assert.ok(rect && rect.width > 0 && rect.height > 0, `${edge} ${name} target has visible bounds`)
      assert.ok(rect.x >= frame.x - 1 && rect.x + rect.width <= frame.x + frame.width + 1
        && rect.y >= frame.y - 1 && rect.y + rect.height <= frame.y + frame.height + 1, `${mode} ${edge} ${name} is inside the visible spring clip`)
      targets[name] = rect
      const point = center(rect)
      await dispatchFileDrag('dragover', point.x, point.y)
      await page.waitForFunction(name => document.querySelector(`[data-drop-target="${name}"]`)?.classList.contains('file-drop-toast__target--active'), name)
      assert.equal(await page.locator('.island').evaluate(node => node.classList.contains('island--open')), false, `${edge} drag highlight keeps the dashboard closed`)
    }
    await page.screenshot({ path: join(output, `${mode}-${edge}-beam.png`) })
    const centerGap = center({
      x: targets.recycle.x + targets.recycle.width,
      y: targets.recycle.y,
      width: targets.beam.x - (targets.recycle.x + targets.recycle.width),
      height: Math.min(targets.recycle.height, targets.beam.height),
    })
    await dispatchFileDrag('dragover', centerGap.x, centerGap.y)
    await page.waitForFunction(() => [...document.querySelectorAll('.file-drop-toast__target')].every(node => !node.classList.contains('file-drop-toast__target--active')))

    await page.evaluate(() => window.dispatchEvent(new CustomEvent('island://hover', { detail: true })))
    await page.waitForTimeout(300)
    assert.equal(await page.locator('.island').evaluate(node => node.classList.contains('island--open')), false, `${edge} hover cannot expand the dashboard during file drag`)

    if (side) {
      if (mode === 'notch')
      assert.equal(await page.locator('.island').evaluate(node => node.classList.contains('island--notch-side')), true, `${edge} exercises the vertical side notch pill`)
      assert.ok(bounds.x >= stage.x - 1 && bounds.x + bounds.width <= stage.x + stage.width + 1, `${edge} toast fits the side host bounds`)
    } else {
      assert.ok(bounds.y >= stage.y - 1 && bounds.y + bounds.height <= stage.y + stage.height + 1, `${edge} toast fits the edge host bounds`)
    }
    edgeCases.push({ edge, mode, frame, toast: bounds, targets })
    await dispatchFileDrag('dragleave', centerGap.x, centerGap.y)
    await toast.waitFor({ state: 'detached' })
  }

  // Synthetic HTML5 preview drops exercise the shared preview handler only.
  // They never invoke a native recycle command or prove OS Recycle Bin behavior.
  await setPlacement('top')
  await dispatchFileDrag('dragover', 600, 400)
  await page.locator('.file-drop-toast').waitFor()
  const recycleBox = await page.locator('[data-drop-target="recycle"]').boundingBox()
  const recyclePoint = center(recycleBox)
  await dispatchFileDrag('drop', recyclePoint.x, recyclePoint.y)
  await page.waitForFunction(() => !document.querySelector('.file-drop-toast'))
  assert.deepEqual(errors, [], 'preview has no uncaught page errors')

  const result = {
    url: process.env.UI_URL ?? 'http://127.0.0.1:1420/',
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: 2,
    edgeCases,
    previewRelease: 'Recycle-target drop closed the preview without invoking native recycling.',
    nativeBehavior: 'Tauri event delivery, temporary native hit bounds, and real Recycle Bin/Beam operations are not covered by this browser script.',
    pageErrors: errors,
  }
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser.close()
}
