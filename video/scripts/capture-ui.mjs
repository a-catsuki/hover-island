const BASE = 'http://localhost:5210/';
const OUT = 'C:/Users/HP/source/hover-island/video/assets/ui/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PANELS = { today: 'Today', desk: 'Desk', activity: 'Activity' };
const PANEL_ORDER = ['today', 'desk', 'activity'];
const ALL_WIDGETS = [
  { id: 'w-media', kind: 'media', enabled: true, order: 0 },
  { id: 'w-weather', kind: 'weather', enabled: true, order: 1 },
  { id: 'w-calendar', kind: 'calendar', enabled: true, order: 2 },
  { id: 'w-notes', kind: 'notes', enabled: true, order: 3 },
  { id: 'w-ai', kind: 'ai', enabled: true, order: 4 },
  { id: 'w-dock', kind: 'dock', enabled: true, order: 5 },
  { id: 'w-focus', kind: 'focus', enabled: true, order: 6 },
  { id: 'w-system', kind: 'system', enabled: true, order: 7 },
  { id: 'w-notifications', kind: 'notifications', enabled: true, order: 8 },
  { id: 'w-reset-watch', kind: 'reset-watch', enabled: true, order: 9 },
];

function widgetsOnly(...kinds) {
  return ALL_WIDGETS.map((w) => ({ ...w, enabled: kinds.includes(w.kind) }));
}

export default async ({ page, log }) => {
  page.setDefaultTimeout(45000);

  const applySettings = async (patch) => {
    await page.evaluate((p) => {
      const cur = JSON.parse(localStorage.getItem('hover-island.preview.settings') ?? '{}');
      localStorage.setItem('hover-island.preview.settings', JSON.stringify({ ...cur, ...p }));
    }, patch);
  };

  const boot = async (patch) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await applySettings({
      onboardingVersion: 1,
      panels: PANELS,
      panelOrder: PANEL_ORDER,
      panelNames: {},
      background: 'plain',
      theme: 'midnight',
      opacity: 1,
      sizePreset: 'medium',
      expanded: { w: 800, h: 510 },
      weatherCity: 'New Delhi',
      weatherLat: 28.61,
      weatherLon: 77.21,
      weatherAutoLocation: false,
      widgets: ALL_WIDGETS,
      ...patch,
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(900);
    await page.addStyleTag({
      content: `
        html, body { background: transparent !important; }
        .preview-label { display: none !important; }
        .panel__foot { display: none !important; }
        *, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
        }
        *::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
        .panel__body { scrollbar-width: none !important; }
      `,
    });
    await page.mouse.move(6, 980);
    await sleep(200);
  };

  const open = async () => {
    if (!(await page.$('.island--open'))) {
      const title = await page.$('.pill__compact-title');
      if (title) await title.click();
      else {
        const compact = await page.$('[role="group"]');
        if (compact) await compact.click();
      }
      await page.waitForSelector('.island--open');
    }
    await page.mouse.move(6, 980);
    await sleep(350);
    // pin so the panel stays while the pointer is parked away
    const more = await page.$('[aria-label="More actions"]');
    if (more) {
      await more.click();
      await sleep(300);
      const pins = await page.$$('[role="menuitemcheckbox"]');
      let handled = false;
      for (const pin of pins) {
        const label = await page.evaluate((el) => el.textContent ?? '', pin);
        if (/keep island open|unpin island/i.test(label)) {
          const checked = await page.evaluate((el) => el.getAttribute('aria-checked'), pin);
          if (checked === 'false') await pin.click();
          else await page.keyboard.press('Escape');
          handled = true;
          break;
        }
      }
      if (!handled) await page.keyboard.press('Escape');
    }
    await sleep(500);
    if (!(await page.$('.island--open'))) {
      const title = await page.$('.pill__compact-title');
      if (title) await title.click();
      await page.waitForSelector('.island--open');
      await sleep(400);
      const more2 = await page.$('[aria-label="More actions"]');
      if (more2) {
        await more2.click();
        await sleep(300);
        const pins2 = await page.$$('[role="menuitemcheckbox"]');
        for (const pin of pins2) {
          const label = await page.evaluate((el) => el.textContent ?? '', pin);
          if (/keep island open/i.test(label)) {
            const checked = await page.evaluate((el) => el.getAttribute('aria-checked'), pin);
            if (checked === 'false') await pin.click();
            else await page.keyboard.press('Escape');
            break;
          }
        }
      }
    }
    await sleep(350);
  };

  const dismissPeek = async () => {
    const peek = await page.$('.live-activity .peek');
    if (!peek) return;
    await peek.focus();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.live-activity .peek'));
    await sleep(300);
    if (!(await page.$('.island--open'))) await open();
  };

  const unpin = async () => {
    const more = await page.$('[aria-label="More actions"]');
    if (!more) return;
    await more.click();
    await sleep(300);
    const pins = await page.$$('[role="menuitemcheckbox"]');
    for (const pin of pins) {
      const label = await page.evaluate((el) => el.textContent ?? '', pin);
      if (/keep island open/i.test(label)) {
        const checked = await page.evaluate((el) => el.getAttribute('aria-checked'), pin);
        if (checked === 'true') await pin.click();
        else await page.keyboard.press('Escape');
        break;
      }
    }
    await sleep(300);
  };

  const firstTab = async () => {
    const tab = await page.$('.panel-tabs [role="tab"]');
    if (tab) {
      await tab.click();
      await sleep(250);
    }
  };

  const clickTabNamed = async (name) => {
    const tabs = await page.$$('.panel-tabs [role="tab"]');
    for (const tab of tabs) {
      const text = await page.evaluate((el) => (el.textContent ?? '').trim(), tab);
      if (text.toLowerCase().includes(name.toLowerCase())) {
        await tab.click();
        await sleep(300);
        return true;
      }
    }
    return false;
  };

  const findWidget = async (kind) => {
    const tabs = await page.$$('.panel-tabs [role="tab"]');
    for (const tab of tabs) {
      await tab.click();
      await sleep(140);
      if (await page.$(`[data-widget-kind="${kind}"]`)) return true;
    }
    throw new Error('widget not reachable: ' + kind);
  };

  const shot = async (name, selector = '.island', pad = 80) => {
    await page.mouse.move(6, 980);
    await sleep(2600);
    const el = await page.$(selector);
    if (!el) throw new Error('missing selector ' + selector);
    const box = await el.boundingBox();
    if (!box) throw new Error('no box for ' + selector);
    const x = Math.max(0, box.x - pad);
    const y = Math.max(0, box.y - pad);
    await page.screenshot({
      path: OUT + name + '.png',
      omitBackground: true,
      clip: { x, y, width: box.width + pad * 2, height: box.height + pad * 2 },
    });
    log(name + ' ' + Math.round(box.width) + 'x' + Math.round(box.height) + ' @' + Math.round(box.x) + ',' + Math.round(box.y));
  };

  // ---- hero: media + weather -------------------------------------------------
  await boot({ widgets: widgetsOnly('media', 'weather') });
  await shot('rest', '.island__bar', 60);
  await open();
  await dismissPeek();
  await firstTab();
  await sleep(500);
  await shot('today');
  await shot('media-widget', '[data-widget-kind="media"]', 30);
  await shot('weather-widget', '[data-widget-kind="weather"]', 30);

  // ---- notification peek -----------------------------------------------------
  await open();
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('notifications://changed', {
        detail: [
          {
            id: 'studio-note',
            app: 'WhatsApp Desktop',
            title: 'A message for you',
            body: 'Meet at the studio at four?',
            timestamp: Date.now(),
          },
        ],
      }),
    );
  });
  await page.waitForSelector('.live-activity .peek');
  await sleep(500);
  await shot('peek');
  await dismissPeek();

  // ---- quick controls --------------------------------------------------------
  const controlsButton = await page.$('[aria-label="Open quick controls"]');
  if (controlsButton) await controlsButton.click();
  await sleep(350);
  await findWidget('controls');
  await sleep(500);
  await shot('controls');
  await shot('controls-widget', '[data-widget-kind="controls"]', 30);

  // ---- beam ------------------------------------------------------------------
  await page.evaluate(() => localStorage.setItem('hover-island.preview.beam-files', 'true'));
  await boot({ widgets: widgetsOnly('nearby') });
  await open();
  const beamButton = await page.$('[aria-label="Open file beam"]');
  if (beamButton) await beamButton.click();
  await sleep(350);
  await findWidget('nearby');
  await sleep(600);
  const startSession = await page.$('[aria-label="Start session"]');
  if (startSession) {
    await startSession.click();
    await page.waitForSelector('img.beam__qr', { timeout: 10000 }).catch(() => {});
  }
  await shot('beam');
  await shot('beam-widget', '[data-widget-kind="nearby"]', 30);

  // ---- visualizer variants ---------------------------------------------------
  await boot({
    widgets: widgetsOnly('media'),
    visualizer: { style: 'bars', intensity: 1, reactivity: 1 },
  });
  await open();
  await dismissPeek();
  await firstTab();
  await sleep(900);
  await shot('visualizer');
  await shot('visualizer-a', '[data-widget-kind="media"]', 30);
  await sleep(180);
  await shot('visualizer-b', '[data-widget-kind="media"]', 30);
  await sleep(220);
  await shot('visualizer-c', '[data-widget-kind="media"]', 30);

  // ---- calendar --------------------------------------------------------------
  await boot({ widgets: widgetsOnly('calendar') });
  await open();
  await dismissPeek();
  await firstTab();
  await sleep(600);
  await shot('calendar');
  await shot('calendar-widget', '[data-widget-kind="calendar"]', 30);

  // ---- activity: ai usage ----------------------------------------------------
  await boot({ widgets: widgetsOnly('ai', 'reset-watch') });
  await open();
  await dismissPeek();
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('usage://changed', {
        detail: [
          { provider: 'codex', label: 'Codex 5h', status: 'ok', percent: 0.28, window: '5h', source: 'official-rate-limit', updatedAt: Date.now(), resetAt: Date.now() + 7200000 },
          { provider: 'codex', label: 'Codex 168h', status: 'ok', percent: 0.64, window: '168h', source: 'official-rate-limit', updatedAt: Date.now(), resetAt: Date.now() + 259200000 },
        ],
      }),
    );
  });
  await sleep(400);
  await findWidget('ai');
  await sleep(500);
  await shot('activity');
  await shot('ai-widget', '[data-widget-kind="ai"]', 30);

  log('capture complete');
};
