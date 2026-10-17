import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

const { chromium } = createRequire(import.meta.url)(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
const base = join(process.env.LOCALAPPDATA, 'ms-playwright')
const executablePath = existsSync(chromium.executablePath()) ? undefined : readdirSync(base).filter(n => /^chromium-\d+$/.test(n)).sort((a,b) => +b.split('-')[1] - +a.split('-')[1]).map(n => join(base,n,'chrome-win64/chrome.exe')).find(existsSync)
const browser = await chromium.launch({headless:true, executablePath})
const page = await browser.newPage({viewport:{width:1200,height:800}, reducedMotion:'reduce'})
const errors = []
page.on('pageerror',error=>errors.push(error.message))
await page.addInitScript(()=>localStorage.setItem('hover-island.preview.settings',JSON.stringify({onboardingVersion:1,placement:{mode:'notch',edge:'top'},interaction:{hoverOpen:false},compactItems:['media','clock']})))
try {
  await page.goto('http://127.0.0.1:1420/',{waitUntil:'domcontentloaded'})
  await page.locator('.island').waitFor()
  const masks = await page.evaluate(async()=>{
    const {magneticNotchPath} = await import('/src/lib/magneticShape.ts')
    const records=[]
    for(const edge of ['top','bottom','left','right']) for(const [width,height] of [[256,36],[320,38],[384,42]]) {
      const side=edge==='left'||edge==='right'
      const w=side?56:width,h=side?144:height
      const path=magneticNotchPath(1200,800,w,h,edge,0,0).slice(6,-2)
      const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=800
      const ctx=canvas.getContext('2d');ctx.fillStyle='#000';ctx.fill(new Path2D(path))
      const pixels=ctx.getImageData(0,0,1200,800).data
      let mismatch=0,filled=0
      for(let y=0;y<800;y++)for(let x=0;x<1200;x++) {
        const a=pixels[(y*1200+x)*4+3]
        const b=pixels[((side?799-y:y)*1200+(side?x:1199-x))*4+3]
        if((a>127)!==(b>127))mismatch++
        if(a>127)filled++
      }
      records.push({edge,w,h,mismatch,filled})
    }
    return records
  })
  for(const mask of masks){assert.ok(mask.mismatch<=4,`symmetric corners: ${JSON.stringify(mask)}`);assert.ok(mask.filled>mask.w*mask.h*.94,'notch is a full attached rectangle with lower corners')}
  const resting = await page.locator('.island').evaluate(n=>({clip:getComputedStyle(n).clipPath,black:getComputedStyle(n,'::before').backgroundColor,opacity:getComputedStyle(n,'::before').opacity}))
  assert.ok(resting.clip.startsWith('path('))
  assert.equal(resting.black,'rgb(0, 0, 0)')
  assert.equal(resting.opacity,'1')
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('media://changed',{detail:null})))
  assert.equal(await page.locator('.pill__compact-controls').count(),0,'no dead media buttons without a media session')
  await page.screenshot({path:'docs/verification/notch-resting.png'})
  const opening=await page.evaluate(async()=>{
    matchMedia('(prefers-reduced-motion: reduce)')
    const ui=await import('/src/state/ui.ts');ui.expandIsland()
    await new Promise(requestAnimationFrame)
    return getComputedStyle(document.querySelector('.island')).clipPath
  })
  assert.notEqual(opening,resting.clip,'expanded shape follows the published frame')
  assert.deepEqual(errors,[])
  const record={testedAt:new Date().toISOString(),masks,resting,pageErrors:errors,boundary:'Rendered production shape helper and real shell in browser; native placement tested separately.'}
  await writeFile('docs/verification/notch-silhouette.json',JSON.stringify(record,null,2)+'\n')
  console.log(JSON.stringify(record,null,2))
} finally {await browser.close()}
