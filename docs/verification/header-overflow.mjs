import {createRequire} from 'node:module'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {existsSync,readdirSync} from 'node:fs'
import assert from 'node:assert/strict'
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH??join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
let executablePath=process.env.PLAYWRIGHT_EXECUTABLE_PATH
if(!executablePath&&!existsSync(chromium.executablePath())){const base=join(process.env.LOCALAPPDATA??join(homedir(),'AppData/Local'),'ms-playwright');executablePath=readdirSync(base).filter(n=>/^chromium-\d+$/.test(n)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1])).map(n=>join(base,n,'chrome-win64/chrome.exe')).find(existsSync)}
const browser=await chromium.launch({headless:true,executablePath})
try {
 const context=await browser.newContext({viewport:{width:1100,height:760}})
 await context.addInitScript(()=>localStorage.setItem('hover-island.preview.settings',JSON.stringify({onboardingVersion:1,panels:Object.fromEntries(Array.from({length:12},(_,i)=>['panel'+i,'A very long page name '+i])),panelOrder:Array.from({length:12},(_,i)=>'panel'+i)})))
 const page=await context.newPage()
 await page.goto(process.env.UI_URL??'http://127.0.0.1:1420/')
 await page.locator('.pill__compact-title').first().click()
 await page.locator('.island--open').waitFor()
 for(const width of [960,640,480,360]) {
  await page.setViewportSize({width,height:760})
  await page.waitForTimeout(650)
  for(const name of ['Open file beam','Open quick controls','Search Ctrl Space','Open settings','Collapse island','More actions','Next panel','Previous panel']) {
   const button=page.getByRole('button',{name,exact:true});const b=await button.boundingBox()
   assert.ok(b&&b.x>=0&&b.x+b.width<=width+1,`${name} fits at ${width}`)
   assert.ok(await button.evaluate(n=>{const r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}),`${name} is not overlapped at ${width}`)
  }
  await page.getByRole('button',{name:'Next panel',exact:true}).click()
  const selected=page.locator('.panel-tabs [aria-selected="true"]')
  await selected.waitFor()
  await page.waitForTimeout(100)
  assert.ok(await selected.evaluate(n=>{const r=n.getBoundingClientRect();const p=n.parentElement.getBoundingClientRect();return r.left>=p.left-1&&r.right<=p.right+1}),'Selected page stays in its clipped tab strip')
 }
 console.log('Header controls remain visible, reachable and unoverlapped with twelve long page names at 960/640/480/360px.')
}finally{await browser.close()}
