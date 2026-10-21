import { chromium } from '/home/claude/tools/node_modules/playwright/index.mjs'
import fs from 'node:fs'
const BG = '/mnt/user-data/uploads/hover-island/video/assets/bg/desktop-landscape.png'
const bgData = 'data:image/png;base64,' + fs.readFileSync(BG).toString('base64')
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch())
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: '/tmp/vid/raw', size: { width: 1920, height: 1080 } } })
const created = Date.now()
const page = await ctx.newPage()
await page.addInitScript(() => { try { localStorage.setItem('hover-island.onboarding.complete', '1'); localStorage.setItem('hover-island.preview.nearby', 'true') } catch {} })
await page.goto('http://localhost:5392', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1800)
for (let i = 0; i < 6; i++) { const skip = page.getByRole('button', { name: /^(Skip tour)$/ }); if (await skip.count()) { await skip.first().click().catch(() => {}); await page.waitForTimeout(300) } else break }
await page.waitForTimeout(1500)
await page.addStyleTag({ content: `
  html { background: #05070b !important; }
  html::before { content:''; position: fixed; inset: 0; background: url(${bgData}) center/cover no-repeat; filter: brightness(1.9) saturate(1.35) contrast(1.05); z-index: -1; }
  body { background: transparent !important; }
  #root { transform-origin: 50% 0; transform: scale(2.4); transition: transform 1100ms cubic-bezier(.3,.7,.2,1); }
  body > *:not(#root):not(script):not(style):not(.vid) { }
  .preview-label { display:none !important }
  #vid-cursor { position: fixed; left:0; top:0; width: 26px; height: 32px; z-index: 99999; pointer-events:none; transform: translate(-100px,-100px); filter: drop-shadow(0 2px 4px rgba(0,0,0,.5)); }
  .vid-cap { position: fixed; left: 0; right: 0; bottom: 7%; text-align: center; z-index: 99998; pointer-events:none;
    font: 700 56px/1.15 Inter, 'Segoe UI', system-ui, sans-serif; letter-spacing: -0.02em; color: #fff; text-shadow: 0 2px 24px rgba(0,0,0,.7);
    opacity: 0; transform: translateY(14px); transition: opacity 360ms ease, transform 420ms cubic-bezier(.2,.8,.2,1); }
  .vid-cap.on { opacity: 1; transform: none; }
  .vid-cap small { display:block; margin-top: 10px; font: 500 28px/1.2 Inter, system-ui, sans-serif; color: rgba(255,255,255,.72); letter-spacing: 0; }
  .vid-title { position: fixed; inset: 0; display: grid; place-items: center; z-index: 99997; pointer-events:none; opacity:0; transition: opacity 600ms ease; background: radial-gradient(ellipse at center, rgba(0,0,0,.55), rgba(0,0,0,.2)); }
  .vid-title.on { opacity: 1; }
  .vid-title div { text-align:center; font: 800 120px/1 Inter, system-ui, sans-serif; letter-spacing: -0.04em; color:#fff; }
  .vid-title small { display:block; margin-top: 22px; font: 500 30px/1.2 Inter, system-ui, sans-serif; letter-spacing: 0; color: rgba(255,255,255,.8); }
  .vid-fade { position: fixed; inset:0; background:#000; z-index: 100000; opacity:0; pointer-events:none; transition: opacity 900ms ease; }
  .vid-fade.on { opacity:1; }
`})
await page.evaluate(() => {
  const mk = (cls, html = '') => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; document.body.appendChild(d); return d }
  const cur = document.createElement('div'); cur.id = 'vid-cursor'
  cur.innerHTML = '<svg width="26" height="32" viewBox="0 0 22 28" fill="none"><path d="M3.2 2.4 3.2 21.6 7.7 17.5 10.7 24.6 14.2 23.1 11.2 16.2 17.3 16.2Z" fill="#000" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg>'
  document.body.appendChild(cur)
  window.__cap = mk('vid-cap'); window.__title = mk('vid-title'); window.__fade = mk('vid-fade')
  document.addEventListener('mousemove', e => { cur.style.transform = `translate(${e.clientX}px, ${e.clientY}px)` }, true)
  window.cap = (html) => { const c = window.__cap; if (!html) { c.classList.remove('on'); return } c.classList.remove('on'); void c.offsetWidth; c.innerHTML = html; requestAnimationFrame(() => c.classList.add('on')) }
  window.title = (html) => { const t = window.__title; if (!html) { t.classList.remove('on'); return } t.innerHTML = '<div>' + html + '</div>'; t.classList.add('on') }
  window.fade = (on) => window.__fade.classList.toggle('on', on)
})
const flash = () => page.evaluate(() => { const f = document.createElement('div'); f.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:2147483647'; document.body.appendChild(f); setTimeout(() => f.remove(), 300) })
const T0 = Date.now()
await flash()
const offset = (T0 - created) / 1000
const at = async (t, fn) => { const wait = t * 1000 - (Date.now() - T0); if (wait > 0) await page.waitForTimeout(wait); console.log('step', t, 'actual', ((Date.now() - T0) / 1000).toFixed(2)); await fn() }
const glide = async (x, y, steps = 28) => { await page.mouse.move(x, y, { steps }) }
const S = 2.4
const scale = (v) => page.evaluate(x => { document.getElementById('root').style.transform = `scale(${x})` }, v)
const cap = (html) => page.evaluate(h => window.cap(h), html)
await page.mouse.move(1400, 700)
await at(0.9, () => cap('Your PC has a notch now.'))
await at(3.2, () => cap('Not a widget.<br>Not another window.'))
await at(6.0, async () => { await cap('A small, quiet surface at the top of your screen.'); await glide(980, 120, 40) })
await at(8.2, async () => { await glide(960, 16 * S, 30); await scale(1.7) })
await at(9.5, async () => { await cap("Everything you check a hundred times a day."); await glide(960, 16 * S, 18) })
await at(11.8, async () => { await cap(null) })
await at(13.3, async () => { await cap('Music, with a visualizer that actually listens.<small>Lyrics scroll in time. Spotify, Apple Music, anything.</small>') })
await at(17.6, async () => { await cap('Weather, your calendar, and the controls you reach for.'); const tabs = page.locator('.panel-tabs [role="tab"]'); const b = await tabs.nth(1).boundingBox(); if (b) await glide(b.x + b.width / 2, b.y + b.height / 2, 20); await page.waitForTimeout(250); await tabs.nth(1).click().catch(() => {}) })
await at(19.6, async () => { const tabs = page.locator('.panel-tabs [role="tab"]'); const b = await tabs.nth(0).boundingBox(); if (b) await glide(b.x + b.width / 2, b.y + b.height / 2, 20); await page.waitForTimeout(250); await tabs.nth(0).click().catch(() => {}) })
await at(21.4, async () => { await cap('Drag a file onto it and it is on your phone.<small>Same Wi-Fi. One scan. No cloud.</small>'); const b = await page.locator('.beam-button').boundingBox(); if (b) await glide(b.x + b.width / 2, b.y + b.height / 2, 24); await page.waitForTimeout(300); await page.locator('.beam-button').click().catch(() => {}) })
await at(24.4, async () => { const chip = page.locator('.beam__chip').first(); const b = await chip.boundingBox().catch(() => null); if (b) { await glide(b.x + b.width / 2, b.y + b.height / 2, 20); await page.waitForTimeout(250); await chip.click().catch(() => {}) } })
await at(27.2, async () => { await cap(null); await glide(1500, 900, 20); await page.keyboard.press('Escape').catch(() => {}) })
await at(27.7, async () => { await scale(2.4) })
await at(28.0, async () => { await page.evaluate(() => window.title('Hover Island<small>Rust and Tauri. A five megabyte installer.</small>')) })
await at(33.2, async () => { await page.evaluate(() => { window.title(null) }); await cap('Free for Windows 10 and 11.<small>hover-island.vercel.app</small>') })
await at(36.0, async () => { await cap('The notch was always the good part.') })
await at(38.4, async () => { await page.evaluate(() => window.fade(true)) })
await at(40.0, async () => { await page.evaluate(() => window.fade(false)); await flash() })
await at(41.0, async () => {})
await ctx.close()
const vid = await page.video().path()
fs.writeFileSync('/tmp/vid/offset.txt', String(offset))
console.log('video', vid, 'offset', offset)
await browser.close()
