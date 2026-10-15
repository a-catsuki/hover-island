import assert from 'node:assert/strict';
import {createRequire} from 'node:module'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {existsSync,readdirSync} from 'node:fs'
import {mkdir,writeFile} from 'node:fs/promises'

const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH??join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
let executablePath=process.env.PLAYWRIGHT_EXECUTABLE_PATH
if(!executablePath&&!existsSync(chromium.executablePath())){const base=join(process.env.LOCALAPPDATA??join(homedir(),'AppData/Local'),'ms-playwright');executablePath=readdirSync(base).filter(name=>/^chromium-\d+$/.test(name)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1])).map(name=>join(base,name,'chrome-win64/chrome.exe')).find(existsSync)}

const phoneBucketUrl = process.env.PHONE_BUCKET_URL;
assert.ok(phoneBucketUrl, 'Set PHONE_BUCKET_URL from the ignored native fixture output.');

const baseUrl = new URL(phoneBucketUrl);
const origin = baseUrl.origin;
const bucketPath = baseUrl.pathname.replace(/\/$/, '');
const seedBytes = Buffer.from('owned phone browser smoke seed\n');
const uploadBytes = Buffer.from('browser-to-PC upload smoke\n');

const browser = await chromium.launch({ headless: true, executablePath });
try {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  await page.goto(phoneBucketUrl);
  await page.locator('#name').fill('Browser smoke phone');
  await page.locator('#remember').click();
  const code = await page.locator('#code strong').textContent({ timeout: 10_000 });
  assert.match(code?.trim() ?? '', /^\d{6}$/, 'Pairing page should show a six-digit code.');

  // The ignored native test fixture approves only this named request.
  await page.waitForSelector('#picker', { timeout: 20_000 });
  await page.locator('#picker').setInputFiles({
    name: 'browser-upload-smoke.txt',
    mimeType: 'text/plain',
    buffer: uploadBytes,
  });
  await page.locator('#send').click();
  await page.waitForFunction(
    () => document.querySelector('#status')?.textContent?.includes('1 file saved on your PC.'),
    null,
    { timeout: 15_000 },
  );
  await page.waitForSelector('#files a[aria-label="Download smoke-seed.txt"]', {
    timeout: 10_000,
  });

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#files a[aria-label="Download smoke-seed.txt"]').click();
  const download = await downloadPromise;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), seedBytes, 'Downloaded PC fixture bytes should match.');

  // The stable bookmark should use the saved HttpOnly cookie to return to this session.
  await page.goto(`${origin}/device`);
  assert.equal(new URL(page.url()).pathname, bucketPath, 'Saved phone bookmark should open bucket.');
  await page.waitForSelector('#picker');

  // A fresh browser context has no paired cookie and must not see bucket contents.
  const unpairedContext = await browser.newContext();
  const unpairedPage = await unpairedContext.newPage();
  await unpairedPage.goto(phoneBucketUrl);
  await unpairedPage.waitForSelector('#remember');
  const unauthenticatedStatus = await unpairedPage.evaluate(async (path) => {
    const response = await fetch(`${path}/api/files`, { cache: 'no-store' });
    return response.status;
  }, bucketPath);
  assert.equal(unauthenticatedStatus, 401, 'Unpaired browser should not access file listing.');
  await unpairedContext.close();

  // This marker tells the ignored native fixture it can stop and clean its owned temp data.
  const markerStatus = await page.evaluate(async (path) => {
    const response = await fetch(`${path}/api/files?name=phone-pairing-smoke-complete.txt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: 'complete',
    });
    return response.status;
  }, bucketPath);
  assert.equal(markerStatus, 200, 'Completion marker upload should succeed.');
  await context.close();
  console.log('Phone pairing browser smoke passed.');
} catch (error) {
  // Do not print the fixture URL: it contains the temporary session token.
  console.error('Phone pairing browser smoke failed.');
  console.error(String(error).replace(/https?:\/\/[^\s"']+/g, '[local fixture URL]'));
  process.exitCode = 1;
} finally {
  await browser.close();
}

