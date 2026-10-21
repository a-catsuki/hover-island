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
  await sleep(1000);
  await page.addStyleTag({ content: 'html,body{background:transparent!important}.preview-label{display:none!important}' });
  const title = await page.$('.pill__compact-title');
  if (title) await title.click();
  await sleep(900);
  const more = await page.$('[aria-label="More actions"]');
  if (more) {
    await more.click();
    await sleep(200);
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
  await sleep(2500);
  const info = await page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        sel,
        x: Math.round(b.x),
        y: Math.round(b.y),
        w: Math.round(b.width),
        h: Math.round(b.height),
        cssW: cs.width,
        cssH: cs.height,
        overflow: cs.overflow,
      };
    };
    return {
      vw: innerWidth,
      vh: innerHeight,
      scrollY,
      expandedW: getComputedStyle(document.documentElement).getPropertyValue('--expanded-w'),
      islandVar: getComputedStyle(document.querySelector('.island')).getPropertyValue('--island-target-width'),
      body: r('body'),
      stage: r('.island-stage'),
      island: r('.island'),
      bar: r('.island__bar'),
      panel: r('.island__panel, .panel, .panel__body'),
      tabs: r('.panel-tabs'),
      toast: r('.toast, .feedback-toast'),
      text: document.querySelector('.island')?.className,
      weather: document.querySelector('[data-widget-kind="weather"]')?.innerText?.slice(0, 120),
    };
  });
  log(JSON.stringify(info, null, 2));
  await screenshot({ path: 'assets/ui/probe-full.png' });
};
