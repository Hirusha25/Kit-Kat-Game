// Game page flow: boot -> calibrate -> countdown -> playing (lost/regained) -> ended -> results -> idle -> cover.
// Owns the HUD, overlays, setup panel, leaderboard and the glue between MugTracker and DunkGame.
(function () {
  const $ = id => document.getElementById(id);
  const stageW = 1080;
  const qs = new URLSearchParams(location.search);
  const DURATION = Math.max(5, Math.min(120, parseInt(qs.get('duration') || '45', 10) || 45));
  const LS = { settings: 'kk_settings', board: 'kk_leaderboard', players: 'kk_players' };

  // ---------- settings ----------
  const settings = Object.assign({ mirror: true, sensitivity: 0.5, smoothing: 0.35, pip: false, sound: true, deviceId: '' }, load(LS.settings));
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

  // ---------- overlays & toast ----------
  const ov = { cal: $('ov-cal'), count: $('ov-count'), lost: $('ov-lost'), end: $('ov-end') };
  function show(name) { Object.keys(ov).forEach(k => ov[k].classList.toggle('show', k === name)); }
  function hideAll() { show(null); }
  let toastT; function toast(msg, ms = 2200) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }

  // ---------- HUD ----------
  const hud = { time: $('hud-time'), score: $('hud-score'), rank: $('hud-rank'), el: $('hud') };
  const last = { time: '', score: '', rank: '' };
  function setText(key, v) { if (last[key] !== v) { last[key] = v; hud[key].textContent = v; } }
  function fmtTime(s) { s = Math.max(0, Math.ceil(s)); return '00:' + String(s).padStart(2, '0'); }
  const knob = $('knob');
  const sliderLeft = 70, sliderWidth = 820 - 140; // slider inner track in stage px

  // ---------- tracker ----------
  const video = $('cam');
  let tracker = null, trackState = { found: false, x: 0.5 };
  let lastFoundAt = 0;
  async function startTracker() {
    tracker = MugTracker.create({ video, width: 160, height: 90, mirror: settings.mirror, smoothing: settings.smoothing, useWorker: true });
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

  // ---------- PIP ----------
  let pipOn = false; const pipCv = $('pip-cv'), pipCtx = pipCv.getContext('2d');
  function setPip(on) { pipOn = on; document.body.classList.toggle('debug', on); }
  function drawPip(s) {
    tracker.debugDraw(pipCtx, pipCv.width, pipCv.height);
    $('pip-dot').classList.toggle('on', s.found); $('pip-txt').textContent = s.found ? 'Mug detected' : 'Looking for mug';
  }

  // ---------- calibration ----------
  const calCv = $('cal-cv'), calCtx = calCv.getContext('2d');
  let calStable = 0, calDone = false, calibrated = false, calTimer = null, calSpot = { x: 0.5, y: 0.5 };
  function calTick(s) {
    tracker.debugDraw(calCtx, calCv.width, calCv.height);
    $('cal-dot').classList.toggle('on', s.found); $('cal-st').textContent = s.found ? 'Mug detected' : 'Looking for mug';
    $('cal-guide').classList.toggle('on', s.found);
    $('cal-pos').style.transform = `translateX(${(Math.min(1, Math.max(0, s.x)) - 0.5) * 300}px)`;
    // inside the centre box, steadily, for 1.5 s -> calibrate once, then go
    calStable = s.found ? Math.min(1, calStable + 1 / 40) : Math.max(0, calStable - 1 / 30);
    if (s.found) calSpot = { x: s.x, y: s.y };
    $('cal-ring').style.setProperty('--p', Math.round(calStable * 100) + '%');
    if (calStable >= 1 && !calDone) { calDone = true; finishCalibration(); }
  }
  async function finishCalibration() {
    $('cal-msg').textContent = 'Hold still…';
    const roi = { x: Math.max(0, calSpot.x - 0.2), y: Math.max(0, calSpot.y - 0.3), w: 0.4, h: 0.6 };
    try { const r = await tracker.calibrate(roi); calibrated = !!(r && r.ok); } catch (_) {}
    KKAudio.detected();
    $('cal-msg').textContent = calibrated ? 'Locked on. Get ready!' : 'Ready!';
    setTimeout(startCountdown, 700);
  }
  function beginCalibration() {
    phase = 'calibrating'; calStable = 0; calDone = false; show('cal');
    clearTimeout(calTimer); calTimer = setTimeout(() => { $('cal-skip').style.display = 'block'; }, 12000);
  }
  $('cal-skip').addEventListener('click', () => { calDone = true; startCountdown(); });

  // ---------- countdown ----------
  function startCountdown() {
    phase = 'countdown'; show('count');
    const el = $('count-num'); let n = 3;
    const step = () => {
      if (n === 0) { el.textContent = 'GO!'; el.style.fontSize = '300px'; KKAudio.go(); setTimeout(() => { hideAll(); startPlay(); }, 600); return; }
      el.style.fontSize = ''; el.textContent = String(n); el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; KKAudio.tick(); n--; setTimeout(step, 900);
    };
    step();
  }

  // ---------- game ----------
  let game = null, sprites = null, phase = 'boot', endResult = null;
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
    $('end-score').textContent = String(result.score);
    $('end-rank').textContent = '#' + rank; $('end-caught').textContent = String(result.caught); $('end-streak').textContent = String(result.bestStreak);
    $('end-title').textContent = result.score >= 20 ? 'Legend!' : result.score >= 10 ? 'Hot break!' : "Time's up!";
    setTimeout(() => show('end'), 900);
    armIdle(true);
  }
  $('again').addEventListener('click', () => { hideAll(); calDone = false; startCountdown(); });
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
    try { await startTracker(); }
    catch (e) {
      const msg = e && e.code === 'denied' ? 'Camera permission is blocked. Allow the camera in Chrome and reload.' : e && e.code === 'in-use' ? 'The camera is in use by another app.' : 'No camera found. Connect the webcam and reload.';
      $('cal-msg').textContent = msg; $('cal-skip').style.display = 'block';
    }
  }
  window.__kk = { get phase() { return phase; }, get track() { return trackState; }, get game() { return game; }, get result() { return endResult; } };
  boot();
})();
