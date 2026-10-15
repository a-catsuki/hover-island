import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH ?? join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
let executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH
if (!executablePath && !existsSync(chromium.executablePath())) {
  const base = join(process.env.LOCALAPPDATA, 'ms-playwright')
  executablePath = readdirSync(base).filter(name => /^chromium-\d+$/.test(name)).sort((a,b) => Number(b.split('-')[1])-Number(a.split('-')[1])).map(name => join(base,name,'chrome-win64/chrome.exe')).find(existsSync)
}
const url = process.env.PHONE_BUCKET_URL
assert.ok(url, 'Start the ignored native phone_browser_fixture and supply PHONE_BUCKET_URL')
const browser = await chromium.launch({ headless: true, executablePath })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
page.setDefaultTimeout(20000)
try {
  await page.goto(url)
  await page.getByText('Files you send from this phone, or that your PC adds, appear here.', {exact:true}).waitFor()
  await page.getByLabel('Choose files or photos', {exact:true}).setInputFiles([
    { name: 'from-phone.txt', mimeType: 'text/plain', buffer: Buffer.from('A little file from a phone.') },
    { name: 'photo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>') },
  ])
  await page.getByRole('button', {name:'Send 2 files to PC',exact:true}).waitFor()
  assert.equal((await (await context.request.get(`${url}/api/files`)).json()).files.length,0, 'Selection should stage until Send')
  await page.getByRole('button', {name:'Remove photo.svg',exact:true}).click()
  await page.getByRole('button', {name:'Send 1 file to PC',exact:true}).click()
  await page.getByText('1 file saved on your PC.', {exact:true}).waitFor()
  const list = (await (await context.request.get(`${url}/api/files`)).json()).files
  assert.equal(list.length,1)
  const downloaded = await context.request.get(`${url}/api/files/${list[0].id}`)
  assert.equal(await downloaded.text(),'A little file from a phone.')
  const staged = await context.request.put(`${url}/api/files?name=from-pc.txt`, {headers:{Origin:new URL(url).origin,'Content-Type':'application/octet-stream'},data:'From the PC bucket.'})
  assert.equal(staged.status(),200)
  await page.getByRole('link',{name:'Download from-pc.txt',exact:true}).waitFor()
  const download = page.waitForEvent('download')
  await page.getByRole('link',{name:'Download from-pc.txt',exact:true}).click()
  const file = await download
  assert.equal(file.suggestedFilename(),'from-pc.txt')
  assert.equal(await readFile(await file.path(),'utf8'),'From the PC bucket.')
  await page.getByText('New from your PC: from-pc.txt',{exact:true}).waitFor()
  const zipDownload=page.waitForEvent('download')
  await page.getByRole('link',{name:'Download all ZIP',exact:true}).click()
  const zipFile=await zipDownload
  const zipBytes=await readFile(await zipFile.path())
  assert.equal(zipBytes.readUInt32LE(0),0x04034b50)
  for(const expected of ['from-phone.txt','from-pc.txt','A little file from a phone.','From the PC bucket.'])assert.ok(zipBytes.includes(Buffer.from(expected)),expected+' missing from downloaded bucket ZIP')
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  await page.screenshot({path:new URL('../docs/verification/phone-bucket.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')})
  assert.deepEqual(errors,[])
  const result={testedAt:new Date().toISOString(),mode:'Mobile Chromium against real Rust HTTP router on loopback; physical iPhone and LAN firewall remain untested',checks:['Stage multiple files and remove before sending','One Send action uploads and saves exact bytes','PC-staged file appears and downloads with exact name and bytes','New PC files show a banner; Download all ZIP contains both exact file payloads','390px phone layout and no browser errors'],errors}
  await writeFile(new URL('../docs/verification/phone-smoke.json',import.meta.url),JSON.stringify(result,null,2))
  console.log(JSON.stringify(result,null,2))
} finally { await browser.close() }
