export default async ({ page, screenshot, log }) => {
  await page.goto('http://localhost:5210/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('hover-island.preview.settings') ?? '{}');
    s.onboardingVersion = 1;
    localStorage.setItem('hover-island.preview.settings', JSON.stringify(s));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 800));
  await page.mouse.move(10, 880);
  const info = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { sel, cls: el.className, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
    };
    return {
      bodyClass: document.body.className,
      html: document.body.innerHTML.slice(0, 600),
      els: ['.island', '.island-stage', '.island__bar', '.island-shell', '.island__shell', '.island--open', '.pill', '.peek'].map(pick),
    };
  });
  log(JSON.stringify(info, null, 2));
  await screenshot({ path: 'assets/ui/probe.png' });
};
