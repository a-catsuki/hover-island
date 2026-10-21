const BASE = 'http://localhost:5210/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async ({ page, log }) => {
  page.setDefaultTimeout(20000);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    const cur = JSON.parse(localStorage.getItem('hover-island.preview.settings') ?? '{}');
    localStorage.setItem(
      'hover-island.preview.settings',
      JSON.stringify({
        ...cur,
        onboardingVersion: 1,
        panels: { today: 'Today', desk: 'Desk', activity: 'Activity' },
        panelOrder: ['today', 'desk', 'activity'],
        panelNames: {},
        opacity: 1,
        widgets: [
          { id: 'w-media', kind: 'media', enabled: true, order: 0 },
          { id: 'w-weather', kind: 'weather', enabled: true, order: 1 },
        ],
      }),
    );
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(900);
  await page.addStyleTag({ content: 'html,body{background:transparent!important}.preview-label{display:none!important}' });
  const state = async (tag) => {
    const s = await page.evaluate(() => ({
      open: !!document.querySelector('.island--open'),
      cls: document.querySelector('.island')?.className,
      box: (() => {
        const r = document.querySelector('.island')?.getBoundingClientRect();
        return r ? [Math.round(r.width), Math.round(r.height), Math.round(r.x), Math.round(r.y)] : null;
      })(),
      peek: !!document.querySelector('.live-activity .peek'),
      tabs: [...document.querySelectorAll('.panel-tabs [role="tab"]')].map((t) => t.textContent?.trim()),
    }));
    log(tag + ' ' + JSON.stringify(s));
  };
  await state('load');
  const title = await page.$('.pill__compact-title');
  log('title ' + !!title);
  if (title) await title.click();
  await sleep(600);
  await state('after-click');
  const more = await page.$('[aria-label="More actions"]');
  log('more ' + !!more);
  if (more) {
    await more.click();
    await sleep(250);
    const items = await page.$$eval('[role="menuitemcheckbox"], [role="menuitem"]', (els) =>
      els.map((e) => ({ role: e.getAttribute('role'), text: e.textContent?.trim(), checked: e.getAttribute('aria-checked') })),
    );
    log('menu ' + JSON.stringify(items));
    const pin = await page.$$('[role="menuitemcheckbox"]');
    for (const p of pin) {
      const label = await page.evaluate((el) => el.textContent ?? '', p);
      if (/keep island open|unpin/i.test(label)) {
        await p.click();
        log('clicked ' + label);
        break;
      }
    }
    await sleep(400);
  }
  await state('after-pin');
  await page.mouse.move(6, 980);
  await sleep(700);
  await state('mouse-away');
  await page.mouse.move(6, 10);
  await sleep(700);
  await state('mouse-top');
};
