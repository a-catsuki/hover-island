const BASE = 'http://localhost:5210/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async ({ page, log, screenshot }) => {
  page.setDefaultTimeout(30000);
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
        sizePreset: 'medium',
        expanded: { w: 800, h: 510 },
        weatherCity: 'New Delhi',
        weatherLat: 28.61,
        weatherLon: 77.21,
        weatherAutoLocation: false,
        widgets: [
          { id: 'w-media', kind: 'media', enabled: true, order: 0 },
          { id: 'w-weather', kind: 'weather', enabled: true, order: 1 },
        ],
      }),
    );
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(800);
  await page.addStyleTag({
    content: `
      html,body{background:transparent!important}
      .preview-label{display:none!important}
      .panel__foot{display:none!important}
      *,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important}
    `,
  });
  const title = await page.$('.pill__compact-title');
  if (title) await title.click();
  await sleep(700);
  const more = await page.$('[aria-label="More actions"]');
  if (more) {
    await more.click();
    await sleep(250);
    const pins = await page.$$('[role="menuitemcheckbox"]');
    for (const p of pins) {
      const label = await page.evaluate((el) => el.textContent ?? '', p);
      if (/keep island open/i.test(label)) {
        const checked = await page.evaluate((el) => el.getAttribute('aria-checked'), p);
        if (checked === 'false') await p.click();
        else await page.keyboard.press('Escape');
        break;
      }
    }
  }
  await page.mouse.move(6, 980);
  await sleep(5000);
  const info = await page.evaluate(() => {
    const all = (sel) => document.querySelectorAll(sel).length;
    return {
      islands: all('.island'),
      media: all('[data-widget-kind="media"]'),
      weather: all('[data-widget-kind="weather"]'),
      widgets: all('.widget'),
      active: document.activeElement?.className,
      open: !!document.querySelector('.island--open'),
      islandBox: (() => {
        const r = document.querySelector('.island')?.getBoundingClientRect();
        return r && [Math.round(r.width), Math.round(r.height), Math.round(r.x), Math.round(r.y)];
      })(),
      html: document.querySelector('.island')?.innerHTML.slice(0, 400),
    };
  });
  log(JSON.stringify(info, null, 2));
  await screenshot({ path: 'assets/ui/probe-settled.png' });
};
