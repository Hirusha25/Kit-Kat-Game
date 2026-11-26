// Game page flow: boot -> calibrate -> countdown -> playing (lost/regained) -> ended -> results -> idle -> cover.
// Owns the HUD, overlays, setup panel, leaderboard and the glue between MugTracker and DunkGame.
(function () {
  const $ = id => document.getElementById(id);
  const stageW = 1080;
  const qs = new URLSearchParams(location.search);
  const DURATION = Math.max(5, Math.min(120, parseInt(qs.get('duration') || '45', 10) || 45));
  const LS = { settings: 'kk_settings', board: 'kk_leaderboard', players: 'kk_players' };

  // ---------- settings ----------
  const settings = Object.assign({ mirror: true, sensitivity: 0.42, smoothing: 0.35, pip: false, sound: true, deviceId: '', capMin: 12, teeMin: 25, cameraConfirmed: false }, load(LS.settings));
  LS.stock = 'kk_stock';
  const DAILY_STOCK = 80;
  function load(k) { try { return JSON.parse(localStorage.getItem(k) || 'null') || {}; } catch (_) { return {}; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }

  // ---------- player & leaderboard ----------
  let player = null;
  try { player = JSON.parse(sessionStorage.getItem('kk_current') || 'null'); } catch (_) {}
  const firstName = player && player.name ? player.name.split(' ')[0] : '';
  function todayKey() { return new Date().toISOString().slice(0, 10); }
  function board() { const b = load(LS.board); return Array.isArray(b.rows) ? b.rows.filter(r => r.day === todayKey()) : []; }
  function liveRank(score) { return 1 + board().filter(r => r.score > score).length; }
  function recordScore(result) {
    const rows = board();
    rows.push({ day: todayKey(), name: firstName || 'Guest', code: player && player.code, score: result.score, caught: result.caught, streak: result.bestStreak, ts: Date.now() });
    rows.sort((a, b) => b.score - a.score || a.ts - b.ts);
    save(LS.board, { rows: rows.slice(0, 500) });
    return 1 + rows.findIndex(r => r.ts === rows.find(x => x.score === result.score && x.name === (firstName || 'Guest')).ts);
  }

  // ---------- rewards: cap and T-shirt, 80 each per day ----------
  function stock() { const st = load(LS.stock); if (st.day !== todayKey()) return { day: todayKey(), cap: DAILY_STOCK, tee: DAILY_STOCK, awarded: [] }; return st; }
  function prizeCode(kind) { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const r = new Uint32Array(4); crypto.getRandomValues(r); return (kind === 'tee' ? 'TEE-' : 'CAP-') + Array.from(r, n => a[n % a.length]).join(''); }
  function awardPrize(result) {
    const st = stock(); let kind = null;
    if (result.score >= settings.teeMin && st.tee > 0) kind = 'tee';
    else if (result.score >= settings.capMin && st.cap > 0) kind = 'cap';
    else if (result.score >= settings.teeMin && st.cap > 0) kind = 'cap'; // tees gone, fall back to a cap
    if (!kind) return { kind: null, soldOut: result.score >= settings.capMin };
    st[kind] -= 1; const code = prizeCode(kind);
    st.awarded.push({ kind, code, name: firstName || 'Guest', mobile: player && player.mobile, score: result.score, ts: Date.now() });
    save(LS.stock, st);
    return { kind, code, left: st[kind] };
  }
  const prizeIcons = {
    cap: '<svg viewBox="0 0 24 24"><path d="M4 14c0-4.4 3.6-8 8-8s8 3.6 8 8v1H4v-1z"/><path d="M4 15h12c2.5 0 4.5 1 6 2.5"/><path d="M12 6V4"/></svg>',
    tee: '<svg viewBox="0 0 24 24"><path d="M8 4l4 2 4-2 5 3-2 4-3-1v10H8V10l-3 1-2-4 5-3z"/></svg>',
    none: '<svg viewBox="0 0 24 24"><path d="M5 8h14v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8z"/><path d="M19 10h2a2 2 0 0 1 0 4h-2M9 3c0 2 2 2 2 4M13 3c0 2 2 2 2 4"/></svg>'
  };

  // ---------- overlays & toast ----------
  const ov = { cal: $('ov-cal'), count: $('ov-count'), lost: $('ov-lost'), end: $('ov-end') };
  function show(name) { Object.keys(ov).forEach(k => ov[k].classList.toggle('show', k === name)); document.body.classList.toggle('pre', name === 'cal' || name === 'end'); }
  function hideAll() { show(null); }
  let toastT; function toast(msg, ms = 2200) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }

  // ---------- HUD ----------
  const hud = { time: $('hud-time'), score: $('hud-score'), rank: $('hud-rank'), el: $('hud') };
  const last = { time: '', score: '', rank: '' };
  function setText(key, v) {
    if (last[key] === v) return;
    last[key] = v; hud[key].textContent = v;
    if (key !== 'time') { hud[key].classList.remove('bump'); void hud[key].offsetWidth; hud[key].classList.add('bump'); }
  }
  function countUp(el, to, ms) {
    const t0 = performance.now(); const from = 0;
    const step = now => { const k = Math.min(1, (now - t0) / ms); const e = 1 - Math.pow(1 - k, 3); setScoreNumber(Math.round(from + (to - from) * e)); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  function fmtTime(s) { s = Math.max(0, Math.ceil(s)); return '00:' + String(s).padStart(2, '0'); }
  const knob = $('knob');
  const sliderLeft = 70, sliderWidth = 820 - 140; // slider inner track in stage px

  // ---------- tracker ----------
  const video = $('cam');
  let tracker = null, trackState = { found: false, x: 0.5 };
  let lastFoundAt = 0;
  async function startTracker() {
    tracker = MugTracker.create({ video, width: 160, height: 90, mirror: settings.mirror, smoothing: settings.smoothing, useWorker: true, workerUrl: 'js/tracker-worker.js?v=20261126e' });
    tracker.setOptions({ sensitivity: settings.sensitivity });
    tracker.onUpdate = onTrack;
    await tracker.start({ deviceId: settings.deviceId || undefined, facingMode: 'user' });
  }
  function onTrack(s) {
    trackState = s;
    if (s.found) lastFoundAt = performance.now();
    if (game && phase === 'playing') { game.setTargetX(s.x); game.setTracking(s.found); }
    // knob follows the tracker directly so it feels alive even when paused
    const px = sliderLeft + Math.min(1, Math.max(0, s.x)) * sliderWidth;
    knob.style.transform = `translateX(${px - 410}px)`; // knob is centred at 50% of the 820px slider by default
    if (pipOn) drawPip(s);
    if (phase === 'calibrating') calTick(s);
  }

  // ---------- privacy camera view: blurred silhouette + sharp mug crop only ----------
  const tiny = document.createElement('canvas'); tiny.width = 48; tiny.height = 27; const tctx = tiny.getContext('2d');
  function drawPrivacy(ctx, w, h, s) {
    if (!video.videoWidth) { ctx.fillStyle = '#2a0206'; ctx.fillRect(0, 0, w, h); return; }
    const vw = video.videoWidth, vh = video.videoHeight;
    // 1) heavily softened feed: draw at 48x27 then scale up with smoothing; tint red and darken
    tctx.save(); if (settings.mirror) { tctx.translate(tiny.width, 0); tctx.scale(-1, 1); } tctx.drawImage(video, 0, 0, tiny.width, tiny.height); tctx.restore();
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.filter = 'blur(6px) saturate(.4) brightness(.55)';
    ctx.drawImage(tiny, -8, -8, w + 16, h + 16); ctx.restore();
    ctx.fillStyle = 'rgba(120,10,20,.45)'; ctx.fillRect(0, 0, w, h);
    // 2) sharp crop of the mug (and the hand holding it), in place, with a green frame
    if (!(s && s.found && s.w > 0)) {
      // hint: dashed mug outline in the centre
      ctx.save(); ctx.translate(w / 2, h / 2); ctx.strokeStyle = 'rgba(255,236,190,.85)'; ctx.lineWidth = 4; ctx.setLineDash([14, 12]);
      roundRect(ctx, -70, -80, 140, 170, 16); ctx.stroke(); ctx.beginPath(); ctx.arc(95, 10, 40, -1.2, 1.2); ctx.stroke(); ctx.restore();
    }
    if (s && s.found && s.w > 0) {
      let fx = s.frameX != null ? s.frameX : (settings.mirror ? 1 - s.rawX : s.rawX), fy = s.frameY != null ? s.frameY : s.rawY;
      const ex = 3.4, ey = 3.6; // logo box -> whole mug plus the hand holding it
      let cw = Math.min(1, s.w * ex), chh = Math.min(1, s.h * ey);
      let cx = Math.min(1 - cw, Math.max(0, fx - cw / 2)), cy = Math.min(1 - chh, Math.max(0, fy - chh * 0.45));
      const sx = cx * vw, sy = cy * vh, sw = cw * vw, sh = chh * vh;
      let dx = (settings.mirror ? 1 - cx - cw : cx) * w, dy = cy * h, dw = cw * w, dh = chh * h;
      ctx.save(); roundRect(ctx, dx, dy, dw, dh, 18); ctx.clip();
      ctx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh); // not flipped: the logo should read the right way round
      ctx.restore();
      ctx.save(); roundRect(ctx, dx, dy, dw, dh, 18); ctx.lineWidth = 4; ctx.strokeStyle = '#27d35b'; ctx.shadowColor = 'rgba(39,211,91,.8)'; ctx.shadowBlur = 16; ctx.stroke();
      // corner brackets
      const L = Math.min(dw, dh) * 0.22; ctx.lineWidth = 8; ctx.lineCap = 'round'; ctx.beginPath();
      [[dx, dy, 1, 1], [dx + dw, dy, -1, 1], [dx, dy + dh, 1, -1], [dx + dw, dy + dh, -1, -1]].forEach(([x, y, sx2, sy2]) => { ctx.moveTo(x + sx2 * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy2 * L); });
      ctx.stroke(); ctx.restore();
    }
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  // ---------- PIP ----------
  let pipOn = false; const pipCv = $('pip-cv'), pipCtx = pipCv.getContext('2d');
  function setPip(on) { pipOn = on; document.body.classList.toggle('debug', on); }
  function drawPip(s) {
    drawPrivacy(pipCtx, pipCv.width, pipCv.height, s);
    $('pip-dot').classList.toggle('on', s.found); $('pip-txt').textContent = s.found ? 'Mug Detected' : 'Looking For Mug';
  }

  // ---------- camera picker (lives on the Show Your Mug screen) ----------
  async function fillCameraList(selectEl) {
    let cams = []; try { cams = await MugTracker.listCameras(); } catch (_) {}
    selectEl.innerHTML = cams.length ? cams.map((c, i) => `<option value="${c.deviceId}" ${c.deviceId === settings.deviceId ? 'selected' : ''}>${c.label || ('Camera ' + (i + 1))}</option>`).join('') : '<option value="">No camera found</option>';
    return cams;
  }
  $('cam-sel').addEventListener('change', async () => {
    settings.deviceId = $('cam-sel').value; save(LS.settings, settings); $('cam-err').textContent = '';
    try { tracker.stop(); await tracker.start({ deviceId: settings.deviceId || undefined }); calStable = 0; } catch (e) { $('cam-err').textContent = cameraError(e); }
  });
  function cameraError(e) { return e && e.code === 'denied' ? 'Camera permission is blocked. Allow the camera in Chrome and reload.' : e && e.code === 'in-use' ? 'That camera is in use by another app.' : 'Could not start that camera.'; }

  // ---------- calibration ----------
  const calCv = $('cal-cv'), calCtx = calCv.getContext('2d');
  let calStable = 0, calDone = false, calibrated = false, calTimer = null, calSpot = { x: 0.5, y: 0.5 };
  function calTick(s) {
    if (phase !== 'calibrating') return;
    drawPrivacy(calCtx, calCv.width, calCv.height, s);
    $('cal-dot').classList.toggle('on', s.found); $('cal-st').textContent = s.found ? 'Mug Detected' : 'Looking For Mug';
    $('cal-guide').classList.toggle('on', s.found);
    $('cal-pos').style.transform = `translateX(${(Math.min(1, Math.max(0, s.x)) - 0.5) * 300}px)`;
    // inside the centre box, steadily, for 1.5 s -> calibrate once, then go
    calStable = s.found && (s.confidence || 1) >= 0.5 ? Math.min(1, calStable + 1 / 60) : Math.max(0, calStable - 1 / 20); // ~2 s of steady detection
    if (s.found) calSpot = { x: s.x, y: s.y };
    $('cal-ring').style.setProperty('--p', Math.round(calStable * 100) + '%');
    if (calStable >= 1 && !calDone) { calDone = true; finishCalibration(); }
  }
  async function finishCalibration() {
    $('cal-msg').textContent = 'Hold still…';
    const roi = { x: Math.max(0, calSpot.x - 0.2), y: Math.max(0, calSpot.y - 0.3), w: 0.4, h: 0.6 };
    try { const r = await tracker.calibrate(roi); calibrated = !!(r && r.ok); } catch (_) { calibrated = false; }
    if (!calibrated || !trackState.found) {
      // Not a real lock (a red-and-white object passed by, or the mug moved away): stay on this screen.
      $('cal-msg').textContent = 'Hold the mug steady, logo facing the camera.'; calStable = 0; calDone = false; return;
    }
    KKAudio.detected();
    $('cal-msg').textContent = 'Locked on. Get ready!';
    setTimeout(startCountdown, 700);
  }
  function beginCalibration() {
    phase = 'calibrating'; calStable = 0; calDone = false; show('cal');
    clearTimeout(calTimer); $('cal-skip').style.display = 'none'; $('cal-msg').textContent = 'Stand about 3 feet from the screen and hold the mug up, logo facing the camera.';
  }
  $('cal-skip').addEventListener('click', () => { calDone = true; startCountdown(); }); // only shown when the camera itself failed

  // ---------- countdown ----------
  function startCountdown() {
    phase = 'countdown'; show('count');
    const el = $('count-num'), cd = el.parentElement, ticks = $('cd-ticks');
    if (!ticks.childElementCount) {
      let t = '';
      for (let i = 0; i < 72; i++) { const a = i / 72 * Math.PI * 2, long = i % 6 === 0; const r1 = 318, r2 = long ? 342 : 332; t += `<line x1="${350 + Math.cos(a) * r1}" y1="${350 + Math.sin(a) * r1}" x2="${350 + Math.cos(a) * r2}" y2="${350 + Math.sin(a) * r2}"/>`; }
      ticks.innerHTML = t;
    }
    const STEP = 1000; let n = 3, t0 = performance.now(), raf = 0;
    const setNum = txt => { el.querySelectorAll('span').forEach(sp => { sp.textContent = txt; }); el.classList.toggle('go', txt === 'GO!'); el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; };
    setNum('3'); KKAudio.tick();
    const frame = now => {
      const k = Math.min(1, (now - t0) / STEP);
      const remain = 1 - k;                                  // the ring empties clockwise over each second
      cd.style.setProperty('--sweep', (remain * 360).toFixed(2) + 'deg');
      if (k >= 1) {
        n--; t0 = now;
        if (n > 0) { setNum(String(n)); KKAudio.tick(); }
        else if (n === 0) { setNum('GO!'); KKAudio.go(); cd.style.setProperty('--sweep', '360deg'); }
        else { cancelAnimationFrame(raf); hideAll(); startPlay(); return; }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }

  // ---------- gold 3D number for the results screen (canvas, extruded down-left like the reference) ----------
  function drawGold3D(cv, text) {
    // If the designer supplies digit artwork (assets/img/game/digits/0.png … 9.png), it is used instead of this renderer.
    const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height; const ps = W / 800;
    ctx.setTransform(ps, 0, 0, ps, 0, 0); ctx.clearRect(0, 0, 800, 360);
    const size = 352, cx = 400, baseY = 300;
    ctx.font = `italic 900 ${size}px Montserrat, Poppins, Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const m = ctx.measureText(text); const top = baseY - m.actualBoundingBoxAscent, bot = baseY + m.actualBoundingBoxDescent, gh = bot - top;
    const depth = Math.round(gh * 0.11), dx = -0.48, dy = 1.0;
    // ground shadow
    ctx.save(); ctx.shadowColor = 'rgba(60,0,0,.55)'; ctx.shadowBlur = 36; ctx.shadowOffsetY = 26; ctx.shadowOffsetX = -8; ctx.fillStyle = 'rgba(120,50,0,1)'; ctx.fillText(text, cx + dx * depth, baseY + dy * depth); ctx.restore();
    // bright lip along the far edge of the extrusion
    for (let i = depth + 2; i > depth; i--) { ctx.fillStyle = i === depth + 2 ? '#d57702' : '#ffeabb'; ctx.fillText(text, cx + dx * i, baseY + dy * i); }
    // extrusion side: amber, lighter near the face
    for (let i = depth; i >= 1; i--) {
      const t = i / depth;
      const r = Math.round(0xe8 - (0xe8 - 0xb0) * t), g = Math.round(0x94 - (0x94 - 0x53) * t), b = Math.round(0x25 - (0x25 - 0x00) * t);
      ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillText(text, cx + dx * i, baseY + dy * i);
    }
    // face
    const g1 = ctx.createLinearGradient(0, top, 0, bot);
    g1.addColorStop(0, '#fff8f1'); g1.addColorStop(.1, '#fef4ce'); g1.addColorStop(.2, '#fdedb9'); g1.addColorStop(.3, '#fde7a5'); g1.addColorStop(.4, '#fddf91'); g1.addColorStop(.5, '#fdd87b'); g1.addColorStop(.6, '#fdd267'); g1.addColorStop(.72, '#fdca53'); g1.addColorStop(.86, '#fde567'); g1.addColorStop(1, '#ffe6b3');
    ctx.fillStyle = g1; ctx.fillText(text, cx, baseY);
    // soft highlight band on the upper third, darker warm band near the bottom of the face
    ctx.save(); ctx.globalCompositeOperation = 'source-atop';
    const g2 = ctx.createLinearGradient(0, top, 0, bot);
    g2.addColorStop(0, 'rgba(255,255,255,.18)'); g2.addColorStop(.2, 'rgba(255,255,255,0)'); g2.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g2; ctx.fillText(text, cx, baseY); ctx.restore();
    // hairline light edge on the face
    ctx.save(); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,248,220,.8)'; ctx.strokeText(text, cx, baseY); ctx.restore();
    // fine four-point sparkles
    ctx.save(); ctx.fillStyle = '#ffeec0'; ctx.shadowColor = 'rgba(255,225,150,.9)'; ctx.shadowBlur = 10;
    [[cx - m.width * .60, top + 28, 20, 1], [cx - m.width * .70, top + 150, 12, .9], [cx + m.width * .60, top + 54, 22, 1], [cx + m.width * .69, bot - 60, 14, .9], [cx - m.width * .64, bot - 34, 10, .8]].forEach(([sx, sy, r, a]) => {
      ctx.globalAlpha = a; const w = r * .18; ctx.beginPath(); ctx.moveTo(sx, sy - r); ctx.quadraticCurveTo(sx + w, sy - w, sx + r, sy); ctx.quadraticCurveTo(sx + w, sy + w, sx, sy + r); ctx.quadraticCurveTo(sx - w, sy + w, sx - r, sy); ctx.quadraticCurveTo(sx - w, sy - w, sx, sy - r); ctx.fill();
    });
    ctx.restore();
  }
  function setScoreNumber(v) { const cv = $('end-score-cv'); if (cv) drawGold3D(cv, String(v)); $('end-score').textContent = String(v); }

  // ---------- game ----------
  let game = null, sprites = null, phase = 'boot', endResult = null, endAmbient = null;
  // Render scale: 1x for the 1080x1920 design, up to 2x on the 4K kiosk (2160x3840) so sprites stay crisp.
  let pixelScale = (window.KKStage && window.KKStage.pixelScale) || 1;
  if (qs.get('px')) pixelScale = Math.min(2, Math.max(0.5, parseFloat(qs.get('px')) || 1));
  const gameCanvas = $('game');
  gameCanvas.width = Math.round(1080 * pixelScale); gameCanvas.height = Math.round(1920 * pixelScale);
  async function loadSprites() {
    const manifest = await fetch('assets/img/game/manifest.json').then(r => r.json()).catch(() => null);
    sprites = await DunkSprites.load(manifest || {}, { scale: pixelScale });
  }
  function startPlay() {
    if (game) { game.destroy(); game = null; }
    hud.el.classList.remove('final5');
    game = DunkGame.create({
      canvas: gameCanvas, sprites, duration: DURATION,
      onTick: st => {
        setText('time', fmtTime(st.timeLeft));
        setText('score', String(st.score).padStart(2, '0'));
        setText('rank', '#' + liveRank(st.score));
      },
      onEvent: onGameEvent,
      onEnd: onGameEnd
    });
    phase = 'playing';
    game.setTargetX(trackState.x); game.setTracking(true);
    game.start();
    armIdle(false);
  }
  function onGameEvent(e) {
    switch (e.type) {
      case 'catch': KKAudio.catch(); break;
      case 'streak': KKAudio.streak(); break;
      case 'hit': KKAudio.hit(); break;
      case 'miss': KKAudio.miss(); break;
      case 'final5': hud.el.classList.add('final5'); break;
      case 'lost': show('lost'); break;
      case 'regained': hideAll(); break;
    }
  }
  function onGameEnd(result) {
    phase = 'ended'; endResult = result; KKAudio.end();
    const rank = recordScore(result);
    $('end-name').textContent = firstName ? `${firstName}, what a break!` : 'What a break!';
    setScoreNumber(0);
    $('end-rank').textContent = '#' + rank; $('end-caught').textContent = String(result.caught); $('end-streak').textContent = String(result.bestStreak);
    $('end-title').textContent = result.score >= settings.teeMin ? 'Legend!' : result.score >= settings.capMin ? 'Hot Break!' : "Time's Up!";
    const pz = awardPrize(result); const pEl = $('prize');
    pEl.classList.toggle('none', !pz.kind); if (pz.kind) $('prize-pic').src = pz.kind === 'tee' ? 'assets/img/game/prize-tee.png' : 'assets/img/game/prize-cap.png';
    if (pz.kind) { $('prize-name').textContent = pz.kind === 'tee' ? 'You won a KitKat T-shirt!' : 'You won a KitKat Cap!'; $('prize-msg').textContent = 'Show this code at the counter to collect your prize.'; $('prize-code').textContent = pz.code; $('prize-code').style.display = ''; }
    else { $('prize-name').textContent = pz.soldOut ? "Today's prizes are all gone" : 'So close!'; $('prize-msg').textContent = pz.soldOut ? 'Great score. Come back tomorrow for another break.' : `Score ${settings.capMin} for a cap, ${settings.teeMin} for a T-shirt.`; $('prize-code').style.display = 'none'; }
    setTimeout(() => {
      show('end');
      countUp($('end-score'), result.score, 1400);
      if (endAmbient) endAmbient.stop();
      endAmbient = KKAmbient.create({ stage: ov.end, zIndex: 0, sparkles: 14, sparkleArea: { x0: 120, x1: 960, y0: 470, y1: 800 } });
    }, 900);
    armIdle(true);
  }
  $('again').addEventListener('click', () => { hideAll(); if (endAmbient) { endAmbient.stop(); endAmbient = null; } calDone = false; startCountdown(); });
  $('to-home').addEventListener('click', () => { location.href = 'index.html'; });

  // ---------- idle: back to cover after results ----------
  let idleT = null;
  function armIdle(on) { clearTimeout(idleT); if (on) idleT = setTimeout(() => { location.href = 'index.html'; }, 60000); }

  // ---------- setup panel ----------
  const su = { el: $('setup'), cam: $('su-cam'), mirror: $('su-mirror'), sens: $('su-sens'), smooth: $('su-smooth'), pip: $('su-pip'), sound: $('su-sound'), cv: $('su-cv'), stat: $('su-stat') };
  let setupOpen = false, suRaf = 0;
  async function openSetup() {
    setupOpen = true; su.el.classList.add('show');
    if (game && phase === 'playing') game.pause();
    refreshStock();
    su.mirror.checked = settings.mirror; su.sens.value = Math.round(settings.sensitivity * 100); su.smooth.value = Math.round(settings.smoothing * 100); su.pip.checked = settings.pip; su.sound.checked = settings.sound;
    try {
      const cams = await MugTracker.listCameras();
      su.cam.innerHTML = cams.map(c => `<option value="${c.deviceId}" ${c.deviceId === settings.deviceId ? 'selected' : ''}>${c.label || 'Camera'}</option>`).join('') || '<option value="">Default camera</option>';
    } catch (_) {}
    const ctx = su.cv.getContext('2d');
    const loop = () => { if (!setupOpen) return; if (tracker) { tracker.debugDraw(ctx, su.cv.width, su.cv.height); const s = trackState; su.stat.textContent = `found=${s.found}  x=${(s.x || 0).toFixed(3)}  conf=${(s.confidence || 0).toFixed(2)}  fps=${Math.round(s.fps || 0)}  calibrated=${calibrated}\nstage=${(window.KKStage||{}).mode} scale=${((window.KKStage||{}).scale||0).toFixed(2)} dpr=${(window.KKStage||{}).dpr} canvas=${gameCanvas.width}x${gameCanvas.height} screen=${screen.width}x${screen.height}`; } suRaf = requestAnimationFrame(loop); };
    loop();
  }
  function closeSetup() { setupOpen = false; su.el.classList.remove('show'); cancelAnimationFrame(suRaf); if (game && phase === 'playing') game.resume(); }
  $('su-close').addEventListener('click', closeSetup);
  su.mirror.addEventListener('change', () => { settings.mirror = su.mirror.checked; tracker && tracker.setOptions({ mirror: settings.mirror }); save(LS.settings, settings); });
  su.sens.addEventListener('input', () => { settings.sensitivity = su.sens.value / 100; tracker && tracker.setOptions({ sensitivity: settings.sensitivity }); save(LS.settings, settings); });
  su.smooth.addEventListener('input', () => { settings.smoothing = su.smooth.value / 100; tracker && tracker.setOptions({ smoothing: settings.smoothing }); save(LS.settings, settings); });
  su.pip.addEventListener('change', () => { settings.pip = su.pip.checked; setPip(settings.pip); save(LS.settings, settings); });
  su.sound.addEventListener('change', () => { settings.sound = su.sound.checked; KKAudio.setMuted(!settings.sound); save(LS.settings, settings); });
  su.cam.addEventListener('change', async () => { settings.deviceId = su.cam.value; save(LS.settings, settings); try { tracker.stop(); await tracker.start({ deviceId: settings.deviceId || undefined }); toast('Camera switched'); } catch (e) { toast('Could not switch camera'); } });
  $('su-cal').addEventListener('click', async () => { try { const r = await tracker.calibrate({ x: 0.33, y: 0.2, w: 0.34, h: 0.6 }); calibrated = !!(r && r.ok); toast(calibrated ? 'Calibrated on the mug' : 'No mug seen in the box'); } catch (_) { toast('Calibration failed'); } });
  $('su-reset').addEventListener('click', () => { try { localStorage.removeItem('kk_tracker_params'); } catch (_) {} calibrated = false; toast('Calibration reset'); });
  $('su-clear').addEventListener('click', () => { save(LS.board, { rows: [] }); toast('Leaderboard cleared'); });
  function refreshStock() { const st = stock(); $('su-stock').textContent = `Caps left: ${st.cap} / ${DAILY_STOCK}    T-shirts left: ${st.tee} / ${DAILY_STOCK}    awarded today: ${st.awarded.length}`; $('su-cap-min').value = settings.capMin; $('su-tee-min').value = settings.teeMin; }
  $('su-cap-min').addEventListener('change', () => { settings.capMin = Math.max(1, +$('su-cap-min').value || 12); save(LS.settings, settings); });
  $('su-tee-min').addEventListener('change', () => { settings.teeMin = Math.max(1, +$('su-tee-min').value || 25); save(LS.settings, settings); });
  $('su-stock-reset').addEventListener('click', () => { save(LS.stock, { day: todayKey(), cap: DAILY_STOCK, tee: DAILY_STOCK, awarded: [] }); refreshStock(); toast('Stock reset'); });
  $('su-export').addEventListener('click', () => {
    const st = stock(); const rows = board();
    const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    let csv = 'type,time,name,mobile,score,prize,code\n';
    rows.forEach(r => { csv += ['score', new Date(r.ts).toISOString(), r.name, '', r.score, '', ''].map(esc).join(',') + '\n'; });
    st.awarded.forEach(a => { csv += ['prize', new Date(a.ts).toISOString(), a.name, a.mobile, a.score, a.kind, a.code].map(esc).join(',') + '\n'; });
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); const a = document.createElement('a'); a.href = url; a.download = `kitkat-${todayKey()}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
  // Capture 12 camera frames (2 s apart) into one PNG sheet for detector tuning on the real mug.
  $('su-capture').addEventListener('click', async () => {
    if (!tracker) return; toast('Capturing 12 frames, keep moving the mug…', 24000);
    const sheet = document.createElement('canvas'); sheet.width = 4 * 640; sheet.height = 3 * 360; const sc = sheet.getContext('2d');
    for (let i = 0; i < 12; i++) { await new Promise(r => setTimeout(r, 2000)); sc.drawImage(video, (i % 4) * 640, Math.floor(i / 4) * 360, 640, 360); }
    const a = document.createElement('a'); a.href = sheet.toDataURL('image/png'); a.download = `mug-samples-${Date.now()}.png`; a.click(); toast('Saved mug-samples PNG to Downloads. Send it over for tuning.', 5000);
  });
  // open: key "c", or 5 taps on the logo within 3 s
  document.addEventListener('keydown', e => { if (e.key === 'c' || e.key === 'C') setupOpen ? closeSetup() : openSetup(); if (e.key === 'Escape') closeSetup(); });
  let taps = [], logo = $('logo'); logo.style.pointerEvents = 'auto';
  logo.addEventListener('pointerdown', () => { const t = performance.now(); taps = taps.filter(x => t - x < 3000); taps.push(t); if (taps.length >= 5) { taps = []; openSetup(); } });

  // ---------- boot ----------
  async function boot() {
    KKAudio.setMuted(!settings.sound); setPip(settings.pip || qs.get('debug') === '1');
    document.addEventListener('visibilitychange', () => { if (!game) return; document.hidden ? game.pause() : (phase === 'playing' && game.resume()); });
    await loadSprites();
    beginCalibration();
    try { await startTracker(); await fillCameraList($('cam-sel')); }
    catch (e) {
      const msg = e && e.code === 'denied' ? 'Camera permission is blocked. Allow the camera in Chrome and reload.' : e && e.code === 'in-use' ? 'The camera is in use by another app.' : 'No camera found. Connect the webcam and reload.';
      $('cam-err').textContent = msg; $('cal-skip').style.display = 'inline-block'; try { await fillCameraList($('cam-sel')); } catch (_) {}
    }
  }
  window.__kk = { get phase() { return phase; }, get track() { return trackState; }, get game() { return game; }, get result() { return endResult; }, show, settings, awardPrize, stock, setScore: setScoreNumber };
  boot();
})();
