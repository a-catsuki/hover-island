(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  document.documentElement.classList.add('js')
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

  /* ---------- nav notch: name, star and download; the links unfold on hover, or on tap with touch ---------- */
  const nav = $('#navnotch'), navPath = $('#navnotch-path'), navLinks = $('#navnotch-links'), navShape = $('.navnotch-shape'), navToggle = $('.nav-toggle')
  const touchNav = matchMedia('(max-width: 1000px), (hover: none)')
  let linksW = 0, panelH = 0, navOpen = false, openedAt = 0
  const navSpring = springs({ h: 56, w: 0, ph: 0 }, ({ h, w, ph }) => {
    let total = h
    if (touchNav.matches) {
      const p = Math.max(0, ph)
      navLinks.style.height = `${p}px`; navLinks.style.top = `${h}px`
      navLinks.style.opacity = String(clamp(panelH ? (p / panelH) * 1.4 - 0.2 : 0, 0, 1))
      total = h + p
    } else {
      const f = linksW ? clamp(w / linksW, 0, 1) : 0
      navLinks.style.height = ''; navLinks.style.top = ''
      navLinks.style.width = `${Math.max(0, w)}px`
      navLinks.style.opacity = String(clamp(f * 1.5 - 0.25, 0, 1))
      navLinks.style.marginInline = `${-11 * (1 - f)}px`
    }
    const bw = nav.offsetWidth
    nav.style.height = `${h}px`
    navShape.style.height = total === h ? '' : `${total}px`
    navPath.setAttribute('d', notchPath(bw / 2 + 14, bw, total, 14))
  }, (key) => (key === 'ph' ? { k: 210, d: 0.62 } : { k: 240, d: 0.55 }))
  const setNav = (open) => {
    navOpen = open
    const touch = touchNav.matches
    navSpring.to({ w: !touch && open ? linksW : 0, ph: touch && open ? panelH : 0 })
    navToggle.setAttribute('aria-expanded', String(open))
    navLinks.inert = touch && !open
    if (open) openedAt = scrollY
  }
  const measureNav = () => {
    const as = [...navLinks.children]
    linksW = Math.ceil(as.reduce((n, a) => n + a.offsetWidth, 0) + (parseFloat(getComputedStyle(navLinks).columnGap) || 0) * Math.max(0, as.length - 1))
    panelH = as.length * 48 + 14
    setNav(navOpen); navSpring.redraw()
  }
  let navLeave = 0
  const hoverNav = (open) => { clearTimeout(navLeave); if (open) setNav(true); else navLeave = setTimeout(() => setNav(false), 240) }
  nav.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && !touchNav.matches) hoverNav(true) })
  nav.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !touchNav.matches) hoverNav(false) })
  nav.addEventListener('focusin', () => { if (!touchNav.matches) hoverNav(true) })
  nav.addEventListener('focusout', (e) => { if (!touchNav.matches && !nav.contains(e.relatedTarget)) hoverNav(false) })
  navToggle.addEventListener('click', () => setNav(!navOpen))
  navLinks.addEventListener('click', (e) => { if (e.target.closest('a') && touchNav.matches) setNav(false) })
  addEventListener('pointerdown', (e) => { if (navOpen && touchNav.matches && !nav.contains(e.target)) setNav(false) })
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && navOpen && touchNav.matches) { setNav(false); navToggle.focus() } })
  touchNav.addEventListener?.('change', () => { navOpen = false; navLinks.style.width = ''; navLinks.style.marginInline = ''; measureNav() })
  const onScrollNav = () => {
    const s = scrollY > 40; nav.classList.toggle('is-scrolled', s); navSpring.to({ h: s ? 46 : 56 })
    if (navOpen && touchNav.matches && Math.abs(scrollY - openedAt) > 60) setNav(false)
  }
  addEventListener('resize', measureNav)
  ;(document.fonts?.ready ?? Promise.resolve()).then(measureNav)
  measureNav()
  onScrollNav()
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
  let heroOn = true, px = 0, py = 0, pxQueued = false
  if (!reduce && matchMedia('(pointer: fine)').matches) addEventListener('pointermove', (e) => {
    if (!heroOn) return
    px = e.clientX / innerWidth - 0.5; py = e.clientY / innerHeight - 0.5
    if (pxQueued) return; pxQueued = true
    requestAnimationFrame(() => { pxQueued = false; for (const f of floaters) { const d = +f.dataset.depth; f.style.translate = `${-px * d}px ${-py * d}px` } })
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
  /* ---------- beam: drag a file, the notch swallows it, it lands on a phone ---------- */
  const beam = $('#beam'), bFile = $('.beam-file'), bCursor = $('.beam-cursor'), bPhone = $('.beam-phone'), bDrop = $('.drop')
  const rings = $$('.beam-ripple i'), comet = $$('.beam-comet i'), bPct = $('.bp-pct'), bState = $('.bp-state'), bBar = $('.bp-bar i'), islShape = $('.isl-shape')
  const easeOut = (t) => 1 - Math.pow(1 - t, 3)
  const easeIO = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
  const seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1)
  const bez = (p0, p1, p2, p3, u) => { const m = 1 - u; return [m * m * m * p0[0] + 3 * m * m * u * p1[0] + 3 * m * u * u * p2[0] + u * u * u * p3[0], m * m * m * p0[1] + 3 * m * m * u * p1[1] + 3 * m * u * u * p2[1] + u * u * u * p3[1]] }
  const centerIn = (el) => { const a = screen.getBoundingClientRect(), b = el.getBoundingClientRect(); return [b.left - a.left + b.width / 2, b.top - a.top + b.height / 2] }
  const LOOP = 5.6
  let beamRaf = 0, beamT0 = 0, geo = null
  function beamFrame(now) {
    const t = reduce ? 4.9 : ((now - beamT0) / 1000) % LOOP
    const W = screen.clientWidth, H = screen.clientHeight
    const start = [W * 0.2, H * 0.86]
    // the island is still opening for the first second; after that the geometry is fixed
    if (!geo || t < 1.2) geo = { dz: centerIn(bDrop), phone: [bPhone.offsetLeft + bPhone.offsetWidth / 2, bPhone.offsetTop + 10], fw: bFile.offsetWidth, fh: bFile.offsetHeight }
    const { dz, phone } = geo
    // the file, carried along a curve by a cursor
    const u = easeIO(seg(t, 0.9, 2.1))
    const [fx, fy] = bez(start, [W * 0.2, H * 0.5], [dz[0] - W * 0.12, dz[1] + H * 0.26], dz, u)
    const swallow = easeOut(seg(t, 2.1, 2.5))
    const fScale = (1 + 0.08 * seg(t, 0.5, 0.8)) * (1 - 0.75 * swallow)
    bFile.style.opacity = String(seg(t, 0, 0.45) * (1 - seg(t, 2.3, 2.55)))
    bFile.style.transform = `translate(${fx - geo.fw / 2}px, ${fy - geo.fh / 2}px) rotate(${(Math.sin(u * Math.PI) * -7).toFixed(2)}deg) scale(${fScale.toFixed(3)})`
    const arrive = easeOut(seg(t, 0, 0.55)), leave = easeOut(seg(t, 2.2, 3.1))
    const cx = (t < 0.9 ? start[0] + 46 * (1 - arrive) : fx) + 12 + 46 * leave, cy = (t < 0.9 ? start[1] + 70 * (1 - arrive) : fy) + 16 + 56 * leave
    bCursor.style.opacity = String(seg(t, 0, 0.3) * (1 - seg(t, 2.5, 3.1)))
    bCursor.style.transform = `translate(${cx}px, ${cy}px) scale(${(1 - 0.14 * seg(t, 0.5, 0.65) + 0.14 * seg(t, 2.1, 2.3)).toFixed(3)})`
    // the notch's drop zone lights up, ripples, and squishes
    screen.classList.toggle('is-dropping', t > 1.5 && t < 2.5)
    rings.forEach((r, i) => { const k = seg(t, 2.15 + i * 0.18, 3.1 + i * 0.18); r.style.opacity = String(k > 0 && k < 1 ? 0.7 * (1 - k) : 0); r.style.transform = `translate(${dz[0]}px, ${dz[1]}px) scale(${(0.3 + 1.6 * easeOut(k)).toFixed(3)})` })
    const q = t - 2.15, wob = q > 0 ? Math.exp(-q * 6) * Math.sin(q * 22) : 0
    islShape.style.transform = `scale(${(1 + 0.025 * wob).toFixed(4)}, ${(1 - 0.07 * wob).toFixed(4)})`
    // a comet from the notch to the phone
    const head = easeIO(seg(t, 2.4, 3.5))
    comet.forEach((d, i) => {
      const k = clamp(head - i * 0.035, 0, 1)
      const [x, y] = bez(dz, [dz[0] + W * 0.12, dz[1] + H * 0.14], [phone[0] - W * 0.16, phone[1] - H * 0.2], phone, k)
      d.style.opacity = String(head > 0 && k < 1 ? (1 - i / 8) * (1 - seg(k, 0.9, 1)) : 0)
      d.style.transform = `translate(${x}px, ${y}px) scale(${(1 - i * 0.1).toFixed(2)})`
    })
    // the phone receives it
    const pin = easeOut(seg(t, 2.0, 2.8)), p = easeIO(seg(t, 3.3, 4.5)), done = p >= 1
    const bump = 1 + 0.05 * Math.sin(seg(t, 4.5, 4.9) * Math.PI)
    bPhone.style.opacity = String(pin * (1 - seg(t, 5.05, 5.55)))
    bPhone.style.transform = `translateY(${((1 - pin) * 26).toFixed(1)}px) scale(${((0.94 + 0.06 * pin) * bump).toFixed(3)})`
    bBar.style.transform = `scaleX(${p.toFixed(3)})`
    bPct.textContent = `${Math.round(p * 100)}%`
    bPhone.classList.toggle('is-done', done)
    bState.textContent = done ? 'Received' : 'Receiving'
  }
  const beamLoop = (now) => { beamFrame(now); beamRaf = requestAnimationFrame(beamLoop) }
  const beamStart = () => { cancelAnimationFrame(beamRaf); geo = null; beamT0 = performance.now(); if (reduce) beamFrame(beamT0); else beamRaf = requestAnimationFrame(beamLoop) }
  const beamStop = () => { cancelAnimationFrame(beamRaf); beamRaf = 0; screen.classList.remove('is-dropping'); islShape.style.transform = '' }

  /* ---------- AI limits count up with their rings ---------- */
  const counts = $$('[data-count]')
  const countUp = () => {
    if (reduce) return
    const t0 = performance.now()
    const tick = (now) => { const k = easeOut(clamp((now - t0 - 300) / 1400, 0, 1)); for (const el of counts) el.textContent = String(Math.round(+el.dataset.count * k)); if (k < 1) requestAnimationFrame(tick) }
    for (const el of counts) el.textContent = '0'
    requestAnimationFrame(tick)
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
    if (i === 2) beamStart(); else beamStop()
    if (i === 3) countUp()
  }
  const mobile = matchMedia('(max-width: 1000px)')
  function storyScroll() {
    if (mobile.matches) return
    const r = story.getBoundingClientRect()
    const p = clamp(-r.top / (story.offsetHeight - innerHeight), 0, 1)
    railFill.style.strokeDasharray = `${(p * 100).toFixed(2)} 100`
    setStep(Math.floor(p * 5.999))
  }
  let scrollQueued = false
  addEventListener('scroll', () => { if (scrollQueued) return; scrollQueued = true; requestAnimationFrame(() => { scrollQueued = false; onScrollNav(); storyScroll() }) }, { passive: true })
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

  /* ---------- tiles follow the pointer with a soft light ---------- */
  for (const t of $$('.tile')) {
    let q = false, ev = null
    t.addEventListener('pointermove', (e) => { ev = e; if (q) return; q = true; requestAnimationFrame(() => { q = false; const r = t.getBoundingClientRect(); t.style.setProperty('--px', `${ev.clientX - r.left}px`); t.style.setProperty('--py', `${ev.clientY - r.top}px`) }) }, { passive: true })
  }

  /* ---------- footer: the cursor drifts toward the pointer ---------- */
  const idle = (fn) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 2500 }) : setTimeout(fn, 800))
  const loadFootArt = () => { for (const img of $$('.foot img[data-src]')) { img.src = img.dataset.src; img.removeAttribute('data-src'); img.decode?.().catch(() => {}) } }
  if (document.readyState === 'complete') idle(loadFootArt); else addEventListener('load', () => idle(loadFootArt), { once: true })
  const foot = $('#foot'), year = $('#year')
  if (year) year.textContent = String(new Date().getFullYear())
  if (!reduce && matchMedia('(pointer: fine)').matches) {
    let fq = false, fe = null
    foot.addEventListener('pointermove', (e) => { fe = e; if (fq) return; fq = true; requestAnimationFrame(() => { fq = false; const r = foot.getBoundingClientRect(); foot.style.setProperty('--cx', String(((fe.clientX - r.left) / r.width - 0.5) * 70)); foot.style.setProperty('--cy', String(((fe.clientY - r.top) / r.height - 0.5) * 40)) }) }, { passive: true })
    foot.addEventListener('pointerleave', () => { foot.style.setProperty('--cx', '0'); foot.style.setProperty('--cy', '0') })
  }

  /* ---------- sections that are offscreen stop animating ---------- */
  if ('IntersectionObserver' in window) {
    const watch = new IntersectionObserver((entries) => { for (const e of entries) { e.target.classList.toggle('is-off', !e.isIntersecting); if (e.target.id === 'top') heroOn = e.isIntersecting } }, { rootMargin: '120px 0px' })
    for (const el of $$('.hero, .works, .more, .open, .download, .play')) watch.observe(el)
  }
})()
