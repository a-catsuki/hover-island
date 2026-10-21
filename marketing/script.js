(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const $ = (s, r = document) => r.querySelector(s)
  const $$ = (s, r = document) => [...r.querySelectorAll(s)]
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

  /** A tiny damped spring over named numbers. Calls draw(values) every frame until it rests. */
  function springs(initial, draw, feel = () => ({ k: 220, d: 0.6 })) {
    const cur = { ...initial }, vel = Object.fromEntries(Object.keys(initial).map((k) => [k, 0]))
    let target = { ...initial }, raf = 0, last = 0
    const step = (t) => {
      const dt = Math.min(0.032, last ? (t - last) / 1000 : 1 / 60); last = t
      let moving = false
      for (const key of Object.keys(cur)) {
        const { k, d } = feel(key, target)
        vel[key] += ((target[key] - cur[key]) * k - 2 * d * Math.sqrt(k) * vel[key]) * dt
        cur[key] += vel[key] * dt
        if (Math.abs(target[key] - cur[key]) > 0.05 || Math.abs(vel[key]) > 0.5) moving = true
      }
      draw(cur)
      if (moving) raf = requestAnimationFrame(step)
      else { Object.assign(cur, target); draw(cur); raf = 0; last = 0 }
    }
    draw(cur)
    return {
      to(next) { Object.assign(target, next); if (reduce) { Object.assign(cur, target); draw(cur); return } if (!raf) raf = requestAnimationFrame(step) },
      get value() { return cur },
      redraw() { draw(cur) },
    }
  }
  const io = (els, cls = 'is-in', margin = '0px 0px -20% 0px', cb) => {
    if (!('IntersectionObserver' in window)) { els.forEach((e) => { e.classList.add(cls); cb?.(e) }); return }
    const o = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) { e.target.classList.add(cls); cb?.(e.target); o.unobserve(e.target) } }, { rootMargin: margin, threshold: 0.15 })
    els.forEach((e) => o.observe(e))
  }

  /* ---------- notch path: flush top edge, concave ears, rounded bottom ---------- */
  function notchPath(cx, w, h, ear = 12) {
    const L = cx - w / 2, R = cx + w / 2, e = Math.min(ear, h / 2), r = Math.max(3, Math.min(h / 2 - 0.5, h < 80 ? h / 2 - 0.5 : 36))
    const f = (n) => n.toFixed(2)
    return `M${f(L - e)} 0 Q${f(L)} 0 ${f(L)} ${f(e)} L${f(L)} ${f(h - r)} Q${f(L)} ${f(h)} ${f(L + r)} ${f(h)} L${f(R - r)} ${f(h)} Q${f(R)} ${f(h)} ${f(R)} ${f(h - r)} L${f(R)} ${f(e)} Q${f(R)} 0 ${f(R + e)} 0 Z`
  }

  /* ---------- nav notch ---------- */
  const nav = $('#navnotch'), navPath = $('#navnotch-path')
  const navSpring = springs({ h: 56 }, ({ h }) => {
    const w = nav.offsetWidth
    nav.style.height = `${h}px`
    navPath.setAttribute('d', notchPath(w / 2 + 14, w, h, 14))
  }, () => ({ k: 240, d: 0.55 }))
  const onScrollNav = () => { const s = scrollY > 40; nav.classList.toggle('is-scrolled', s); navSpring.to({ h: s ? 46 : 56 }) }
  addEventListener('scroll', onScrollNav, { passive: true }); onScrollNav()
  addEventListener('resize', () => navSpring.redraw())
  ;(document.fonts?.ready ?? Promise.resolve()).then(() => navSpring.redraw())
  const links = $$('.navnotch nav a')
  if ('IntersectionObserver' in window) {
    const spy = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) for (const a of links) a.classList.toggle('is-here', a.getAttribute('href') === `#${e.target.id}`) }, { rootMargin: '-45% 0px -50% 0px' })
    for (const a of links) { const t = $(a.getAttribute('href')); if (t) spy.observe(t) }
  }

  /* ---------- GitHub stars, cached for an hour ---------- */
  const showStars = (n) => {
    if (typeof n !== 'number') return
    const text = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
    $$('[data-stars]').forEach((el) => { el.textContent = text; el.hidden = false })
    $$('[data-stars-inline]').forEach((el) => { el.textContent = text })
  }
  let cached = null
  try { cached = JSON.parse(localStorage.getItem('hi-stars') || 'null') } catch {}
  if (cached) showStars(cached.n)
  if (!cached || Date.now() - cached.t > 3600_000) {
    fetch('https://api.github.com/repos/a-catsuki/hover-island', { headers: { Accept: 'application/vnd.github+json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((repo) => { if (!repo || typeof repo.stargazers_count !== 'number') return; showStars(repo.stargazers_count); try { localStorage.setItem('hi-stars', JSON.stringify({ n: repo.stargazers_count, t: Date.now() })) } catch {} })
      .catch(() => {})
  }

  /* ---------- magnetic buttons ---------- */
  if (!reduce && matchMedia('(pointer: fine)').matches) for (const el of $$('[data-magnet]')) {
    el.addEventListener('pointermove', (e) => { const r = el.getBoundingClientRect(); el.style.setProperty('--mx', `${(e.clientX - r.left - r.width / 2) * 0.18}px`); el.style.setProperty('--my', `${(e.clientY - r.top - r.height / 2) * 0.28}px`) })
    el.addEventListener('pointerleave', () => { el.style.setProperty('--mx', '0px'); el.style.setProperty('--my', '0px') })
  }

  /* ---------- hero parallax ---------- */
  const floaters = $$('#floaters [data-depth]')
  if (!reduce && matchMedia('(pointer: fine)').matches) addEventListener('pointermove', (e) => {
    const x = e.clientX / innerWidth - 0.5, y = e.clientY / innerHeight - 0.5
    for (const f of floaters) { const d = +f.dataset.depth; f.style.translate = `${-x * d}px ${-y * d}px` }
  }, { passive: true })

  /* ---------- the story: one island morphing through every chapter ---------- */
  const screen = $('#screen'), islPath = $('#isl-path'), faces = $$('.isl-face'), steps = $$('.step'), railFill = $('#rail-fill'), story = $('#story')
  const shapes = (i) => {
    const sw = screen.clientWidth
    return [
      { w: 184, h: 34 },
      { w: Math.min(580, sw * 0.9), h: Math.min(256, sw * 0.44) },
      { w: Math.min(480, sw * 0.86), h: Math.min(176, sw * 0.34) },
      { w: Math.min(490, sw * 0.86), h: Math.min(178, sw * 0.34) },
      { w: Math.min(440, sw * 0.8), h: 64 },
      { w: Math.min(590, sw * 0.94), h: Math.min(220, sw * 0.42) },
    ][i]
  }
  let stepNow = -1
  const isl = springs({ w: 184, h: 34 }, ({ w, h }) => islPath.setAttribute('d', notchPath(screen.clientWidth / 2, w, Math.max(18, h))), (key, target) => {
    const growing = target.h > 40
    // Width is firm, height soft and bouncy: it stretches like jelly on the way out.
    return key === 'w' ? { k: growing ? 230 : 280, d: growing ? 0.6 : 0.74 } : { k: growing ? 150 : 220, d: growing ? 0.48 : 0.62 }
  })
  function setStep(i) {
    i = clamp(i, 0, 5)
    if (i === stepNow) return
    stepNow = i
    isl.to(shapes(i))
    faces.forEach((f) => f.classList.toggle('on', +f.dataset.face === i))
    steps.forEach((s, n) => { s.classList.toggle('is-active', n === i); s.classList.toggle('is-past', n < i) })
    screen.dataset.step = String(i)
  }
  const mobile = matchMedia('(max-width: 1000px)')
  function storyScroll() {
    if (mobile.matches) return
    const r = story.getBoundingClientRect()
    const p = clamp(-r.top / (story.offsetHeight - innerHeight), 0, 1)
    railFill.style.strokeDasharray = `${(p * 100).toFixed(2)} 100`
    setStep(Math.floor(p * 5.999))
  }
  addEventListener('scroll', () => requestAnimationFrame(storyScroll), { passive: true })
  addEventListener('resize', () => { const i = stepNow; stepNow = -1; setStep(i); isl.redraw() })
  setStep(0); storyScroll()
  // On phones the story is not pinned: it plays itself while on screen.
  let auto = 0
  const autoplay = () => { clearInterval(auto); if (!mobile.matches) return; auto = setInterval(() => { if (screen.getBoundingClientRect().top < innerHeight) setStep((stepNow + 1) % 6) }, 3200) }
  mobile.addEventListener?.('change', autoplay); autoplay()

  /* ---------- playground: dock styles morph, themes recolor the page ---------- */
  const ms = $('#mini-screen'), msPath = $('#ms-path'), cursor = $('#ms-cursor')
  let dock = 'notch', opened = false
  // A rounded rect with per-corner radii, so notch, bar and rail can morph into each other.
  const rr = ({ x, y, w, h, tl, tr, br, bl }) => `M${x + tl} ${y} H${x + w - tr} Q${x + w} ${y} ${x + w} ${y + tr} V${y + h - br} Q${x + w} ${y + h} ${x + w - br} ${y + h} H${x + bl} Q${x} ${y + h} ${x} ${y + h - bl} V${y + tl} Q${x} ${y} ${x + tl} ${y} Z`
  const dockShape = () => {
    const W = ms.clientWidth, H = ms.clientHeight, g = opened ? 1 : 0
    if (dock === 'bar') return { x: 0, y: 0, w: W, h: g ? H * 0.42 : H * 0.075, tl: 0, tr: 0, br: g ? 22 : 0, bl: g ? 22 : 0 }
    if (dock === 'rail') return { x: 0, y: 0, w: g ? W * 0.36 : W * 0.06, h: H, tl: 0, tr: g ? 22 : 12, br: g ? 22 : 12, bl: 0 }
    const w = g ? W * 0.62 : W * 0.26, h = g ? H * 0.46 : H * 0.085
    return { x: (W - w) / 2, y: 0, w, h, tl: 0, tr: 0, br: g ? 26 : h / 2, bl: g ? 26 : h / 2 }
  }
  const msSpring = springs({ x: 0, y: 0, w: 10, h: 10, tl: 0, tr: 0, br: 0, bl: 0 }, (v) => msPath.setAttribute('d', rr(v)), (key) => (key === 'h' ? { k: 170, d: 0.5 } : { k: 230, d: 0.62 }))
  const msUpdate = () => msSpring.to(dockShape())
  requestAnimationFrame(() => { Object.assign(msSpring.value, dockShape()); msSpring.redraw() })
  addEventListener('resize', msUpdate)
  for (const r of $$('input[name="dock"]')) r.addEventListener('change', () => { dock = r.value; opened = false; msUpdate(); moveCursorHome() })
  const moveCursorHome = () => { cursor.style.left = '62%'; cursor.style.top = '68%' }
  const moveCursorToShape = () => {
    if (dock === 'rail') { cursor.style.left = '3%'; cursor.style.top = '50%' } else { cursor.style.left = dock === 'bar' ? '30%' : '50%'; cursor.style.top = '4%' }
  }
  // The little cursor visits the island now and then; it opens like the real one.
  let msTimer = 0
  const loop = () => {
    clearTimeout(msTimer)
    moveCursorToShape()
    msTimer = setTimeout(() => { opened = true; msUpdate(); msTimer = setTimeout(() => { moveCursorHome(); msTimer = setTimeout(() => { opened = false; msUpdate(); msTimer = setTimeout(loop, 1600) }, 450) }, 1800) }, 950)
  }
  io([ms], 'is-in', '0px', () => { if (!reduce) loop() })
  for (const b of $$('.themes button')) b.addEventListener('click', () => {
    for (const o of $$('.themes button')) o.setAttribute('aria-checked', String(o === b))
    const root = document.documentElement.style
    root.setProperty('--a', b.dataset.a); root.setProperty('--v', b.dataset.v); root.setProperty('--b', b.dataset.b)
  })

  /* ---------- bento ---------- */
  io($$('.tile'))
  const spot = $('#spot-text'), words = ['vs code', 'settings', 'report.pdf', 'spotify']
  let wi = 0
  const typeWord = () => {
    const word = words[wi++ % words.length]; let n = 0
    const tick = () => { spot.textContent = word.slice(0, ++n); if (n < word.length) setTimeout(tick, 90); else setTimeout(erase, 1600) }
    const erase = () => { spot.textContent = spot.textContent.slice(0, -1); if (spot.textContent) setTimeout(erase, 40); else setTimeout(typeWord, 300) }
    tick()
  }
  if (reduce) spot.textContent = 'vs code'; else io([$('.t-spot')], 'is-in', '0px', typeWord)

  /* ---------- terminal ---------- */
  const term = $('#term code')
  const lines = [
    ['p', '> '], ['', 'git clone https://github.com/a-catsuki/hover-island\n'],
    ['p', '> '], ['', 'cd hover-island; npm install\n'],
    ['c', 'added 214 packages in 9s\n'],
    ['p', '> '], ['', 'npm run dev\n'],
    ['c', '  VITE ready in 412 ms\n'],
    ['k', '  ➜ '], ['', 'Local:  http://localhost:1420/\n'],
    ['p', '> '], ['', '.\\Rebuild.ps1 -Fast\n'],
    ['c', 'Installed package version 0.1.6.4 ✓'],
  ]
  const typeTerm = () => {
    term.textContent = ''
    let li = 0, ci = 0, span = null
    const tick = () => {
      if (li >= lines.length) return
      const [cls, text] = lines[li]
      if (!span) { span = document.createElement('span'); if (cls) span.className = cls; term.appendChild(span) }
      const instant = cls === 'c' || cls === 'p' || cls === 'k'
      span.textContent = instant ? text : text.slice(0, ++ci)
      if (instant || ci >= text.length) { li++; ci = 0; span = null; setTimeout(tick, instant ? 180 : 260) } else setTimeout(tick, 28)
    }
    tick()
  }
  if (reduce) { for (const [cls, text] of lines) { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = text; term.appendChild(s) } } else io([$('.term')], 'is-in', '0px', typeTerm)

  io([$('.download'), $('.foot')], 'is-in', '0px 0px -10% 0px')
})()
