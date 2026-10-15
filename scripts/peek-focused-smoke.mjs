import {createRequire} from 'node:module'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {existsSync,readdirSync} from 'node:fs'
import {mkdir,writeFile} from 'node:fs/promises'
import assert from 'node:assert/strict'

const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH??join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
let executablePath=process.env.PLAYWRIGHT_EXECUTABLE_PATH
if(!executablePath&&!existsSync(chromium.executablePath())){const base=join(process.env.LOCALAPPDATA??join(homedir(),'AppData/Local'),'ms-playwright');executablePath=readdirSync(base).filter(name=>/^chromium-\d+$/.test(name)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1])).map(name=>join(base,name,'chrome-win64/chrome.exe')).find(existsSync)}
const out=new URL('../docs/verification/',import.meta.url);await mkdir(out,{recursive:true})
const browser=await chromium.launch({headless:true,executablePath})
const context=await browser.newContext({viewport:{width:1000,height:700},reducedMotion:'reduce'})
const page=await context.newPage();page.setDefaultTimeout(15000)
const results=[],errors=[]
page.on('pageerror',error=>errors.push(error.message))
const shot=async name=>page.screenshot({path:new URL(name+'.png',out).pathname.replace(/^\/(\w:)/,'$1')})
const compact=()=>page.getByRole('group',{name:'Hover Island compact view. Activate to open; media controls are available inside.',exact:true})
const open=async()=>{if(!(await page.locator('.island--open').count())){const title=page.locator('.pill__compact-title').first();if(await title.count())await title.click();else await compact().click();await page.locator('.island--open').waitFor()}}
const collapse=async()=>{const button=page.getByRole('button',{name:'Collapse island',exact:true});if(await button.count())await button.click();await page.waitForFunction(()=>!document.querySelector('.island--open'))}
const dismiss=async()=>{const button=page.getByRole('button',{name:'Dismiss notification',exact:true});if(await button.count())await button.click();await page.waitForFunction(()=>!document.querySelector('.peek'))}
const settings=async patch=>page.evaluate(patch=>{const key='hover-island.preview.settings';const current=JSON.parse(localStorage.getItem(key));Object.assign(current,patch);localStorage.setItem(key,JSON.stringify(current));window.dispatchEvent(new CustomEvent('settings://changed',{detail:current}))},patch)
async function findWidget(kind){await page.getByRole('tab',{name:'Activity panel',exact:true}).click();for(let i=0;i<12;i++){if(await page.locator(`[data-widget-kind="${kind}"]`).count())return;const next=page.getByRole('button',{name:'Next widget page',exact:true});if(await next.isDisabled())break;await next.click()}throw Error('Widget not reachable: '+kind)}
try{
  await page.goto(process.env.UI_URL??'http://127.0.0.1:1420/',{waitUntil:'domcontentloaded',timeout:60000})
  await page.getByRole('dialog').waitFor()
  for(let i=0;i<6;i++)await page.getByRole('button',{name:'Next',exact:true}).click()
  await page.getByRole('button',{name:'Get started',exact:true}).click()
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('hover-island.preview.settings')??'null')?.onboardingVersion===1)
  await page.waitForTimeout(600)
  const settingsPagePromise=context.waitForEvent('page');await open();await page.getByRole('button',{name:'Open settings',exact:true}).click();const settingsPage=await settingsPagePromise
  await settingsPage.getByRole('button',{name:'Widgets',exact:true}).click();await settingsPage.locator('.wmp__tray').waitFor();await settingsPage.screenshot({path:new URL('settings-page-preview.png',out).pathname.replace(/^\/(\w:)/,'$1')});await settingsPage.close();await page.bringToFront()
  await collapse()
  await settings({dnd:false,hideBehindWindows:true,interaction:{...JSON.parse(await page.evaluate(()=>localStorage.getItem('hover-island.preview.settings'))).interaction,hoverOpen:true,openDelayMs:220,closeDelayMs:90}})

  // Compact controls should remain operable without opening the panel.
  const pause=page.getByRole('button',{name:'Pause',exact:true})
  if(await pause.count()){await pause.click();assert.equal(await page.locator('.island--open').count(),0);await page.waitForTimeout(250);assert.equal(await page.locator('.island--open').count(),0);results.push('Compact media controls respond without opening the panel')}
  await page.mouse.move(10,650);await page.waitForTimeout(150)

  // Check a genuine native foreground signal and hover signal through the preview event bridge.
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('window://foreground',{detail:true})))
  await page.waitForFunction(()=>document.querySelector('.island-stage--veiled'))
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('island://hover',{detail:true})))
  await page.waitForFunction(()=>!document.querySelector('.island-stage--veiled'))
  await page.waitForTimeout(70)
  assert.equal(await page.locator('.island--open').count(),0,'revealing the veil must not expand before the sustained-hover delay')
  await page.waitForFunction(()=>document.querySelector('.island--open'),{},{timeout:1000})
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('island://hover',{detail:false})))
  await page.waitForFunction(()=>!document.querySelector('.island--open'))
  await page.waitForFunction(()=>document.querySelector('.island-stage--veiled'))
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('window://foreground',{detail:false})))
  await page.waitForFunction(()=>!document.querySelector('.island-stage--veiled'))
  assert.equal(await page.locator('.island--open').count(),0)
  results.push('Foreground veiling reveals on hover, expands only after sustained hover, and restores after leave/collapse')

  // Confirm compact Reset Radar content always has readable titles and fits its event card.
  await open()
  for(const preset of ['small','medium','large']){
    const size={small:{collapsed:{w:256,h:36},expanded:{w:640,h:440}},medium:{collapsed:{w:320,h:38},expanded:{w:800,h:560}},large:{collapsed:{w:384,h:42},expanded:{w:960,h:640}}}[preset]
    await settings({sizePreset:preset,...size})
    await findWidget('reset-watch')
    const radar=page.locator('[data-widget-kind="reset-watch"] .reset-watch-widget')
    await page.waitForFunction(()=>Number(document.querySelector('.reset-watch-widget')?.getAttribute('data-page-size'))>0)
    const pageSize=Number(await radar.getAttribute('data-page-size'))
    assert.equal(pageSize,preset==='large'?2:1,`${preset} page size`)
    const event=radar.locator('.reset-watch__event').first(),title=event.locator('.reset-watch__event-title')
    await title.waitFor()
    const bounds=await title.evaluate(node=>{const r=node.getBoundingClientRect(),card=node.closest('.reset-watch__event').getBoundingClientRect(),style=getComputedStyle(node);return{height:r.height,lineHeight:parseFloat(style.lineHeight),scrollHeight:node.scrollHeight,clientHeight:node.clientHeight,top:r.top,bottom:r.bottom,cardTop:card.top,cardBottom:card.bottom,text:node.innerText}})
    assert.ok(bounds.height>=bounds.lineHeight-1,`${preset} announcement headline clipped: ${JSON.stringify(bounds)}`)
    assert.ok(bounds.top>=bounds.cardTop&&bounds.bottom<=bounds.cardBottom+1,`${preset} headline escapes card: ${JSON.stringify(bounds)}`)
    assert.ok(bounds.clientHeight>=bounds.lineHeight-1,`${preset} title line clipped: ${JSON.stringify(bounds)}`)
    assert.ok((await event.getAttribute('aria-label')).includes('reported by'))
    await shot('reset-radar-'+preset+'-readable')
    if(preset==='small')results.push('Reset Radar Small shows one readable linked announcement with source retained accessibly')
    if(preset==='medium')results.push('Reset Radar Medium shows one readable linked announcement with source retained accessibly')
    if(preset==='large')results.push('Reset Radar Large shows two readable announcements')
  }
  await collapse()

  // DND confirmation is a calm moon notice, then incoming notification events stay muted.
  await open()
  await page.getByRole('button',{name:'Enable Do Not Disturb',exact:true}).click()
  const mute=page.locator('.peek--mute')
  await mute.waitFor();await page.getByText('Do Not Disturb On',{exact:true}).waitFor()
  assert.equal(await mute.locator('.lucide-moon').count(),1)
  assert.equal(await mute.locator('.peek__priority').count(),0)
  const muteColor=await mute.locator('.peek__dot').evaluate(node=>getComputedStyle(node).color)
  assert.ok(!/255\s*,\s*\d{1,2}\s*,/u.test(muteColor),`DND crescent treatment should not be red: ${muteColor}`)
  await dismiss()
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('notifications://changed',{detail:[{id:'dnd-focused-check',app:'WhatsApp Desktop',title:'Muted under DND',body:'This should remain in the inbox.',timestamp:Date.now()}]})))
  await page.waitForTimeout(250)
  assert.equal(await page.locator('.peek').count(),0,'DND must suppress incoming notification peeks')
  await page.getByRole('button',{name:'Disable Do Not Disturb',exact:true}).click()
  await page.getByText('Do Not Disturb Off',{exact:true}).waitFor();await dismiss()
  results.push('Do Not Disturb confirmation uses a neutral crescent and suppresses the incoming alert peek')
  await collapse()

  // Progress phases exercise only the frontend event bridge, not a real phone transfer.
  const transfer=async(id,phase,progress,title)=>page.evaluate(value=>window.dispatchEvent(new CustomEvent('transfer://event',{detail:{...value,transferId:value.id,app:'Phone bucket',body:'Design.png · 2.4 MB',timestamp:Date.now()}})),{id,phase,progress,title})
  for(const [phase,progress,title,expected] of [['staging',.12,'Preparing Design.png','Preparing Design.png'],['sending',.46,'Sending Design.png','Sending…'],['receiving',.74,'Receiving Design.png','Receiving…'],['sent',1,'Design.png sent','Sent to phone'],['error',.3,'Transfer failed','Transfer failed']]){
    const id='peek-focused-'+phase
    await transfer(id,phase,progress,title)
    const peek=page.locator('.peek--transfer');await peek.waitFor()
    assert.equal(await peek.locator('.peek-transfer__status').innerText(),expected,phase+' transfer label')
    if(phase==='sending')assert.equal(await peek.locator('.peek-transfer__pct').innerText(),'46%')
    if(phase==='error')assert.equal(await peek.evaluate(node=>node.classList.contains('peek--failed')),true)
    await dismiss()
  }
  results.push('Synthetic staging, sending, receiving, sent and error phases render their matching transfer state')

  // Website urgent peeks must stay inside the notch at all four anchors.
  await settings({dnd:false,connections:[{id:'peek-demo-site',name:'Demo Site',url:'https://example.com',notifications:true,notificationSources:['Demo Site']}]})
  for(const edge of ['top','bottom','left','right']){
    await settings({placement:{...JSON.parse(await page.evaluate(()=>localStorage.getItem('hover-island.preview.settings'))).placement,edge}})
    await page.waitForFunction(edge=>document.querySelector(`.island--edge-${edge}`),edge)
    const id='urgent-website-'+edge
    await page.evaluate(id=>window.dispatchEvent(new CustomEvent('notifications://changed',{detail:[{id,app:'Demo Site',category:'website',priority:'urgent',title:'Stock alert needs review',body:'A linked website has an urgent update.',url:'https://example.com/alert',timestamp:Date.now()}]})),id)
    const peek=page.locator('.peek');await peek.waitFor()
    assert.equal(await peek.locator('.peek__priority').innerText(),'Urgent')
    const rects=await page.evaluate(()=>{const peek=document.querySelector('.peek').getBoundingClientRect(),island=document.querySelector('.island').getBoundingClientRect();return{peek:{x:peek.x,y:peek.y,right:peek.right,bottom:peek.bottom,width:peek.width,height:peek.height},island:{x:island.x,y:island.y,right:island.right,bottom:island.bottom,width:island.width,height:island.height}}})
    assert.ok(rects.peek.x>=rects.island.x-1&&rects.peek.y>=rects.island.y-1&&rects.peek.right<=rects.island.right+1&&rects.peek.bottom<=rects.island.bottom+1,`${edge} urgent website peek bounds: ${JSON.stringify(rects)}`)
    await shot('urgent-website-'+edge)
    await dismiss()
  }
  results.push('Urgent website peeks retain their urgency label and remain inside the island at all four placement edges')
  assert.deepEqual(errors,[])
  await writeFile(new URL('peek-focused-smoke.json',out),JSON.stringify({testedAt:new Date().toISOString(),mode:'Browser preview; native OS signals and phone transfer events are simulated',results,errors},null,2))
  console.log(JSON.stringify({results,errors},null,2))
}catch(error){console.error(JSON.stringify({error:String(error),errors,body:await page.locator('body').innerText()},null,2));await shot('peek-focused-failure');throw error}finally{await browser.close()}
