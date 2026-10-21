import { chromium } from '/home/claude/tools/node_modules/playwright/index.mjs'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
const FPS = 30, DUR = 46
const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-i', '/tmp/v2/score.wav',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '256k', '-shortest', '/tmp/v2/hover-island-launch.mp4'], { stdio: ['pipe', 'inherit', 'inherit'] })
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch())
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } })
await p.goto('file:///tmp/v2/film.html'); await p.waitForTimeout(500)
await p.evaluate(s => window.loadSpec(s), JSON.parse(fs.readFileSync('/tmp/v2/spectrum.json')))
const total = FPS * DUR
for (let f = 0; f < total; f++) {
  await p.evaluate(t => window.render(t), f / FPS)
  const buf = await p.screenshot({ type: 'jpeg', quality: 94 })
  if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r))
  if (f % 150 === 0) console.log('frame', f, '/', total)
}
ff.stdin.end()
await new Promise(r => ff.on('close', r))
await b.close()
console.log('done')
