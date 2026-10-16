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
try {
const context=await browser.newContext({viewport:{width:1000,height:700},permissions:['clipboard-read','clipboard-write']})
await context.addInitScript(()=>localStorage.setItem('hover-island.preview.settings',JSON.stringify({onboardingVersion:1,interaction:{hoverOpen:false},notifications:{enabled:true,sound:'off'},modules:{notifications:true}})))
const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message))
await page.goto('http://127.0.0.1:1421/');await page.locator('.island').waitFor()
const inject=async(id,expiry)=>page.evaluate(({id,expiry})=>window.dispatchEvent(new CustomEvent('auth://code',{detail:{id,code:'004291',sender:'security@example.com',subject:'Owned sign-in fixture',account:'me@example.com',receivedAt:Date.now(),expiresAt:Date.now()+expiry}})),{id,expiry})
await inject('owned-code',600000);await page.locator('.peek__auth-code').getByText('004291',{exact:true}).waitFor()
await page.waitForTimeout(500)
const geometry=await page.locator('.live-activity').evaluate(shell=>{const box=shell.getBoundingClientRect(),peek=shell.querySelector('.peek').getBoundingClientRect(),code=shell.querySelector('.peek__auth-code').getBoundingClientRect();return {shell:{x:box.x,y:box.y,w:box.width,h:box.height},peek:{x:peek.x,y:peek.y,w:peek.width,h:peek.height},code:{x:code.x,y:code.y,w:code.width,h:code.height},transform:getComputedStyle(shell.querySelector('.peek')).transform}})
assert.ok(Math.abs(geometry.shell.x-geometry.peek.x)<1);assert.ok(Math.abs(geometry.shell.y-geometry.peek.y)<1);assert.ok(Math.abs(geometry.shell.w-geometry.peek.w)<1);assert.ok(Math.abs(geometry.shell.h-geometry.peek.h)<1)
assert.ok(geometry.code.x>=geometry.shell.x&&geometry.code.x+geometry.code.w<=geometry.shell.x+geometry.shell.w)
assert.equal(await page.locator('.peek__close').count(),0)
await page.screenshot({path:'docs/verification/email-code-live-activity.png'})
await page.locator('.peek').waitFor({state:'detached',timeout:10000})
const badge=page.getByRole('button',{name:/Verification code 004291; activate/});await badge.waitFor();await badge.click()
await page.getByRole('button',{name:'Copy verification code',exact:true}).click()
assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'004291')
await inject('expired-code',-1);assert.equal(await page.locator('.peek--auth').count(),0)
assert.deepEqual(errors,[])
const result={passed:true,mode:'Production browser with owned auth event, no real inbox access',geometry,checks:['Full-notch activity matches shell','Collapsed code remains accessible','Copy writes owned fixture and dismisses','Expired event ignored'],errors}
await writeFile('docs/verification/email-code-ui.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
}finally{await browser.close()}
