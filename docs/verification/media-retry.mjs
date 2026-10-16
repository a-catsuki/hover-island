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
 const page=await browser.newPage({viewport:{width:900,height:650}})
 const errors=[];page.on('pageerror',error=>errors.push(error.message))
 await page.route('**/media-retry-fixture',route=>route.fulfill({contentType:'text/html',body:`<html><body><div id="fixture"></div><script type="module">
 let attempts=0;window.__fixtureCalls=[];window.isTauri=true;window.__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command)=>{window.__fixtureCalls.push(command);
  if(command==='media_get')return {title:'Owned test track',artist:'Owned test artist',duration:120,position:0,status:'playing',canPlay:true,canPause:true};
  if(command==='lyrics_lookup'){attempts++;return attempts===1?{status:'rate_limited',provider:'LRCLIB',lines:[],retryAfterSeconds:1}:{status:'ok',provider:'LRCLIB',lines:[{at:0,text:'Owned lyric fixture'}]}};
  if(command==='plugin:event|listen')return 1;return null;
 }};
 const {mountMediaRetry}=await import('/docs/verification/media-retry-harness.tsx');await mountMediaRetry(document.getElementById('fixture'));
 </script></body></html>`}))
 await page.goto('http://127.0.0.1:1420/media-retry-fixture')
 const retry=page.getByRole('button',{name:'Try again',exact:true})
 await retry.waitFor({timeout:15000}).catch(async error=>{console.error({errors,body:await page.locator('body').innerText(),details:await page.evaluate(()=>({native:window.isTauri,calls:window.__fixtureCalls,media:[...document.querySelectorAll('.media')].map(n=>({class:n.className,height:n.clientHeight}))}))});throw error});assert.equal(await retry.isDisabled(),true)
 await page.getByText('Ready to retry lyrics.',{exact:true}).waitFor({timeout:5000})
 assert.equal(await retry.isDisabled(),false)
 await retry.click()
 await page.getByText('Owned lyric fixture',{exact:true}).waitFor()
 assert.deepEqual(errors,[])
 console.log('Media retry harness passed: explicit mock 429 blocks retry, expires, and a deliberate retry displays owned timed-line fixture. No external lyrics request or physical native playback is covered.')
}finally{await browser.close()}
