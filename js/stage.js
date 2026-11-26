// Scales the fixed 1080x1920 stage to fit the current viewport (kiosk, tablet, laptop preview).
(function () {
  const stage = document.querySelector('.stage');
  if (!stage) return;
  const W = 1080, H = 1920;
  function fit() {
    const s = Math.min(window.innerWidth / W, window.innerHeight / H);
    stage.style.transform = `scale(${s})`;
    document.documentElement.style.setProperty('--stage-scale', s);
  }
  window.addEventListener('resize', fit, { passive: true });
  window.addEventListener('orientationchange', fit, { passive: true });
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
