(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ─────────────── Year ─────────────── */
  var yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  /* ─────────────── Nav: a Dynamic Island style notch ─────────────── */
  var hero = document.querySelector('.hero');
  var notch = document.getElementById('nav-notch');
  var navToggle = document.getElementById('nav-toggle');
  var navLinks = document.getElementById('nav-links');
  var menuOpen = false;

  function setNotch(open) {
    if (!notch) return;
    notch.classList.toggle('open', open);
    if (navToggle) navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function collapseAllowed() { return window.scrollY < 80 && !menuOpen; }

  if (notch) {
    notch.addEventListener('mouseenter', function () { setNotch(true); });
    notch.addEventListener('mouseleave', function () { if (collapseAllowed()) setNotch(false); });
    notch.addEventListener('focusin', function () { setNotch(true); });
    notch.addEventListener('focusout', function () {
      window.setTimeout(function () {
        if (!collapseAllowed()) return;
        if (notch.contains(document.activeElement)) return;
        setNotch(false);
      }, 0);
    });
    setNotch(window.scrollY >= 80);
  }

  if (navToggle && navLinks) {
    navToggle.addEventListener('click', function () {
      menuOpen = !menuOpen;
      navToggle.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
      navToggle.setAttribute('aria-label', menuOpen ? 'Close menu' : 'Open menu');
      setNotch(true);
      if (!menuOpen) setNotch(window.scrollY >= 80);
    });
    navLinks.addEventListener('click', function (e) {
      if (e.target && e.target.tagName === 'A') {
        menuOpen = false;
        navToggle.setAttribute('aria-expanded', 'false');
        navToggle.setAttribute('aria-label', 'Open menu');
        setNotch(window.scrollY >= 80);
      }
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth > 833 && menuOpen) {
        menuOpen = false;
        navToggle.setAttribute('aria-expanded', 'false');
        setNotch(window.scrollY >= 80);
      }
    });
  }

  /* ─────────────── WebGL hero field ─────────────── */
  (function webgl() {
    var canvas = document.getElementById('gl');
    if (!canvas || !hero) return;
    var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) { hero.classList.add('no-webgl'); return; }

    var vertSrc = 'attribute vec2 a_pos; varying vec2 v_uv; void main(){ v_uv = a_pos*0.5+0.5; gl_Position = vec4(a_pos,0.0,1.0); }';
    var fragSrc = [
      'precision highp float;',
      'uniform vec2 u_res;',
      'uniform float u_time;',
      'uniform vec2 u_mouse;',
      'varying vec2 v_uv;',
      'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453123); }',
      'float noise(vec2 p){',
      '  vec2 i=floor(p), f=fract(p);',
      '  vec2 u=f*f*(3.0-2.0*f);',
      '  return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),u.x), mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0,1.0)),u.x), u.y);',
      '}',
      'float fbm(vec2 p){',
      '  float v=0.0, a=0.55;',
      '  for(int i=0;i<5;i++){ v += a*noise(p); p = p*2.04 + vec2(1.7,9.2); a *= 0.5; }',
      '  return v;',
      '}',
      'void main(){',
      '  vec2 p = (gl_FragCoord.xy - 0.5*u_res)/u_res.y;',
      '  float t = u_time*0.14;',
      '  vec2 q = vec2(fbm(p*1.5 + t), fbm(p*1.5 + vec2(5.2,1.3) - t));',
      '  float f = fbm(p*1.25 + 2.3*q + vec2(0.0, t*0.85));',
      '  vec3 signal = vec3(0.0, 0.44, 0.89);',
      '  vec3 cyan   = vec3(0.06, 0.86, 0.94);',
      '  vec3 violet = vec3(0.52, 0.30, 1.0);',
      '  vec3 col = vec3(0.012, 0.014, 0.035);',
      '  col = mix(col, signal, smoothstep(0.32, 0.95, f));',
      '  col = mix(col, cyan, pow(smoothstep(0.5, 1.0, f*length(q)), 1.4) * 0.9);',
      '  col = mix(col, violet, pow(smoothstep(0.72, 1.0, q.y*1.1), 2.0) * 0.55);',
      '  vec2 m = u_mouse*2.0 - 1.0;',
      '  col += cyan * 0.1 * smoothstep(0.85, 0.0, length(p - m*vec2(0.9, 0.55)));',
      '  col *= mix(0.42, 1.0, smoothstep(0.1, 1.4, length(p*vec2(0.78, 1.0))));',
      '  col += (hash(gl_FragCoord.xy + u_time) - 0.5) * 0.028;',
      '  gl_FragColor = vec4(col, 1.0);',
      '}'
    ].join('\n');

    function compile(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { gl.deleteShader(s); return null; }
      return s;
    }
    var vs = compile(gl.VERTEX_SHADER, vertSrc);
    var fs = compile(gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) { hero.classList.add('no-webgl'); return; }

    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { hero.classList.add('no-webgl'); return; }
    gl.useProgram(prog);

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    var uRes = gl.getUniformLocation(prog, 'u_res');
    var uTime = gl.getUniformLocation(prog, 'u_time');
    var uMouse = gl.getUniformLocation(prog, 'u_mouse');

    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    var mouse = { x: 0.5, y: 0.5 };
    var target = { x: 0.5, y: 0.5 };

    function resize() {
      var w = Math.max(1, Math.floor(hero.clientWidth * dpr));
      var h = Math.max(1, Math.floor(hero.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    }
    resize();
    window.addEventListener('resize', resize);

    hero.addEventListener('mousemove', function (e) {
      var r = hero.getBoundingClientRect();
      target.x = (e.clientX - r.left) / Math.max(1, r.width);
      target.y = (e.clientY - r.top) / Math.max(1, r.height);
    });

    var start = performance.now();
    var running = true;
    var visible = true;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
      }, { threshold: 0 }).observe(canvas);
    }

    function frame(now) {
      if (running) requestAnimationFrame(frame);
      if (!visible) return;
      resize();
      mouse.x += (target.x - mouse.x) * 0.06;
      mouse.y += (target.y - mouse.y) * 0.06;
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, (now - start) / 1000);
      gl.uniform2f(uMouse, mouse.x, mouse.y);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    if (reduceMotion) {
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, 12.0);
      gl.uniform2f(uMouse, 0.5, 0.5);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      requestAnimationFrame(frame);
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { running = false; }
      else if (!running && !reduceMotion) { running = true; start = performance.now() - 1000; requestAnimationFrame(frame); }
    });
  })();

  /* ─────────────── Island state cycle ─────────────── */
  /* The notch cycles through the collapsed state, the transfer peek and the
     three panel views, dwelling longer on the panels. Reduced motion keeps
     the static collapsed notch. Hover, focus or a click pauses the cycle;
     activating the notch advances one state. */
  var island = document.getElementById('island');
  if (island) {
    var states = ['idle', 'peek', 'today', 'desk', 'activity'];
    var dwell = { idle: 2600, peek: 1900, today: 4600, desk: 4600, activity: 4600 };
    var idx = 0;
    var timer = null;

    function render() { island.setAttribute('data-state', states[idx]); }
    function next() { idx = (idx + 1) % states.length; render(); }
    function start() {
      if (reduceMotion) return;
      stop();
      timer = window.setTimeout(function () { next(); start(); }, dwell[states[idx]]);
    }
    function stop() { if (timer) { window.clearTimeout(timer); timer = null; } }

    render();
    start();
    island.addEventListener('mouseenter', stop);
    island.addEventListener('mouseleave', start);
    island.addEventListener('focus', stop);
    island.addEventListener('blur', start);
    island.addEventListener('click', function () { stop(); next(); start(); });
    island.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stop(); next(); start(); }
    });
  }

  /* ─────────────── Reveal on scroll ─────────────── */
  var reveals = Array.prototype.slice.call(document.querySelectorAll('.reveal, [data-reveal]'));
  if ('IntersectionObserver' in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          var el = entry.target;
          el.classList.add('in');
          io.unobserve(el);
          window.setTimeout(function () { el.style.transitionDelay = ''; }, 1000);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
    reveals.forEach(function (el, i) {
      el.style.transitionDelay = Math.min(i % 7, 6) * 45 + 'ms';
      io.observe(el);
    });
  } else {
    reveals.forEach(function (el) { el.classList.add('in'); });
  }

  /* the numbers in the neo-brutalist band count up once, on view */
  (function counters() {
    var nums = Array.prototype.slice.call(document.querySelectorAll('.ch-num'));
    if (!nums.length || reduceMotion || !('IntersectionObserver' in window)) return;
    function run(el) {
      var target = parseInt(el.textContent, 10) || 0;
      if (!target) return;
      var from = performance.now();
      function step(now) {
        var p = Math.min(1, (now - from) / 900);
        var eased = 1 - Math.pow(1 - p, 3);
        el.textContent = String(Math.round(target * eased));
        if (p < 1) requestAnimationFrame(step); else el.textContent = String(target);
      }
      requestAnimationFrame(step);
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        io.unobserve(entry.target);
        run(entry.target);
      });
    }, { threshold: 0.6 });
    nums.forEach(function (el) { io.observe(el); });
  })();

  /* ─────────────── Magnetic capsules ─────────────── */
  if (!reduceMotion) {
    Array.prototype.slice.call(document.querySelectorAll('[data-magnetic]')).forEach(function (el) {
      el.addEventListener('mousemove', function (e) {
        var r = el.getBoundingClientRect();
        var mx = ((e.clientX - r.left) / r.width - 0.5) * 10;
        var my = ((e.clientY - r.top) / r.height - 0.5) * 8;
        el.style.setProperty('--mx', mx.toFixed(2) + 'px');
        el.style.setProperty('--my', my.toFixed(2) + 'px');
      });
      el.addEventListener('mouseleave', function () {
        el.style.setProperty('--mx', '0px');
        el.style.setProperty('--my', '0px');
      });
    });
  }

  /* ─────────────── FAQ accordion with motion ─────────────── */
  var faqItems = Array.prototype.slice.call(document.querySelectorAll('.faq-item'));
  var FAQ_MS = 300;
  var FAQ_EASE = 'cubic-bezier(0.28,0,0.22,1)';

  function faqAnswer(item) { return item.querySelector('.faq-answer'); }

  function closeFaq(item) {
    var ans = faqAnswer(item);
    if (!ans || !item.open) return;
    if (reduceMotion) { item.open = false; ans.style.cssText = ''; return; }
    var h = ans.scrollHeight;
    ans.style.overflow = 'hidden';
    ans.style.height = h + 'px';
    requestAnimationFrame(function () {
      ans.style.transition = 'height ' + FAQ_MS + 'ms ' + FAQ_EASE + ', opacity ' + (FAQ_MS - 70) + 'ms ' + FAQ_EASE;
      ans.style.height = '0px';
      ans.style.opacity = '0';
    });
    window.setTimeout(function () {
      item.open = false;
      ans.style.cssText = '';
    }, FAQ_MS + 20);
  }

  function openFaq(item) {
    var ans = faqAnswer(item);
    if (!ans) return;
    faqItems.forEach(function (other) { if (other !== item) closeFaq(other); });
    if (reduceMotion) { item.open = true; ans.style.cssText = ''; return; }
    item.open = true;
    var h = ans.scrollHeight;
    ans.style.overflow = 'hidden';
    ans.style.height = '0px';
    ans.style.opacity = '0';
    requestAnimationFrame(function () {
      ans.style.transition = 'height ' + FAQ_MS + 'ms ' + FAQ_EASE + ', opacity ' + FAQ_MS + 'ms ' + FAQ_EASE;
      ans.style.height = h + 'px';
      ans.style.opacity = '1';
    });
    window.setTimeout(function () { ans.style.cssText = ''; }, FAQ_MS + 20);
  }

  faqItems.forEach(function (item) {
    var summary = item.querySelector('summary');
    if (!summary) return;
    summary.addEventListener('click', function (e) {
      e.preventDefault();
      if (item.open) closeFaq(item); else openFaq(item);
    });
  });

  /* ─────────────── Parallax and the chapter drift ─────────────── */
  var parallaxEls = Array.prototype.slice.call(document.querySelectorAll('[data-parallax]'));
  var tiltEls = Array.prototype.slice.call(document.querySelectorAll('.chapter-media'));

  function updateScrollMotion() {
    var vh = window.innerHeight;

    parallaxEls.forEach(function (el) {
      var speed = parseFloat(el.getAttribute('data-parallax')) || 0;
      var r = el.getBoundingClientRect();
      var delta = (r.top + r.height / 2 - vh / 2) / vh;
      el.style.transform = 'translate3d(0,' + (delta * speed * 100).toFixed(2) + 'px,0)';
    });

    /* each chapter card drifts against the scroll and leans a couple of
       degrees into it, mirrored left and right down the page */
    if (reduceMotion || window.innerWidth <= 900) {
      tiltEls.forEach(function (el) { el.style.transform = ''; });
      return;
    }
    tiltEls.forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.bottom < -120 || r.top > vh + 120) return;
      var p = (r.top + r.height / 2 - vh / 2) / vh;
      var dir = el.parentNode && el.parentNode.classList.contains('rev') ? -1 : 1;
      el.style.transform = 'translate3d(0,' + (p * -26).toFixed(2) + 'px,0) rotateZ(' +
        (p * 3.4 * dir).toFixed(2) + 'deg)';
    });
  }

  if (!reduceMotion && (parallaxEls.length || tiltEls.length)) {
    var motionTicking = false;
    var onMotion = function () {
      if (motionTicking) return;
      motionTicking = true;
      requestAnimationFrame(function () { updateScrollMotion(); motionTicking = false; });
    };
    window.addEventListener('scroll', onMotion, { passive: true });
    window.addEventListener('resize', onMotion);
    updateScrollMotion();
  }

  /* ─────────────── Page beam: the relay runs the length of the page ─────────────── */
  (function beam() {
    var flow = document.querySelector('.beam-flow');
    var layer = document.querySelector('.beam-layer');
    var path = document.getElementById('beam-progress');
    var chip = document.getElementById('beam-chip');
    if (!flow || !layer || !path || !chip) return;

    var len = 0;
    try { len = path.getTotalLength(); } catch (e) { len = 0; }
    if (!len) return;

    path.style.strokeDasharray = String(len);

    function place(t) {
      path.style.strokeDashoffset = (len * (1 - t)).toFixed(1);
      var pt = path.getPointAtLength(len * t);
      var w = layer.clientWidth || 1;
      var h = layer.clientHeight || 1;
      chip.style.transform = 'translate(' + ((pt.x / 1000) * w).toFixed(1) + 'px,' + ((pt.y / 1000) * h).toFixed(1) + 'px)';
    }

    function progress() {
      var rect = flow.getBoundingClientRect();
      var vh = window.innerHeight;
      return Math.max(0, Math.min(1, (vh - rect.top) / rect.height));
    }

    if (reduceMotion) {
      place(0.64);
      chip.classList.add('in');
      window.addEventListener('resize', function () { place(0.64); });
      return;
    }

    var ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        var t = progress();
        chip.classList.toggle('in', t > 0.005 && t < 0.995);
        place(t);
        ticking = false;
      });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();
  })();
})();
