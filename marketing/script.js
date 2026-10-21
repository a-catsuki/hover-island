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
    var contextOptions = { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false };
    var gl = canvas.getContext('webgl', contextOptions) || canvas.getContext('experimental-webgl', contextOptions);
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

    var dpr = Math.min(window.devicePixelRatio || 1, 1.25);
    var mouse = { x: 0.5, y: 0.5 };
    var target = { x: 0.5, y: 0.5 };

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 1.25);
      var w = Math.max(1, Math.floor(hero.clientWidth * dpr));
      var h = Math.max(1, Math.floor(hero.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    }
    resize();
    var frameId = 0;
    var visible = !('IntersectionObserver' in window);
    function drawStatic() {
      resize();
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, 12.0);
      gl.uniform2f(uMouse, 0.5, 0.5);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    function pause() {
      if (!frameId) return;
      cancelAnimationFrame(frameId);
      frameId = 0;
    }
    function schedule() {
      if (reduceMotion || document.hidden || !visible || frameId) return;
      frameId = requestAnimationFrame(frame);
    }
    window.addEventListener('resize', function () {
      if (reduceMotion) {
        if (visible && !document.hidden) drawStatic();
      } else {
        resize();
        schedule();
      }
    });

    hero.addEventListener('mousemove', function (e) {
      var r = hero.getBoundingClientRect();
      target.x = (e.clientX - r.left) / Math.max(1, r.width);
      target.y = (e.clientY - r.top) / Math.max(1, r.height);
    });

    var start = performance.now();
    var lastDraw = 0;
    var frameInterval = 1000 / 30;
    var running = true;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (!visible) pause();
        else if (reduceMotion) { if (!document.hidden) drawStatic(); }
        else { resize(); schedule(); }
      }, { threshold: 0 }).observe(canvas);
    }

    function frame(now) {
      frameId = 0;
      if (!running || reduceMotion || document.hidden || !visible) return;
      if (now - lastDraw < frameInterval) { schedule(); return; }
      lastDraw = now;
      mouse.x += (target.x - mouse.x) * 0.06;
      mouse.y += (target.y - mouse.y) * 0.06;
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, (now - start) / 1000);
      gl.uniform2f(uMouse, mouse.x, mouse.y);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      schedule();
    }

    if (reduceMotion) {
      if (visible && !document.hidden) drawStatic();
    } else {
      schedule();
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { running = false; pause(); }
      else {
        running = true;
        start = performance.now() - 1000;
        if (reduceMotion) { if (visible) drawStatic(); }
        else { resize(); schedule(); }
      }
    });
  })();

  /* ─────────────── Island product preview ─────────────── */
  /* The preview mirrors the app's normal interaction: a short activity peek,
     a delayed hover-open, user-selected panel tabs, and a delayed close after
     the pointer leaves. The sample notification is presented once and never
     implies that a real transfer is running. */
  var island = document.getElementById('island');
  if (island) {
    var panel = island.querySelector('.island__panel');
    var tabs = Array.prototype.slice.call(island.querySelectorAll('.ptab[data-tab]'));
    var peekAction = island.querySelector('.peekx-action');
    var state = 'idle';
    var pointerInside = false;
    var userInteracted = false;
    var autoTimer = 0;
    var autoStartedAt = 0;
    var autoRemaining = 0;
    var autoCallback = null;
    var autoPhase = '';
    var openTimer = 0;
    var closeTimer = 0;
    var visible = !('IntersectionObserver' in window);

    island.setAttribute('role', 'button');
    island.setAttribute('tabindex', '0');
    if (panel) panel.id = 'preview-island-panel';

    var stateNames = { today: 'Today', desk: 'Desk', activity: 'Activity' };
    var gridByState = {
      today: island.querySelector('.widget-grid--today'),
      desk: island.querySelector('.widget-grid--desk'),
      activity: island.querySelector('.widget-grid--activity'),
    };

    /* The sample transfer uses the same source name and action as the app. */
    var peekApp = island.querySelector('.peekx-app');
    if (peekApp) peekApp.textContent = 'Phone bucket';
    if (peekAction) {
      peekAction.setAttribute('role', 'button');
      peekAction.setAttribute('tabindex', '0');
      peekAction.setAttribute('aria-label', 'Open the File bucket in the Desk panel');
    }

    /* The shipped panel footer is status-only; the mock count and pager were
       not part of the real ExpandedPanel. */
    var footer = island.querySelector('.panel__foot');
    if (footer) {
      var footerStatus = footer.firstElementChild;
      if (footerStatus) footerStatus.textContent = '';
      var mockPager = footer.querySelector('.panel-pager');
      if (mockPager) mockPager.remove();
      footer.setAttribute('aria-hidden', 'true');
    }

    var tabList = island.querySelector('.panel-tabs');
    if (tabList) tabList.setAttribute('role', 'tablist');
    tabs.forEach(function (tab) {
      var name = tab.getAttribute('data-tab');
      var grid = gridByState[name];
      tab.setAttribute('role', 'tab');
      tab.setAttribute('id', 'preview-tab-' + name);
      tab.setAttribute('aria-controls', 'preview-panel-' + name);
      if (grid) {
        grid.setAttribute('id', 'preview-panel-' + name);
        grid.setAttribute('role', 'tabpanel');
        grid.setAttribute('aria-labelledby', 'preview-tab-' + name);
      }
    });

    if (panel && 'inert' in panel) panel.inert = true;

    function setState(next) {
      if (['idle', 'peek', 'today', 'desk', 'activity'].indexOf(next) < 0) return;
      state = next;
      island.setAttribute('data-state', state);
      var panelOpen = !!stateNames[state];
      island.setAttribute('role', state === 'idle' ? 'button' : 'group');
      if (state === 'idle') {
        island.setAttribute('aria-expanded', 'false');
        if (panel) island.setAttribute('aria-controls', panel.id);
      } else {
        island.removeAttribute('aria-expanded');
        island.removeAttribute('aria-controls');
      }
      island.setAttribute('aria-label', state === 'idle'
        ? 'Hover Island compact preview. Hover or activate to open the Today panel.'
        : state === 'peek'
          ? 'Example Phone bucket transfer notification. 64 percent of presentation.pdf is sending. Open Files opens the Desk panel.'
          : 'Hover Island ' + stateNames[state] + ' panel preview. Use the panel tabs to choose Today, Desk, or Activity.');
      var idleFace = island.querySelector('.face-idle');
      var peekFace = island.querySelector('.face-peek');
      if (idleFace) idleFace.setAttribute('aria-hidden', state !== 'idle' ? 'true' : 'false');
      if (peekFace) peekFace.setAttribute('aria-hidden', state !== 'peek' ? 'true' : 'false');
      if (peekAction) peekAction.setAttribute('tabindex', state === 'peek' ? '0' : '-1');
      if (panel) {
        panel.setAttribute('aria-hidden', panelOpen ? 'false' : 'true');
        if ('inert' in panel) panel.inert = !panelOpen;
      }
      tabs.forEach(function (tab) {
        var selected = tab.getAttribute('data-tab') === state;
        tab.setAttribute('aria-selected', selected ? 'true' : 'false');
        tab.setAttribute('tabindex', selected ? '0' : '-1');
      });
      Object.keys(gridByState).forEach(function (key) {
        var grid = gridByState[key];
        if (grid) grid.setAttribute('aria-hidden', state === key ? 'false' : 'true');
      });
      syncIslandViz();
    }

    function cancelAuto() {
      if (autoTimer) window.clearTimeout(autoTimer);
      autoTimer = 0;
      autoCallback = null;
      autoPhase = '';
      autoRemaining = 0;
    }
    function pauseAuto() {
      if (!autoTimer) return;
      window.clearTimeout(autoTimer);
      autoTimer = 0;
      autoRemaining = Math.max(0, autoRemaining - (performance.now() - autoStartedAt));
    }
    function autoIsActive() { return visible && !document.hidden && !reduceMotion && (!userInteracted || autoPhase === 'expire-peek'); }
    function resumeAuto() {
      if (autoTimer || !autoCallback || !autoIsActive()) return;
      autoStartedAt = performance.now();
      autoTimer = window.setTimeout(function () {
        autoTimer = 0;
        autoRemaining = 0;
        var callback = autoCallback;
        autoCallback = null;
        autoPhase = '';
        if (callback) callback();
      }, autoRemaining);
    }
    function scheduleAuto(delay, phase, callback) {
      cancelAuto();
      autoRemaining = delay;
      autoPhase = phase;
      autoCallback = callback;
      resumeAuto();
    }
    function claimInteraction() {
      userInteracted = true;
      /* Let an already visible event expire naturally, but don't show a new
         one after the visitor has started exploring the preview. */
      if (autoPhase === 'start-peek') cancelAuto();
    }
    function showSamplePeek() {
      if (userInteracted || state !== 'idle') return;
      setState('peek');
      scheduleAuto(3600, 'expire-peek', function () {
        if (state === 'peek') setState('idle');
      });
    }
    function selectTab(name, focusTab) {
      if (!stateNames[name]) return;
      claimInteraction();
      cancelAuto();
      setState(name);
      if (focusTab) {
        var selectedTab = tabs.find(function (tab) { return tab.getAttribute('data-tab') === name; });
        if (selectedTab) selectedTab.focus();
      }
    }
    function scheduleClose() {
      window.clearTimeout(openTimer);
      window.clearTimeout(closeTimer);
      if (!stateNames[state]) return;
      closeTimer = window.setTimeout(function () {
        if (!pointerInside) setState('idle');
      }, 450);
    }

    function syncIslandViz() {
      var bars = island.querySelector('.media__viz--bars');
      if (bars) setBarsPlaying(bars, state === 'today' && visible && !document.hidden && !reduceMotion);
    }

    function setBarsPlaying(root, playing) {
      Array.prototype.slice.call(root.children).forEach(function (bar) {
        bar.style.animationPlayState = playing ? 'running' : 'paused';
      });
    }

    setState('idle');
    island.addEventListener('mouseenter', function () {
      pointerInside = true;
      claimInteraction();
      window.clearTimeout(closeTimer);
      if (state === 'idle') {
        window.clearTimeout(openTimer);
        openTimer = window.setTimeout(function () {
          if (pointerInside && state === 'idle') setState('today');
        }, 140);
      }
    });
    island.addEventListener('mouseleave', function () {
      pointerInside = false;
      scheduleClose();
    });
    island.addEventListener('focusin', function () {
      claimInteraction();
      window.clearTimeout(closeTimer);
    });
    island.addEventListener('focusout', function (event) {
      var next = event.relatedTarget;
      if (!(next instanceof Node) || !island.contains(next)) scheduleClose();
    });
    island.addEventListener('click', function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var tab = target.closest('.ptab[data-tab]');
      if (tab) {
        selectTab(tab.getAttribute('data-tab'), false);
        return;
      }
      if (target.closest('.peekx-action')) {
        selectTab('desk', true);
        return;
      }
      if (target.closest('.face-peek')) {
        claimInteraction();
        cancelAuto();
        setState('idle');
        return;
      }
      if (state === 'idle' && (target === island || target.closest('.face-idle, .notch-cam'))) {
        claimInteraction();
        cancelAuto();
        setState('today');
      }
    });
    island.addEventListener('keydown', function (event) {
      var target = event.target;
      if (target instanceof Element) {
        var currentTab = target.closest('.ptab[data-tab]');
        if (currentTab) {
          var currentIndex = tabs.indexOf(currentTab);
          var nextIndex = currentIndex;
          if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
          else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
          else if (event.key === 'Home') nextIndex = 0;
          else if (event.key === 'End') nextIndex = tabs.length - 1;
          if (nextIndex !== currentIndex) {
            event.preventDefault();
            selectTab(tabs[nextIndex].getAttribute('data-tab'), true);
            return;
          }
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectTab(currentTab.getAttribute('data-tab'), true);
            return;
          }
        }
        if (target.closest('.peekx-action') && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          selectTab('desk', true);
          return;
        }
      }
      if (event.key === 'Escape' && state !== 'idle') {
        event.preventDefault();
        event.stopPropagation();
        claimInteraction();
        cancelAuto();
        setState('idle');
        island.focus();
        return;
      }
      if (target === island && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        claimInteraction();
        cancelAuto();
        setState(state === 'peek' ? 'idle' : state === 'idle' ? 'today' : state);
      }
    });

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (autoIsActive()) resumeAuto();
        else pauseAuto();
        syncIslandViz();
      }, { threshold: 0 }).observe(island);
    }
    document.addEventListener('visibilitychange', function () {
      if (autoIsActive()) resumeAuto();
      else pauseAuto();
      syncIslandViz();
    });
    if (!reduceMotion) scheduleAuto(1200, 'start-peek', showSamplePeek);
  }

  /* The feature-card equalizer is illustrative. Keep its CSS bars still until
     that card is on screen, and while the tab is hidden or motion is reduced. */
  (function visibleEqualizers() {
    var roots = Array.prototype.slice.call(document.querySelectorAll('.vm-bars'));
    if (!roots.length) return;
    var visibleRoots = new Set();
    function sync(root) {
      var running = visibleRoots.has(root) && !document.hidden && !reduceMotion;
      Array.prototype.slice.call(root.children).forEach(function (bar) {
        bar.style.animationPlayState = running ? 'running' : 'paused';
      });
    }
    roots.forEach(function (root) { sync(root); });
    if ('IntersectionObserver' in window) {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) visibleRoots.add(entry.target);
          else visibleRoots.delete(entry.target);
          sync(entry.target);
        });
      }, { rootMargin: '80px 0px' });
      roots.forEach(function (root) { observer.observe(root); });
    } else {
      roots.forEach(function (root) { visibleRoots.add(root); sync(root); });
    }
    document.addEventListener('visibilitychange', function () {
      roots.forEach(sync);
    });
  })();

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
  var scrollMotionEls = Array.from(new Set(parallaxEls.concat(tiltEls)));
  var activeMotionEls = new Set();
  /* Keep compositor layer promotion scoped to elements near the viewport. */
  scrollMotionEls.forEach(function (el) { el.style.willChange = 'auto'; });

  function updateScrollMotion() {
    if (document.hidden) return;
    var vh = window.innerHeight;
    var canTilt = !reduceMotion && window.innerWidth > 900;
    activeMotionEls.forEach(function (el) {
      var r = el.getBoundingClientRect();
      var p = (r.top + r.height / 2 - vh / 2) / vh;
      if (r.bottom < -120 || r.top > vh + 120) {
        activeMotionEls.delete(el);
        el.style.transform = '';
        el.style.willChange = 'auto';
        return;
      }
      var transforms = [];
      if (el.hasAttribute('data-parallax')) {
        var speed = parseFloat(el.getAttribute('data-parallax')) || 0;
        var delta = (r.top + r.height / 2 - vh / 2) / vh;
        transforms.push('translate3d(0,' + (delta * speed * 100).toFixed(2) + 'px,0)');
      }
      if (canTilt && el.classList.contains('chapter-media')) {
        /* each chapter card drifts against the scroll and leans a couple of
           degrees into it, mirrored left and right down the page */
        var dir = el.parentNode && el.parentNode.classList.contains('rev') ? -1 : 1;
        transforms.push('translate3d(0,' + (p * -26).toFixed(2) + 'px,0)');
        transforms.push('rotateZ(' + (p * 3.4 * dir).toFixed(2) + 'deg)');
      }
      el.style.transform = transforms.join(' ');
      el.style.willChange = transforms.length ? 'transform' : 'auto';
    });
  }

  if (!reduceMotion && scrollMotionEls.length) {
    var motionTicking = false;
    var onMotion = function () {
      if (document.hidden || motionTicking) return;
      motionTicking = true;
      requestAnimationFrame(function () {
        if (!document.hidden) updateScrollMotion();
        motionTicking = false;
      });
    };
    if ('IntersectionObserver' in window) {
      var motionObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            activeMotionEls.add(entry.target);
            entry.target.style.willChange = 'transform';
          } else {
            activeMotionEls.delete(entry.target);
            entry.target.style.transform = '';
            entry.target.style.willChange = 'auto';
          }
        });
        onMotion();
      }, { rootMargin: '120px 0px' });
      scrollMotionEls.forEach(function (el) { motionObserver.observe(el); });
    } else {
      scrollMotionEls.forEach(function (el) { activeMotionEls.add(el); });
    }
    window.addEventListener('scroll', onMotion, { passive: true });
    window.addEventListener('resize', onMotion);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) onMotion(); });
    if (activeMotionEls.size) updateScrollMotion();
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


/* Hero demo: scale the embedded app (laid out at 880 x 576) to the screen it sits in. */
(function () {
  var frame = document.getElementById('hero-app');
  if (!frame || !frame.parentElement) return;
  var fit = function () {
    var width = frame.parentElement.clientWidth;
    if (width) frame.style.setProperty('--app-scale', String(width / 880));
  };
  fit();
  window.addEventListener('resize', fit);
  if ('ResizeObserver' in window) new ResizeObserver(fit).observe(frame.parentElement);
})();
