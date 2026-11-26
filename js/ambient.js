// Ambient animation layer: falling wafers, rising steam and gold sparkles on one cheap canvas.
// Usage: const amb = KKAmbient.create({ stage, zIndex, wafers: 6, steam: {x, y, w}, sparkles: 10 }); amb.stop();
// Everything is pre-rendered once; per frame it is only drawImage calls. Pauses when the tab is hidden.
(function () {
  const W = 1080, H = 1920;
  function rnd(a, b) { return a + Math.random() * (b - a); }

  function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  // Soft steam puff sprite (radial white blob), rendered once.
  function steamSprite(size) {
    const c = makeCanvas(size, size), g = c.getContext('2d');
    const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grd.addColorStop(0, 'rgba(255,255,255,.55)'); grd.addColorStop(.5, 'rgba(255,255,255,.18)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, size, size); return c;
  }
  // Four-point gold sparkle sprite.
  function sparkSprite(size) {
    const c = makeCanvas(size, size), g = c.getContext('2d'); const m = size / 2;
    g.translate(m, m); g.fillStyle = '#ffe9a8'; g.shadowColor = 'rgba(255,220,140,.9)'; g.shadowBlur = size * .25;
    g.beginPath(); g.moveTo(0, -m); g.quadraticCurveTo(0, 0, m, 0); g.quadraticCurveTo(0, 0, 0, m); g.quadraticCurveTo(0, 0, -m, 0); g.quadraticCurveTo(0, 0, 0, -m); g.fill();
    return c;
  }

  function create(opts) {
    const stage = opts.stage || document.querySelector('.stage');
    const ps = (window.KKStage && window.KKStage.pixelScale) || 1;
    const cv = makeCanvas(Math.round(W * ps), Math.round(H * ps));
    cv.className = 'ambient'; cv.style.cssText = `position:absolute;inset:0;width:${W}px;height:${H}px;pointer-events:none;z-index:${opts.zIndex || 0}`;
    (opts.before ? stage.insertBefore(cv, opts.before) : stage.appendChild(cv));
    const g = cv.getContext('2d'); g.scale(ps, ps);

    const steamImg = steamSprite(160), sparkImg = sparkSprite(44);
    let waferImg = null; const waferSrc = opts.waferSrc || 'assets/img/game/wafer.png';
    if (opts.wafers) { const im = new Image(); im.onload = () => { waferImg = im; }; im.src = waferSrc; }

    const wafers = [], puffs = [], sparks = [];
    const area = opts.waferArea || { x0: 60, x1: W - 60, y0: -300, y1: H + 100 };
    function resetWafer(w, top) {
      w.x = rnd(area.x0, area.x1); w.y = top ? rnd(area.y0 - 200, area.y0) : rnd(area.y0, area.y1);
      w.vy = rnd(40, 90) * (opts.waferSpeed || 1); w.rot = rnd(-0.6, 0.6); w.vr = rnd(-0.25, 0.25); w.s = rnd(0.45, 0.8); w.sway = rnd(0, 6.28); w.alpha = rnd(0.55, 0.95);
    }
    for (let i = 0; i < (opts.wafers || 0); i++) { const w = {}; resetWafer(w, false); wafers.push(w); }
    const st = opts.steam; // {x, y, w}
    function resetPuff(p, fresh) { p.x = st.x + rnd(-st.w / 2, st.w / 2); p.y = fresh ? st.y : st.y - rnd(0, 260); p.vy = rnd(28, 55); p.vx = rnd(-8, 8); p.s = rnd(0.5, 1.0); p.life = fresh ? 0 : rnd(0, 1); p.rate = 1 / rnd(3.5, 6); }
    if (st) for (let i = 0; i < (st.count || 12); i++) { const p = {}; resetPuff(p, false); puffs.push(p); }
    const spotCount = opts.sparkles || 0; const spotArea = opts.sparkleArea || { x0: 40, x1: W - 40, y0: 40, y1: H * 0.75 };
    function resetSpark(s) { s.x = rnd(spotArea.x0, spotArea.x1); s.y = rnd(spotArea.y0, spotArea.y1); s.t = rnd(0, 1); s.rate = 1 / rnd(1.6, 3.2); s.size = rnd(14, 34); s.rot = rnd(0, 1); }
    for (let i = 0; i < spotCount; i++) { const s = {}; resetSpark(s); sparks.push(s); }

    let last = performance.now(), raf = 0, running = true;
    function frame(now) {
      if (!running) return;
      let dt = Math.min(0.05, (now - last) / 1000); last = now;
      g.clearRect(0, 0, W, H);
      // wafers
      if (waferImg) for (const w of wafers) {
        w.y += w.vy * dt; w.rot += w.vr * dt; w.sway += dt;
        if (w.y > area.y1) resetWafer(w, true);
        const x = w.x + Math.sin(w.sway) * 14;
        g.save(); g.globalAlpha = w.alpha; g.translate(x, w.y); g.rotate(w.rot); g.scale(w.s, w.s);
        g.drawImage(waferImg, -waferImg.width / 4, -waferImg.height / 4, waferImg.width / 2, waferImg.height / 2); g.restore();
      }
      // steam
      for (const p of puffs) {
        p.life += p.rate * dt; p.y -= p.vy * dt; p.x += (p.vx + Math.sin(p.life * 6) * 10) * dt;
        if (p.life >= 1) resetPuff(p, true);
        const a = Math.sin(p.life * Math.PI) * 0.9, sz = 160 * p.s * (0.6 + p.life * 0.9);
        g.globalAlpha = a; g.drawImage(steamImg, p.x - sz / 2, p.y - sz / 2, sz, sz);
      }
      // sparkles
      for (const s of sparks) {
        s.t += s.rate * dt; if (s.t >= 1) resetSpark(s);
        const a = Math.sin(s.t * Math.PI), sz = s.size * (0.5 + a * 0.6);
        g.save(); g.globalAlpha = a; g.translate(s.x, s.y); g.rotate(s.rot + s.t * 1.2); g.drawImage(sparkImg, -sz / 2, -sz / 2, sz, sz); g.restore();
      }
      g.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    const vis = () => { if (document.hidden) { cancelAnimationFrame(raf); } else { last = performance.now(); raf = requestAnimationFrame(frame); } };
    document.addEventListener('visibilitychange', vis);
    return { canvas: cv, stop() { running = false; cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', vis); cv.remove(); } };
  }
  window.KKAmbient = { create };
})();
