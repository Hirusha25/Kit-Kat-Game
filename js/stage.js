// Scales the fixed 1080x1920 design stage to the device.
//  - Kiosk / desktop ("fit" mode): the stage is centred and scaled to fit the viewport. On the 4K kiosk
//    (2160x3840 portrait) that is exactly 2x; text, CSS and the game canvas render at full native resolution.
//  - Phone ("scroll" mode, viewport narrower than 700 CSS px): the stage is scaled to the viewport WIDTH and
//    the page scrolls vertically, so the native keyboard and browser chrome never squash the layout.
// Exposes window.KKStage = { scale, mode, dpr, refit() } and sets html.is-phone / html.is-kiosk.
(function () {
  const stage = document.querySelector('.stage');
  const viewport = document.querySelector('.viewport');
  if (!stage) return;
  const W = 1080, H = 1920;
  const html = document.documentElement;
  const params = new URLSearchParams(location.search);
  const forced = params.get('mode'); // 'fit' | 'scroll' for testing
  // Font pairing switch for design review: ?font=a|b|c (remembered)
  try { const f = params.get('font'); if (f) localStorage.setItem('kk_font', f); const cur = localStorage.getItem('kk_font'); if (cur && cur !== 'a') html.setAttribute('data-font', cur); } catch (_) {}

  function vw() { return (window.visualViewport && window.visualViewport.width) || window.innerWidth; }
  function vh() { return window.innerHeight; } // innerHeight ignores the on-screen keyboard; visualViewport shrinks with it

  function fit() {
    const width = vw(), height = vh();
    const phone = forced ? forced === 'scroll' : (width < 700 && ('ontouchstart' in window || navigator.maxTouchPoints > 0));
    const dpr = window.devicePixelRatio || 1;
    let s;
    if (phone) {
      s = width / W;
      html.classList.add('is-phone');
      stage.style.transformOrigin = 'top left';
      stage.style.transform = `scale(${s})`;
      // collapse the layout box to the scaled size so nothing can scroll sideways
      stage.style.marginRight = -(W - W * s) + 'px';
      stage.style.marginBottom = -(H - H * s) + 'px';
      if (viewport) { viewport.style.height = Math.round(H * s) + 'px'; viewport.scrollLeft = 0; }
    } else {
      s = Math.min(width / W, height / H);
      html.classList.remove('is-phone');
      stage.style.transformOrigin = 'center center';
      stage.style.transform = `scale(${s})`;
      stage.style.marginRight = ''; stage.style.marginBottom = '';
      if (viewport) viewport.style.height = '';
    }
    html.classList.toggle('is-kiosk', !phone && height * dpr >= 1900);
    html.style.setProperty('--stage-scale', s);
    window.KKStage = { scale: s, mode: phone ? 'scroll' : 'fit', dpr, refit: fit, pixelScale: Math.min(2, Math.max(1, Math.round(s * dpr * 2) / 2)) };
    window.dispatchEvent(new CustomEvent('kk:stage', { detail: window.KKStage }));
  }
  window.addEventListener('resize', fit, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(fit, 150), { passive: true });
  fit();

  // Keep the background video playing on kiosk browsers that pause it.
  const v = document.querySelector('.bg video');
  if (v) {
    v.muted = true; v.loop = true; v.playsInline = true;
    const tryPlay = () => v.play().catch(() => {});
    tryPlay();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tryPlay(); });
    document.addEventListener('pointerdown', tryPlay, { once: true });
  }

  // Scatter a few gold sparkles.
  const host = document.querySelector('.content');
  if (host && !document.body.classList.contains('no-sparks')) {
    const svg = '<svg viewBox="0 0 24 24"><path d="M12 0c.6 7.2 4.8 11.4 12 12-7.2.6-11.4 4.8-12 12-.6-7.2-4.8-11.4-12-12 7.2-.6 11.4-4.8 12-12z"/></svg>';
    const spots = [[70, 150], [980, 120], [140, 520], [930, 470], [220, 820], [860, 760], [90, 1120], [990, 1020]];
    spots.forEach(([x, y], i) => {
      const el = document.createElement('i');
      el.className = 'spark'; el.innerHTML = svg;
      el.style.left = x + 'px'; el.style.top = y + 'px';
      el.style.animationDelay = (i * .45) + 's';
      el.style.width = el.style.height = (18 + (i % 3) * 8) + 'px';
      host.appendChild(el);
    });
  }
})();
