import {createRequire} from 'node:module'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {existsSync,readdirSync} from 'node:fs'
import assert from 'node:assert/strict'
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH??join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
let executablePath=process.env.PLAYWRIGHT_EXECUTABLE_PATH
if(!executablePath&&!existsSync(chromium.executablePath())){const base=join(process.env.LOCALAPPDATA??join(homedir(),'AppData/Local'),'ms-playwright');executablePath=readdirSync(base).filter(n=>/^chromium-\d+$/.test(n)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1])).map(n=>join(base,n,'chrome-win64/chrome.exe')).find(existsSync)}
import {writeFile} from 'node:fs/promises'
const browser=await chromium.launch({headless:true,executablePath})
const results=[]
try {
 for(const [width,height] of [[586,326],[746,446],[906,526]]) for(const count of [0,1,24]) {
 const page=await browser.newPage({viewport:{width:width+80,height:height+80}})
 const errors=[];page.on('pageerror',error=>errors.push(error.message))
 await page.route('**/beam-fixture',route=>route.fulfill({contentType:'text/html',body:`<html><body style="background:#17191c;padding:20px"><div id="fixture" style="width:${width}px;height:${height}px;background:#0c0e11;border-radius:24px;padding:20px;box-sizing:border-box"></div><script type="module">
 window.isTauri=true;window.__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command)=>{
 if(command==='transfer_status')return {active:true,phoneUrl:'http://192.0.2.1/phone',qrDataUrl:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="white"/><path d="M10 10h30v30H10z M80 10h30v30H80z M10 80h30v30H10z M50 50h20v20H50z" fill="black"/></svg>'),expiresAt:Date.now()+1800000,files:Array.from({length:${count}},(_,i)=>({id:String(i),name:i%2?'Presentation final version with a long title.pdf':'Photo of the trip.jpg',size:327000,createdAt:Date.now()})),maxFileBytes:104857600,maxBucketBytes:524288000};
 if(command==='transfer_pairing_status')return {devices:[{id:'phone',name:'My iPhone',online:true}],pending:[]};return null;}};
 const {mount}=await import('/docs/verification/beam-harness.tsx');mount(document.getElementById('fixture'));
 </script></body></html>`}))
 await page.goto('http://127.0.0.1:1420/beam-fixture')
 await page.locator('.beam__qr').waitFor({timeout:45000})
 await page.waitForTimeout(150)
 const bounds=await page.locator('.beam').evaluate(root=>{const box=root.getBoundingClientRect();return {scroll:root.scrollHeight,height:root.clientHeight,overflow:[...root.querySelectorAll('.beam__header,.beam__connect,.beam__bucket,.beam__footer,.beam__file')].filter(n=>{const r=n.getBoundingClientRect();return r.bottom>box.bottom+1||r.right>box.right+1||r.left<box.left-1}).map(n=>n.className)}})
 assert.deepEqual(bounds.overflow,[],`${width}/${count} children contained`)
 assert.ok(bounds.scroll<=bounds.height+1,`${width}/${count} no outer scrolling`)
 if(count===24){assert.ok(await page.getByRole('button',{name:'Next files',exact:true}).count());await page.getByRole('button',{name:'Next files',exact:true}).click()}
 await page.locator('#fixture').screenshot({path:`docs/verification/beam-${width}-${count}.png`})
 await page.getByRole('button',{name:'Connection details',exact:true}).click();await page.getByRole('heading',{name:'Your connection'}).waitFor();await page.getByRole('button',{name:'Back to files'}).click()
 assert.deepEqual(errors,[])
 results.push({width,height,count,...bounds,errors});await page.close()
 }
 await writeFile('docs/verification/beam-layout.json',JSON.stringify(results,null,2))
 console.log(`Beam layout passed: ${results.length} size/file cases, bounded rows, file paging and connection details.`)
}finally{await browser.close()}
