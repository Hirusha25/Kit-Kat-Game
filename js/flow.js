// Game page flow: boot -> calibrate -> countdown -> playing (lost/regained) -> ended -> results -> idle -> cover.
// Owns the HUD, overlays, setup panel, leaderboard and the glue between MugTracker and DunkGame.
(function () {
  const $ = id => document.getElementById(id);
  const stageW = 1080;
  const qs = new URLSearchParams(location.search);
  const DURATION = Math.max(5, Math.min(120, parseInt(qs.get('duration') || '40', 10) || 40));
  const LS = { settings: 'kk_settings', board: 'kk_leaderboard', players: 'kk_players' };

  // ---------- settings ----------
  const settings = Object.assign({ mirror: true, sensitivity: 0.42, smoothing: 0.35, pip: false, tile: true, range: 0.7, rotate: 'auto', staticRed: false, detail: 'high', sound: true, deviceId: '', capMin: 12, teeMin: 25, cameraConfirmed: false,
    // rewards: 'nth' = every Nth round wins (cap, or the T-shirt when the score reaches teeMin); 'score' = by score thresholds
    rewardMode: 'nth', everyNth: 5, pacing: true, openHour: 10, closeHour: 20,
    pipStyle: 'c', // in-game camera preview: a|b|c|d top placements, '' = bottom-middle box
    stockDays: {} }, load(LS.settings)); // stockDays: {"YYYY-MM-DD": {cap, tee}} from the dashboard; a day without an entry uses DAILY_STOCK
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

  // ---------- plays per phone number: one chance; a second try only after a loss ----------
  LS.plays = 'kk_plays';
  function playsFor(mobile) { const all = load(LS.plays); const rec = all[mobile]; return rec && rec.day === todayKey() ? rec : { day: todayKey(), plays: 0, won: false }; }
  function recordPlay(mobile, won) { if (!mobile) return; const all = load(LS.plays); const rec = playsFor(mobile); rec.plays += 1; rec.won = rec.won || won; all[mobile] = rec; save(LS.plays, all); return rec; }
  let retryUsed = false;

  // ---------- rewards: cap and T-shirt, 80 each per day ----------
  // Today's quota per prize, as set on the dashboard for this date (falls back to DAILY_STOCK). What is left is
  // derived from the awarded list, so a quota changed during the day takes effect at once.
  function quota(kind) { const d = settings.stockDays && settings.stockDays[todayKey()]; const v = d && d[kind]; return typeof v === 'number' && v >= 0 ? v : DAILY_STOCK; }
  function stock() {
    const st = load(LS.stock); const rec = st.day === todayKey() ? st : { day: todayKey(), awarded: [] };
    rec.awarded = rec.awarded || [];
    rec.cap = Math.max(0, quota('cap') - rec.awarded.filter(a => a.kind === 'cap').length);
    rec.tee = Math.max(0, quota('tee') - rec.awarded.filter(a => a.kind === 'tee').length);
    return rec;
  }
  // Rounds played today (one per finished round, retries included). Every Nth round is a winner.
  LS.turns = 'kk_turns';
  function turns() { const t = load(LS.turns); return t.day === todayKey() ? t : { day: todayKey(), n: 0 }; }
  function nextTurn() { const t = turns(); t.n += 1; save(LS.turns, t); return t.n; }
  // Pacing: prizes are released evenly across the activation hours, so a busy morning cannot empty the
  // shelf by lunch and a quiet morning's share carries forward within the day. released(kind) = how many
  // of today's stock may have been given out by now; what is not yet released is held back.
  function released(kind) {
    const total = quota(kind);
    if (!settings.pacing) return total;
    const now = new Date(), h = now.getHours() + now.getMinutes() / 60;
    const span = Math.max(1, settings.closeHour - settings.openHour);
    const frac = Math.min(1, Math.max(0.06, (h - settings.openHour) / span)); // a few are available before opening and for testing
    return Math.min(total, Math.ceil(total * frac));
  }
  function available(kind) { const st = stock(); return Math.max(0, Math.min(st[kind], released(kind) - (quota(kind) - st[kind]))); }
  function prizeCode(kind) { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const r = new Uint32Array(4); crypto.getRandomValues(r); return (kind === 'tee' ? 'TEE-' : 'CAP-') + Array.from(r, n => a[n % a.length]).join(''); }
  function awardPrize(result) {
    const st = stock(); let kind = null, soldOut = false, turn = nextTurn();
    if (settings.rewardMode === 'nth') {
      const N = Math.max(1, settings.everyNth | 0), winner = turn % N === 0;
      if (!winner) return { kind: null, soldOut: false, turn, nextIn: N - (turn % N) };
      const want = result.score >= settings.teeMin ? 'tee' : 'cap', other = want === 'tee' ? 'cap' : 'tee';
      if (available(want) > 0) kind = want; else if (available(other) > 0) kind = other;
      soldOut = !kind; // a winner's turn, but nothing released right now: pacing holds the shelf, or the day's stock is gone
    } else {
      if (result.score >= settings.teeMin && st.tee > 0) kind = 'tee';
      else if (result.score >= settings.capMin && st.cap > 0) kind = 'cap';
      else if (result.score >= settings.teeMin && st.cap > 0) kind = 'cap'; // tees gone, fall back to a cap
      soldOut = !kind && result.score >= settings.capMin;
    }
    if (!kind) return { kind: null, soldOut, turn };
    st[kind] -= 1; const code = prizeCode(kind);
    st.awarded.push({ kind, code, name: firstName || 'Guest', mobile: player && player.mobile, score: result.score, ts: Date.now(), turn, mode: settings.rewardMode });
    save(LS.stock, st);
    return { kind, code, left: st[kind], turn };
  }
  const prizeIcons = {
    cap: '<svg viewBox="0 0 24 24"><path d="M4 14c0-4.4 3.6-8 8-8s8 3.6 8 8v1H4v-1z"/><path d="M4 15h12c2.5 0 4.5 1 6 2.5"/><path d="M12 6V4"/></svg>',
    tee: '<svg viewBox="0 0 24 24"><path d="M8 4l4 2 4-2 5 3-2 4-3-1v10H8V10l-3 1-2-4 5-3z"/></svg>',
    none: '<svg viewBox="0 0 24 24"><path d="M5 8h14v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8z"/><path d="M19 10h2a2 2 0 0 1 0 4h-2M9 3c0 2 2 2 2 4M13 3c0 2 2 2 2 4"/></svg>'
  };

  // ---------- overlays & toast ----------
  const ov = { cal: $('ov-cal'), how: $('ov-how'), count: $('ov-count'), lost: $('ov-lost'), end: $('ov-end') };
  function show(name) { Object.keys(ov).forEach(k => ov[k].classList.toggle('show', k === name)); document.body.classList.toggle('pre', name === 'cal' || name === 'how' || name === 'end'); document.body.classList.toggle('how', name === 'how'); }
  function hideAll() { show(null); }
  let toastT; function toast(msg, ms = 2200) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }

  // ---------- HUD ----------
  const hud = { time: $('hud-time'), score: $('hud-score'), rank: $('hud-rank'), el: $('hud') };
  const last = { time: '', score: '', rank: '' };
  // Score display: climbs one digit at a time toward the real score (so a +3 visibly rises), and when a hazard
  // takes a point it steps down in red with a shake. A floating +N / -N chip marks each change.
  let scoreShown = 0, scoreTarget = 0, scoreNextAt = 0;
  function resetScore() { scoreShown = scoreTarget = 0; scoreNextAt = 0; hud.score.textContent = '00'; hud.score.classList.remove('down'); }
  function scoreChip(delta) {
    const el = document.createElement('span'); el.className = 'delta' + (delta < 0 ? ' neg' : ''); el.textContent = (delta > 0 ? '+' : '') + delta;
    hud.score.parentElement.appendChild(el); el.addEventListener('animationend', () => el.remove(), { once: true });
  }
  function tickScore(target) {
    if (target !== scoreTarget) { scoreChip(target - scoreTarget); scoreTarget = target; }
    if (scoreShown === scoreTarget) return;
    const now = performance.now(); if (now < scoreNextAt) return;
    scoreNextAt = now + 70;
    const dir = scoreTarget > scoreShown ? 1 : -1; scoreShown += dir;
    hud.score.textContent = String(scoreShown).padStart(2, '0'); last.score = hud.score.textContent;
    hud.score.classList.remove('bump', 'down'); void hud.score.offsetWidth; hud.score.classList.add(dir > 0 ? 'bump' : 'down');
  }
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
    // Detector frame: 320x180 ('high', the mug is only a few pixels at 160x90 from where players stand) or 160x90.
    // rotate 'auto' turns a portrait camera picture upright on the kiosk (never on a phone, which holds its camera upright).
    const hi = settings.detail !== 'normal', phone = document.documentElement.classList.contains('is-phone');
    tracker = MugTracker.create({ video, width: hi ? 320 : 160, height: hi ? 180 : 90, rotate: settings.rotate === 'auto' || settings.rotate == null ? (phone ? 0 : 'auto') : +settings.rotate, staticMs: settings.staticRed === true ? 2500 : 0, mirror: settings.mirror, smoothing: settings.smoothing, useWorker: true, workerUrl: 'js/tracker-worker.js?v=20261127i' });
    tracker.setOptions({ sensitivity: settings.sensitivity });
    tracker.onUpdate = onTrack;
    await tracker.start({ deviceId: settings.deviceId || undefined, facingMode: 'user' });
    if (tracker.setAcquire) tracker.setAcquire(phase === 'calibrating');   // show-your-mug screen: opened-up colour masks, see tracker.js acquireParams
  }
  // ---------- play range and tracking cues ----------
  // Only the middle part of the camera's view is used for control (settings.range, default 70%), so the cup
  // reaches both ends of its track well before the mug reaches the edge of the picture and gets lost.
  function playX(x) { const r = Math.min(1, Math.max(0.5, +settings.range || 0.7)), m = (1 - r) / 2; return Math.min(1, Math.max(0, ((+x || 0) - m) / r)); }
  // Tracking state shown to the player: 'ok' (green), 'weak' (amber: not seen in the last few frames, the
  // game is coasting on the last position) and 'lost' (red). Shown on the camera tile, the cup glow and the knob.
  const cueEls = [$('pip'), $('cup-glow'), $('knob')], edgeEls = { l: $('edge-l'), r: $('edge-r'), t: $('edge-t'), b: $('edge-b') };
  const EDGE = 0.10;   // closer than this (share of the camera view) to an edge = warn
  let cueState = '', cueEdges = '', lastRaw = { x: 0.5, y: 0.5 };
  function trackCue(s) {
    const weak = s.found && (s.ts - s.lastSeenMs) > 90;
    const st = !s.found ? 'lost' : weak ? 'weak' : 'ok';
    if (s.found && !weak) lastRaw = { x: s.rawX, y: s.rawY };   // screen (mirrored) position of the last real sighting
    if (st !== cueState) {
      cueState = st;
      cueEls.forEach(el => { if (el) { el.classList.toggle('weak', st === 'weak'); el.classList.toggle('lost', st === 'lost'); } });
      $('pip-dot').classList.toggle('on', st === 'ok'); $('pip-txt').textContent = st === 'ok' ? 'Mug Tracked' : st === 'weak' ? 'Hold It Steady' : 'Mug Lost';
    }
    // edge arrows during a round: near an edge, and still showing the way back once the mug has gone off that side
    const on = phase === 'playing';
    const e = (on && lastRaw.x < EDGE ? 'l' : '') + (on && lastRaw.x > 1 - EDGE ? 'r' : '') + (on && lastRaw.y < EDGE ? 't' : '') + (on && lastRaw.y > 1 - EDGE ? 'b' : '');
    if (e !== cueEdges) { cueEdges = e; Object.keys(edgeEls).forEach(k => edgeEls[k] && edgeEls[k].classList.toggle('on', e.indexOf(k) >= 0)); }
  }
  // Why the mug was lost, from where it was last seen: near an edge = it left the picture on that side;
  // in the middle = the logo is hidden or turned away (the mug has its logo on one face only).
  function lostReason() {
    const M = 0.16, x = lastRaw.x, y = lastRaw.y;
    if (x < M) return { title: 'Bring It Back', msg: 'The mug went off the side. Move it back this way.', arrow: '»' };
    if (x > 1 - M) return { title: 'Bring It Back', msg: 'The mug went off the side. Move it back this way.', arrow: '«' };
    if (y < M) return { title: 'Lower The Mug', msg: 'The mug went above the camera view. Bring it down a little.', arrow: '' };
    if (y > 1 - M) return { title: 'Raise The Mug', msg: 'The mug dropped below the camera view. Lift it up a little.', arrow: '' };
    return { title: 'Show The Logo', msg: 'Turn the red KitKat logo to the camera and keep your fingers off it.', arrow: '' };
  }
  function showLost() { const r = lostReason(); $('lost-title').textContent = r.title; $('lost-msg').textContent = r.msg; $('lost-arrow').textContent = r.arrow; show('lost'); }
  function onTrack(s) {
    trackState = s;
    if (s.found) lastFoundAt = performance.now();
    const gx = playX(s.x);
    if (game && phase === 'playing') { game.setTargetX(gx); game.setTracking(s.found); }
    trackCue(s);
    // knob follows the tracker directly so it feels alive even when paused
    const px = sliderLeft + gx * sliderWidth;
    knob.style.transform = `translateX(${px - 410}px)`; // knob is centred at 50% of the 820px slider by default
    if (pipOn) drawPip(s);
    if (phase === 'calibrating') calTick(s);
  }

  // ---------- privacy camera view: blurred silhouette + sharp mug crop only ----------
  const tiny = document.createElement('canvas'); tiny.width = 48; tiny.height = 27; const tctx = tiny.getContext('2d');
  function drawPrivacy(ctx, w, h, s) {
    // Clear, mirrored camera feed with a spotlight on the mug once it is found.
    if (!video.videoWidth) { ctx.fillStyle = '#2a0206'; ctx.fillRect(0, 0, w, h); return; }
    ctx.save(); if (settings.mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); } (tracker && tracker.drawUpright ? tracker.drawUpright(ctx, 0, 0, w, h) : ctx.drawImage(video, 0, 0, w, h)); ctx.restore();
    const found = s && s.found && s.w > 0;
    if (!found) {
      // soft hint: dashed mug outline in the centre
      ctx.save(); ctx.translate(w / 2, h / 2); ctx.strokeStyle = 'rgba(255,236,190,.9)'; ctx.lineWidth = 4; ctx.setLineDash([14, 12]);
      roundRect(ctx, -70, -80, 140, 170, 16); ctx.stroke(); ctx.beginPath(); ctx.arc(95, 10, 40, -1.2, 1.2); ctx.stroke(); ctx.restore();
      return;
    }
    // mug box in canvas space (mirrored to match the drawn feed)
    const fx = s.frameX != null ? s.frameX : s.rawX, fy = s.frameY != null ? s.frameY : s.rawY;
    const ex = 3.2, ey = 3.6; const bw = Math.min(w, s.w * ex * w), bh = Math.min(h, s.h * ey * h);
    const cxm = settings.mirror ? (1 - fx) * w : fx * w, cym = fy * h;
    const bx = Math.min(w - bw, Math.max(0, cxm - bw / 2)), by = Math.min(h - bh, Math.max(0, cym - bh * 0.45));
    const t = performance.now() / 1000;
    // spotlight: gentle dim outside a soft ellipse around the mug
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.ellipse(bx + bw / 2, by + bh / 2, bw * 0.72, bh * 0.72, 0, 0, Math.PI * 2, true); ctx.fillStyle = 'rgba(40,0,6,.38)'; ctx.fill('evenodd'); ctx.restore();
    // warm glow ring that breathes
    ctx.save(); const r = Math.max(bw, bh) * (0.56 + 0.02 * Math.sin(t * 3)); const g = ctx.createRadialGradient(bx + bw / 2, by + bh / 2, r * 0.82, bx + bw / 2, by + bh / 2, r);
    g.addColorStop(0, 'rgba(255,200,90,0)'); g.addColorStop(.6, 'rgba(255,200,90,.35)'); g.addColorStop(1, 'rgba(255,200,90,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(bx + bw / 2, by + bh / 2, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    // frame + corner brackets
    ctx.save(); roundRect(ctx, bx, by, bw, bh, 18); ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(39,211,91,.9)'; ctx.shadowColor = 'rgba(39,211,91,.8)'; ctx.shadowBlur = 16; ctx.stroke();
    const L = Math.min(bw, bh) * 0.22; ctx.lineWidth = 8; ctx.lineCap = 'round'; ctx.beginPath();
    [[bx, by, 1, 1], [bx + bw, by, -1, 1], [bx, by + bh, 1, -1], [bx + bw, by + bh, -1, -1]].forEach(([x, y, sx2, sy2]) => { ctx.moveTo(x + sx2 * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy2 * L); });
    ctx.stroke(); ctx.restore();
    // small tag above the box
    ctx.save(); ctx.font = '800 italic 20px Figtree, Arial'; const label = 'MUG'; const tw = ctx.measureText(label).width + 28; const tx = bx + bw / 2 - tw / 2, ty = Math.max(6, by - 36);
    roundRect(ctx, tx, ty, tw, 30, 15); ctx.fillStyle = '#27d35b'; ctx.fill(); ctx.fillStyle = '#062'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillText(label, tx + tw / 2, ty + 16); ctx.restore();
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  // ---------- PIP ----------
  let pipOn = false; const pipCv = $('pip-cv'), pipCtx = pipCv.getContext('2d');
  function setPip(on) { pipOn = on; document.body.classList.toggle('tile', on); }
  function applyPipStyle(ps) { ['a', 'b', 'c', 'd'].forEach(k => document.body.classList.remove('pip-' + k)); if (/^[abcd]$/.test(ps)) document.body.classList.add('pip-' + ps); }
  // Camera tile: the whole picture is drawn from a 48x27 copy (so people are a soft blur) and dimmed;
  // only the mug's own area is drawn sharp, with a box in the state colour. About 15 times a second.
  let tileAt = 0;
  function drawPip(s) {
    const now = performance.now(); if (now - tileAt < 66 || phase !== 'playing') return; tileAt = now;
    const c = pipCtx, w = pipCv.width, h = pipCv.height, vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) { c.fillStyle = '#2a0206'; c.fillRect(0, 0, w, h); return; }
    // (an older tracker.js without drawUpright can be served from the offline cache on a slow link: fall back to the raw picture)
    const up = !!tracker.drawUpright;
    if (up) tracker.drawUpright(tctx, 0, 0, tiny.width, tiny.height); else tctx.drawImage(video, 0, 0, tiny.width, tiny.height);
    const seen = s.found && s.w > 0 && cueState !== 'lost';
    const fx = s.frameX != null ? s.frameX : 0.5, fy = s.frameY != null ? s.frameY : 0.5;
    const bw = Math.min(1, s.w * 3.4), bh = Math.min(1, s.h * 4), x0 = Math.min(1 - bw, Math.max(0, fx - bw / 2)), y0 = Math.min(1 - bh, Math.max(0, fy - bh * 0.45));
    c.save(); if (settings.mirror) { c.translate(w, 0); c.scale(-1, 1); }
    c.imageSmoothingEnabled = true; c.drawImage(tiny, 0, 0, w, h);
    c.fillStyle = 'rgba(40,0,6,.38)'; c.fillRect(0, 0, w, h);
    if (seen) { if (up) tracker.drawUpright(c, x0 * w, y0 * h, bw * w, bh * h, { x: x0, y: y0, w: bw, h: bh }); else c.drawImage(video, x0 * vw, y0 * vh, bw * vw, bh * vh, x0 * w, y0 * h, bw * w, bh * h); }
    c.restore();
    if (seen) {
      const bx = (settings.mirror ? 1 - x0 - bw : x0) * w;
      c.lineWidth = 4; c.strokeStyle = cueState === 'weak' ? '#ffb020' : '#27d35b'; roundRect(c, bx + 2, y0 * h + 2, bw * w - 4, bh * h - 4, 10); c.stroke();
    }
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
  let calStable = 0, calDone = false, calibrated = false, calTimer = null, calSpot = { x: 0.5, y: 0.5 }, calPath = [], calLast = null;
  function calTick(s) {
    if (phase !== 'calibrating') return;
    drawPrivacy(calCtx, calCv.width, calCv.height, s);
    $('cal-dot').classList.toggle('on', s.found); $('cal-st').textContent = s.found ? 'Mug Detected' : 'Looking For Mug';
    $('cal-guide').classList.toggle('on', s.found);
    $('cal-pos').style.transform = `translateX(${(Math.min(1, Math.max(0, s.x)) - 0.5) * 300}px)`;
    // Only something that has MOVED can be the mug. On the venue recording the game locked onto a red-and-white
    // poster behind the player, 1.4 s after the camera started and before anyone was in view. A poster's position
    // flickers by a pixel at most; a mug being lifted into view travels. Jumps from one object to another
    // (more than 20 px in one frame) do not count as travel.
    const nowMs = performance.now(), opt = tracker && tracker.getOptions ? tracker.getOptions() : { width: 160, height: 90 };
    if (s.found) {
      if (calLast) { const dpx = Math.hypot((s.rawX - calLast.x) * opt.width, (s.rawY - calLast.y) * opt.height); if (dpx > 1.6 && dpx < 20) calPath.push({ t: nowMs, d: dpx }); }
      calLast = { x: s.rawX, y: s.rawY };
    } else calLast = null;
    while (calPath.length && nowMs - calPath[0].t > 4000) calPath.shift();
    const moved = calPath.reduce((sum, p) => sum + p.d, 0) >= 10;
    if (s.found && !moved && !calDone) $('cal-msg').textContent = 'Move the mug a little so the camera can pick it up.';
    // inside the centre box, steadily, for 1.5 s -> calibrate once, then go
    calStable = s.found && moved && (s.confidence || 1) >= 0.5 ? Math.min(1, calStable + 1 / 60) : Math.max(0, calStable - 1 / 20); // ~2 s of steady detection
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
    setTimeout(howToPlay, 700);
  }

  // ---------- how to play: once per player, HOW_SECONDS or a tap ----------
  const HOW_SECONDS = +qs.get('how') || 6;
  let howTimer = 0, howDone = false;
  function howToPlay() {
    if (howDone || HOW_SECONDS <= 0) return startCountdown();
    howDone = true; phase = 'how'; show('how');
    const n = $('how-n'), t0 = performance.now(); let raf = 0;
    const go = () => { cancelAnimationFrame(raf); clearTimeout(howTimer); ov.how.removeEventListener('pointerdown', go); KKAudio.tap(); startCountdown(); };
    const tick = now => { const k = Math.min(1, (now - t0) / (HOW_SECONDS * 1000)); n.textContent = String(Math.max(1, Math.ceil(HOW_SECONDS - k * HOW_SECONDS))); if (k < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    howTimer = setTimeout(go, HOW_SECONDS * 1000);
    setTimeout(() => ov.how.addEventListener('pointerdown', go, { once: true }), 400);   // the button, or anywhere on the screen
  }
  // Prize rule pushed from the server (review page): merge into the live settings when the sync script sees a change.
  const REMOTE_KEYS = ['rewardMode', 'everyNth', 'pacing', 'openHour', 'closeHour', 'capMin', 'teeMin', 'stockDays'];
  window.addEventListener('kk:remote-settings', e => { const r = e.detail || {}; REMOTE_KEYS.forEach(k => { if (k in r) settings[k] = r[k]; }); save(LS.settings, settings); if (setupOpen) refreshStock(); });
  function beginCalibration() {
    KKAudio.music('attract'); // same track as the cover and register pages, continued from where it was
    phase = 'calibrating'; calStable = 0; calDone = false; show('cal');
    if (tracker && tracker.setAcquire) tracker.setAcquire(true);
    clearTimeout(calTimer); $('cal-skip').style.display = 'none'; $('cal-msg').textContent = 'Stand about 3 feet from the screen and hold the mug up, logo facing the camera.';
  }
  $('cal-skip').addEventListener('click', () => { calDone = true; startCountdown(); }); // only shown when the camera itself failed

  // ---------- countdown ----------
  async function startCountdown() {
    if (!spritesReady()) {
      $('cal-msg').textContent = 'Loading the game…';
      await Promise.race([loadSprites(), new Promise(r => setTimeout(r, 120000))]);
      // DunkSprites keeps loading past its timeout and swaps late images in; wait for the set to be complete.
      const t0 = performance.now();
      while (!spritesReady() && performance.now() - t0 < 120000) await new Promise(r => setTimeout(r, 100));
    }
    phase = 'countdown'; show('count');
    if (tracker && tracker.setAcquire) tracker.setAcquire(false);   // from here on: the parameters calibration settled on
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
    const size = 300, cx = 400, baseY = 262;
    ctx.font = `italic 900 ${size}px Montserrat, Poppins, Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const m = ctx.measureText(text); const top = baseY - m.actualBoundingBoxAscent, bot = baseY + m.actualBoundingBoxDescent, gh = bot - top;
    const depth = Math.round(gh * 0.11), dx = -0.48, dy = 1.0;
    // ground shadow
    ctx.save(); ctx.shadowColor = 'rgba(60,0,0,.55)'; ctx.shadowBlur = 36; ctx.shadowOffsetY = 26; ctx.shadowOffsetX = -8; ctx.fillStyle = 'rgba(120,50,0,1)'; ctx.fillText(text, cx + dx * depth, baseY + dy * depth); ctx.restore();
    // bright lip along the far edge of the extrusion
    for (let i = depth + 2; i > depth; i--) { ctx.fillStyle = i === depth + 2 ? '#b66304' : '#f7d990'; ctx.fillText(text, cx + dx * i, baseY + dy * i); }
    // extrusion side: amber, lighter near the face
    for (let i = depth; i >= 1; i--) {
      const t = i / depth;
      const r = Math.round(0xd0 - (0xd0 - 0x8c) * t), g = Math.round(0x7a - (0x7a - 0x47) * t), b = Math.round(0x12 - (0x12 - 0x00) * t);
      ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillText(text, cx + dx * i, baseY + dy * i);
    }
    // face
    const g1 = ctx.createLinearGradient(0, top, 0, bot);
    g1.addColorStop(0, '#fff1cf'); g1.addColorStop(.18, '#fbe3a6'); g1.addColorStop(.38, '#f6d27a'); g1.addColorStop(.58, '#f0c354'); g1.addColorStop(.78, '#e7ae38'); g1.addColorStop(.92, '#dc9a26'); g1.addColorStop(1, '#e9b24a');
    ctx.fillStyle = g1; ctx.fillText(text, cx, baseY);
    // soft highlight band on the upper third, darker warm band near the bottom of the face
    ctx.save(); ctx.globalCompositeOperation = 'source-atop';
    const g2 = ctx.createLinearGradient(0, top, 0, bot);
    g2.addColorStop(0, 'rgba(255,255,255,.18)'); g2.addColorStop(.2, 'rgba(255,255,255,0)'); g2.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g2; ctx.fillText(text, cx, baseY); ctx.restore();
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
  // The 4K kiosk's TV chip cannot fill a 2160x3840 canvas at 60 fps; 1.5x is sharp enough. If a round still
  // runs slow (frame time over 22 ms for a while), the next round drops to 1x with reduced effects, and the
  // choice is remembered on the kiosk (kk_perf). ?px= overrides for testing.
  let perf = null; try { perf = localStorage.getItem('kk_perf'); } catch (_) {}
  if (pixelScale > 1.5) pixelScale = 1.5;
  if (perf === 'low') pixelScale = Math.min(pixelScale, 1);
  if (qs.get('px')) pixelScale = Math.min(2, Math.max(0.5, parseFloat(qs.get('px')) || 1));
  let frameEma = 0, slowSince = 0;
  function watchPerf(st) {
    const ms = st.stats && st.stats.frameMs; if (!ms) return;
    frameEma = frameEma ? frameEma + 0.05 * (ms - frameEma) : ms;
    const now = performance.now();
    if (frameEma > 22) { if (!slowSince) slowSince = now; else if (now - slowSince > 3000 && perf !== 'low') { perf = 'low'; try { localStorage.setItem('kk_perf', 'low'); } catch (_) {} } }
    else slowSince = 0;
  }
  const gameCanvas = $('game');
  gameCanvas.width = Math.round(1080 * pixelScale); gameCanvas.height = Math.round(1920 * pixelScale);
  // Artwork loads from page open, in parallel with the camera check. The round never starts on the drawn
  // placeholders: startCountdown waits for this promise, and a slow image swaps in as soon as it arrives.
  let spritesPromise = null;
  function loadSprites() {
    if (!spritesPromise) {
      spritesPromise = fetch('assets/img/game/manifest.json').then(r => r.json()).catch(() => null)
        .then(manifest => DunkSprites.load(manifest || {}, { scale: pixelScale, timeout: 120000 }))
        .then(s => { sprites = s; return s; });
    }
    return spritesPromise;
  }
  const spritesReady = () => !!(sprites && !(sprites.$missing || []).some(n => sprites[n] && !sprites[n].fromImage && !sprites[n].failed));
  function startPlay() {
    KKAudio.music('play');
    if (game) { game.destroy(); game = null; }
    hud.el.classList.remove('final5'); resetScore();
    game = DunkGame.create({
      canvas: gameCanvas, sprites, duration: DURATION, reducedEffects: perf === 'low',
      onTick: st => {
        watchPerf(st);
        if (st.mugX01 != null) $('cup-glow').style.transform = `translateX(${240 + st.mugX01 * 600}px)`;   // under the cup: MUG_MIN_X..MUG_MAX_X in game.js
        setText('time', fmtTime(st.timeLeft));
        tickScore(st.score);
        setText('rank', '#' + liveRank(st.score));
      },
      onEvent: onGameEvent,
      onEnd: onGameEnd
    });
    phase = 'playing'; document.body.classList.add('playing-view');
    game.setTargetX(playX(trackState.x)); game.setTracking(true);
    game.start();
    armIdle(false);
  }
  function onGameEvent(e) {
    switch (e.type) {
      case 'catch':
        if (e.bonus === 'time') { KKAudio.gold(); hud.time.classList.remove('bump'); void hud.time.offsetWidth; hud.time.classList.add('bump'); toast(`+${e.seconds} seconds!`); }
        else e.kind === 'gold' ? KKAudio.gold() : KKAudio.catch();
        break;
      case 'pattern': KKAudio.whoosh(); break;
      case 'final10': KKAudio.hurry(); KKAudio.music('playFast', { fade: 800 }); break;
      case 'streak': KKAudio.streak(); break;
      case 'hit': KKAudio.hit(); break;
      case 'miss': KKAudio.miss(); break;
      case 'final5': hud.el.classList.add('final5'); break;
      case 'lost': showLost(); break;
      case 'regained': hideAll(); break;
    }
  }
  function onGameEnd(result) {
    phase = 'ended'; document.body.classList.remove('playing-view'); endResult = result; KKAudio.end(); KKAudio.stopMusic(500);
    const rank = recordScore(result);
    $('end-name').textContent = firstName ? `${firstName}, what a break!` : 'What a break!';
    setScoreNumber(0);
    $('end-rank').textContent = '#' + rank; $('end-caught').textContent = String(result.caught); $('end-streak').textContent = String(result.bestStreak);
    const pz = awardPrize(result); const pEl = $('prize'); const nth = settings.rewardMode === 'nth';
    $('end-title').textContent = pz.kind === 'tee' ? 'Legend!' : pz.kind ? (nth ? 'Lucky Break!' : 'Hot Break!') : result.score >= settings.teeMin ? 'Hot Break!' : "Time's Up!";
    const rec = recordPlay(player && player.mobile, !!pz.kind);
    const canRetry = !pz.kind && !retryUsed && rec && rec.plays < 2;
    ov.end.classList.toggle('lost', !pz.kind);
    $('again').textContent = canRetry ? 'Try Again' : 'Done';
    $('again').dataset.mode = canRetry ? 'retry' : 'done';
    $('tier-cap').textContent = nth ? 'KitKat Cap' : settings.capMin + ' Points'; $('tier-tee').textContent = nth ? `T-shirt · ${settings.teeMin}+ pts` : settings.teeMin + ' Points';
    $('none-title').textContent = pz.soldOut ? (nth ? 'Next Time!' : 'Prizes Are Gone') : nth ? 'Nice Break!' : 'So Close!';
    $('none-msg').textContent = pz.soldOut ? (nth ? 'The shelf is being restocked. Thanks for playing today.' : 'Great score. Thanks for playing today.') : canRetry ? (nth ? 'Play again for another chance at a prize.' : 'Play again to unlock a prize.') : 'Thanks for playing. Enjoy your break!';
    pEl.classList.toggle('none', !pz.kind); if (pz.kind) $('prize-pic').src = pz.kind === 'tee' ? 'assets/img/game/prize-tee.png' : 'assets/img/game/prize-cap.png';
    if (pz.kind) { $('prize-name').textContent = pz.kind === 'tee' ? 'You won a KitKat T-shirt!' : 'You won a KitKat Cap!'; $('prize-msg').textContent = 'Show this code at the counter to collect your prize.'; $('prize-code').textContent = pz.code; $('prize-code').style.display = ''; }
    else { $('prize-name').textContent = pz.soldOut ? (nth ? 'Next time!' : "Today's prizes are all gone") : nth ? 'Nice break!' : 'So close!'; $('prize-msg').textContent = pz.soldOut ? 'Thanks for playing. Come back for another break.' : nth ? 'Prizes drop through the day. Keep an eye out!' : `Score ${settings.capMin} for a cap, ${settings.teeMin} for a T-shirt.`; $('prize-code').style.display = 'none'; }
    setTimeout(() => {
      show('end');
      KKAudio.sting(pz.kind ? 'win' : 'lose'); KKAudio.countup(); setTimeout(() => KKAudio.prize(), 1500);
      if (pz.kind) setTimeout(() => { confetti(); KKAudio.confetti(); }, 500);
      countUp($('end-score'), result.score, 1400);
      if (endAmbient) endAmbient.stop();
      endAmbient = KKAmbient.create({ stage: ov.end, zIndex: 0, sparkles: 14, sparkleArea: { x0: 120, x1: 960, y0: 470, y1: 800 } });
    }, 900);
    armIdle(true);
  }
  $('again').addEventListener('click', () => { if ($('again').dataset.mode === 'done') { location.href = 'index.html'; return; } retryUsed = true; hideAll(); if (endAmbient) { endAmbient.stop(); endAmbient = null; } calDone = false; startCountdown(); });
  $('to-home').addEventListener('click', () => { location.href = 'index.html'; });

  // ---------- premium confetti: gold and red foil, two bursts from the top corners, 1.6 s ----------
  function confetti() {
    const cv = $('confetti'); if (!cv) return; const ctx = cv.getContext('2d');
    const ps = (window.KKStage && window.KKStage.pixelScale) || 1; cv.width = 1080 * ps; cv.height = 1920 * ps; ctx.setTransform(ps, 0, 0, ps, 0, 0);
    const cols = ['#f6d27a', '#e9b84f', '#fff1c4', '#c8102e', '#8a0610', '#ffffff'];
    const P = [];
    const burst = (x, y, dir) => { for (let i = 0; i < 70; i++) { const a = dir + (Math.random() - 0.5) * 1.1, sp = 900 + Math.random() * 900; P.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, w: 10 + Math.random() * 10, h: 16 + Math.random() * 14, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 14, c: cols[i % cols.length], life: 2.6 + Math.random() * 1.2, foil: Math.random() < 0.6 }); } };
    burst(40, 560, 0.55); burst(1040, 560, Math.PI - 0.55);
    setTimeout(() => { burst(540, 520, -Math.PI / 2 - 0.4); burst(540, 520, -Math.PI / 2 + 0.4); }, 260);
    let last = performance.now(), raf = 0;
    const tick = now => {
      const dt = Math.min(0.033, (now - last) / 1000); last = now; ctx.clearRect(0, 0, 1080, 1920); let alive = 0;
      for (const p of P) { if (p.life <= 0) continue; alive++; p.life -= dt; p.vy += 1500 * dt; p.vx *= 0.985; p.vy *= 0.99; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
        const flip = Math.abs(Math.cos(p.rot * 1.7)); ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = Math.min(1, p.life);
        ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2 * flip, p.w, p.h * flip);
        if (p.foil) { ctx.globalAlpha *= 0.55 * flip; ctx.fillStyle = '#fff'; ctx.fillRect(-p.w / 2, -p.h / 2 * flip, p.w * 0.35, p.h * flip); } ctx.restore(); }
      if (alive) raf = requestAnimationFrame(tick); else ctx.clearRect(0, 0, 1080, 1920);
    };
    cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
  }

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
    su.mirror.checked = settings.mirror; su.sens.value = Math.round(settings.sensitivity * 100); su.smooth.value = Math.round(settings.smoothing * 100); su.pip.checked = settings.tile !== false; if ($('su-range')) $('su-range').value = Math.round((+settings.range || 0.7) * 100); su.sound.checked = settings.sound;
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
  su.pip.addEventListener('change', () => { settings.tile = su.pip.checked; setPip(settings.tile); save(LS.settings, settings); });
  if ($('su-range')) $('su-range').addEventListener('input', () => { settings.range = $('su-range').value / 100; save(LS.settings, settings); });
  if ($('su-rotate')) { $('su-rotate').value = String(settings.rotate == null ? 'auto' : settings.rotate); $('su-rotate').addEventListener('change', () => { const v = $('su-rotate').value; settings.rotate = v === 'auto' ? 'auto' : +v; save(LS.settings, settings); if (tracker) { tracker.setOptions({ rotate: settings.rotate }); tracker.forgetStatic && tracker.forgetStatic(); } toast('Camera rotation set. Calibrate on the mug again.'); }); }
  if ($('su-static')) { $('su-static').checked = settings.staticRed === true; $('su-static').addEventListener('change', () => { settings.staticRed = $('su-static').checked; save(LS.settings, settings); tracker && tracker.setOptions({ staticMs: settings.staticRed ? 2500 : 0 }); }); }
  if ($('su-forget')) $('su-forget').addEventListener('click', () => { tracker && tracker.forgetStatic && tracker.forgetStatic(); toast('Background forgotten. It is learned again from the next camera picture.'); });
  su.sound.addEventListener('change', () => { settings.sound = su.sound.checked; KKAudio.setMuted(!settings.sound); save(LS.settings, settings); });
  const vm = $('su-vol-music'), vs = $('su-vol-sfx');
  if (vm && vs) { const v = KKAudio.getVolumes(); vm.value = Math.round(v.music * 100); vs.value = Math.round(v.sfx * 100);
    vm.addEventListener('input', () => KKAudio.setVolumes({ music: vm.value / 100 })); vs.addEventListener('input', () => { KKAudio.setVolumes({ sfx: vs.value / 100 }); KKAudio.catch(); }); }
  su.cam.addEventListener('change', async () => { settings.deviceId = su.cam.value; save(LS.settings, settings); try { tracker.stop(); await tracker.start({ deviceId: settings.deviceId || undefined }); toast('Camera switched'); } catch (e) { toast('Could not switch camera'); } });
  $('su-cal').addEventListener('click', async () => { try { const r = await tracker.calibrate({ x: 0.33, y: 0.2, w: 0.34, h: 0.6 }); calibrated = !!(r && r.ok); toast(calibrated ? 'Calibrated on the mug' : 'No mug seen in the box'); } catch (_) { toast('Calibration failed'); } });
  $('su-reset').addEventListener('click', () => { try { localStorage.removeItem('kk_tracker_params'); } catch (_) {} calibrated = false; toast('Calibration reset'); });
  $('su-clear').addEventListener('click', () => { save(LS.board, { rows: [] }); toast('Leaderboard cleared'); });
  function refreshStock() {
    const st = stock(), t = turns(), N = Math.max(1, settings.everyNth | 0), nth = settings.rewardMode === 'nth';
    const nextIn = N - (t.n % N);
    $('su-stock').textContent = `Caps left: ${st.cap} / ${quota('cap')}    T-shirts left: ${st.tee} / ${quota('tee')}    awarded today: ${st.awarded.length}` +
      `\nRounds today: ${t.n}` + (nth ? `    next winning round: #${t.n + nextIn} (in ${nextIn})` : '') +
      (settings.pacing ? `    released so far: caps ${available('cap')}, T-shirts ${available('tee')}` : '');
    $('su-cap-min').value = settings.capMin; $('su-tee-min').value = settings.teeMin;
    $('su-pipstyle').value = settings.pipStyle || ''; $('su-mode').value = settings.rewardMode; $('su-nth').value = N; $('su-pacing').checked = !!settings.pacing; $('su-open').value = settings.openHour; $('su-close').value = settings.closeHour;
    document.body.classList.toggle('reward-score', !nth);
  }
  $('su-cap-min').addEventListener('change', () => { settings.capMin = Math.max(1, +$('su-cap-min').value || 12); save(LS.settings, settings); });
  $('su-tee-min').addEventListener('change', () => { settings.teeMin = Math.max(1, +$('su-tee-min').value || 25); save(LS.settings, settings); });
  $('su-pipstyle').addEventListener('change', () => { settings.pipStyle = $('su-pipstyle').value; save(LS.settings, settings); applyPipStyle(settings.pipStyle); });
  $('su-mode').addEventListener('change', () => { settings.rewardMode = $('su-mode').value === 'score' ? 'score' : 'nth'; save(LS.settings, settings); refreshStock(); });
  $('su-nth').addEventListener('change', () => { settings.everyNth = Math.min(50, Math.max(1, +$('su-nth').value || 5)); save(LS.settings, settings); refreshStock(); });
  $('su-pacing').addEventListener('change', () => { settings.pacing = $('su-pacing').checked; save(LS.settings, settings); refreshStock(); });
  $('su-open').addEventListener('change', () => { settings.openHour = Math.min(23, Math.max(0, +$('su-open').value || 0)); save(LS.settings, settings); refreshStock(); });
  $('su-close').addEventListener('change', () => { settings.closeHour = Math.min(24, Math.max(1, +$('su-close').value || 24)); save(LS.settings, settings); refreshStock(); });
  $('su-turns-reset').addEventListener('click', () => { save(LS.turns, { day: todayKey(), n: 0 }); refreshStock(); toast('Round counter reset'); });
  $('su-stock-reset').addEventListener('click', () => { save(LS.stock, { day: todayKey(), awarded: [] }); refreshStock(); toast('Stock reset'); });
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
    for (let i = 0; i < 12; i++) { await new Promise(r => setTimeout(r, 2000)); (tracker.drawUpright ? tracker.drawUpright(sc, (i % 4) * 640, Math.floor(i / 4) * 360, 640, 360) : sc.drawImage(video, (i % 4) * 640, Math.floor(i / 4) * 360, 640, 360)); }
    const a = document.createElement('a'); a.href = sheet.toDataURL('image/png'); a.download = `mug-samples-${Date.now()}.png`; a.click(); toast('Saved mug-samples PNG to Downloads. Send it over for tuning.', 5000);
  });
  // open: key "c", or 5 taps on the logo within 3 s
  document.addEventListener('keydown', e => { if (e.key === 'c' || e.key === 'C') setupOpen ? closeSetup() : openSetup(); if (e.key === 'Escape') closeSetup(); });
  let taps = [], logo = $('logo'); logo.style.pointerEvents = 'auto';
  logo.addEventListener('pointerdown', () => { const t = performance.now(); taps = taps.filter(x => t - x < 3000); taps.push(t); if (taps.length >= 5) { taps = []; openSetup(); } });

  // ---------- boot ----------
  async function boot() {
    if (!settings.sound) KKAudio.setMuted(true); setPip(settings.tile !== false || qs.get('debug') === '1');
    if (/^[bcd]$/.test(qs.get('bg') || '')) document.body.classList.add('bg-' + qs.get('bg'));
    applyPipStyle(qs.get('pipstyle') || settings.pipStyle || '');
    document.addEventListener('visibilitychange', () => { if (!game) return; document.hidden ? game.pause() : (phase === 'playing' && game.resume()); });
    loadSprites().then(() => KKAudio.preload()); // artwork first, then the 8 MB of audio, so sprites never lose the bandwidth race
    beginCalibration();
    try { await startTracker(); await fillCameraList($('cam-sel')); }
    catch (e) {
      const msg = e && e.code === 'denied' ? 'Camera permission is blocked. Allow the camera in Chrome and reload.' : e && e.code === 'in-use' ? 'The camera is in use by another app.' : 'No camera found. Connect the webcam and reload.';
      $('cam-err').textContent = msg; $('cal-skip').style.display = 'inline-block'; try { await fillCameraList($('cam-sel')); } catch (_) {}
    }
  }
  window.__kk = { get phase() { return phase; }, get track() { return trackState; }, get game() { return game; }, get sprites() { return sprites; }, get result() { return endResult; }, show, settings, awardPrize, stock, setScore: setScoreNumber, confetti };
  boot();
})();
