// Local owner verification diagnostic. Never writes images, descriptors or decrypted enrollment.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
const { chromium } = createRequire(import.meta.url)(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
const base = join(process.env.LOCALAPPDATA, 'ms-playwright')
const executablePath = existsSync(chromium.executablePath()) ? undefined : readdirSync(base).filter(n => /^chromium-\d+$/.test(n)).sort((a,b) => +b.split('-')[1] - +a.split('-')[1]).map(n => join(base,n,'chrome-win64/chrome.exe')).find(existsSync)
const clear = execFileSync('powershell.exe', ['-NoProfile', '-Command', `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$pkg=Get-AppxPackage com.hoverisland.app
$path=Join-Path $env:LOCALAPPDATA ('Packages\\'+$pkg.PackageFamilyName+'\\LocalCache\\Roaming\\com.hoverisland.app\\face-unlock.dpapi')
$entropy=[Text.Encoding]::UTF8.GetBytes('HoverIsland:WebsiteAlerts:Connection:v1')
$bytes=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($path),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
try { [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes)) } finally { [Array]::Clear($bytes,0,$bytes.Length) }
`], { windowsHide: true, maxBuffer: 1024 * 1024 })
const store = JSON.parse(clear.toString('utf8'))
clear.fill(0)
const known = [...store.templates, ...(store.learned ?? [])]
const similarity = (a,b) => {
  if (a.length !== b.length) return 0
  const sum = a.reduce((sum,value,i) => sum + (value-b[i]) ** 2, 0)
  const distance = Math.round(2500 * sum) / 100
  return distance === 0 ? 1 : Math.max(0, Math.min(1, (1-Math.sqrt(distance)/100-.2)/.6))
}
const browser = await chromium.launch({ headless: true, executablePath })
try {
  const context = await browser.newContext({ permissions: ['camera'] })
  const page = await context.newPage()
  await page.goto('http://127.0.0.1:1420/ambient.html', { waitUntil: 'domcontentloaded', timeout: 60000 })
  const preparation = await page.evaluate(async () => {
    const { FaceCamera, loadFaceEngine } = await import('/src/ambient/face.ts')
    window.diagnosticFaceCamera = new FaceCamera()
    const start = performance.now()
    let cameraMs=0, modelsMs=0
    await Promise.all([
      window.diagnosticFaceCamera.start().then(() => { cameraMs=performance.now()-start }),
      loadFaceEngine().then(() => { modelsMs=performance.now()-start }),
    ])
    const warm=performance.now(); await window.diagnosticFaceCamera.start()
    return { cameraMs:Math.round(cameraMs), modelsMs:Math.round(modelsMs), readyCameraMs:Math.round(performance.now()-warm) }
  })
  const frames=[]
  for(let i=0;i<6;i++) {
    const reading=await page.evaluate(async () => {
      const { faceBackend }=await import('/src/ambient/face.ts')
      const start=performance.now()
      const frame=await window.diagnosticFaceCamera.read()
      const elapsed=performance.now()-start
      const video=window.diagnosticFaceCamera.video
      const canvas=document.createElement('canvas');canvas.width=32;canvas.height=24
      const context=canvas.getContext('2d');context.drawImage(video,0,0,32,24)
      const pixels=context.getImageData(0,0,32,24).data
      let brightness=0,low=255,high=0
      for(let i=0;i<pixels.length;i+=4){const value=(pixels[i]+pixels[i+1]+pixels[i+2])/3;brightness+=value;low=Math.min(low,value);high=Math.max(high,value)}
      return { frame, ms:Math.round(elapsed), backend:faceBackend(), brightness:Math.round(brightness/(pixels.length/4)), range:Math.round(high-low) }
    })
    const sample=reading.frame.sample
    const identityPass=!!sample && known.some(template => similarity(sample.descriptor,template)>=.58)
    const livenessPass=!!sample && sample.real>=.5 && sample.live>=.5
    frames.push({ ms:reading.ms, backend:reading.backend, problem:reading.frame.problem, brightness:reading.brightness, range:reading.range, identityPass, livenessPass, matched:identityPass && livenessPass })
    sample?.descriptor.fill(0)
    if(identityPass && livenessPass) break
  }
  await page.evaluate(() => window.diagnosticFaceCamera.stop())
  const result={ boundary:'Real HP RGB camera and existing encrypted owner enrollment; actual production FaceCamera and face models in Chromium. Does not exercise the installed app closing its ambient window.', ...preparation, frames, matched:frames.some(frame=>frame.matched) }
  await writeFile('docs/verification/face-live-diagnostic.json',JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify(result,null,2))
} finally {
  known.forEach(descriptor=>descriptor.fill(0))
  await browser.close()
}
