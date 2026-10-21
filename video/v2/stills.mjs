import { chromium } from '/home/claude/tools/node_modules/playwright/index.mjs'
import fs from 'node:fs'
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch())
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } })
const errs = []; p.on('pageerror', e => errs.push(e.message))
await p.goto('file:///tmp/v2/film.html'); await p.waitForTimeout(500)
await p.evaluate(s => window.loadSpec(s), JSON.parse(fs.readFileSync('/tmp/v2/spectrum.json')))
const ts = process.argv.slice(2).map(Number)
for (const t of ts) { await p.evaluate(t => window.render(t), t); await p.screenshot({ path: `/tmp/v2/s_${t}.jpg`, type: 'jpeg', quality: 80 }) }
console.log(errs.join('\n') || 'no errors')
await b.close()
