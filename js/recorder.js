/*
 * KKRecorder: flight recorder for mug tracking (debug tool, see api/debug/index.php and debug/index.html).
 *
 * Every round it stores, then uploads between rounds:
 *   L1 telemetry  one row per detector frame (position, score, part scores, tracking state) + game events
 *   L2 video      the raw camera stream (TEST mode only)
 *   L3 frames     the exact 160x90 images the detector worked on: 2 per second, 5 per second while
 *                 calibrating, and every frame for a second around each "mug lost" event
 *
 * It needs no changes in flow.js: it wraps MugTracker.create and DunkGame.create and reads the phase
 * from window.__kk. Load it after tracker.js and game.js and before flow.js.
 *
 * Modes (from the server, GET api/debug/?a=config): off | public (no video) | test (with video).
 * Nothing is recorded without a kiosk key: open game.html?debugkey=<key> once on the kiosk.
 * Everything here is wrapped so that a recorder fault can never stop the game.
 */
(function (root) {
  'use strict';
  var API = 'api/debug/';
  var COLS = ['t', 'found', 'x', 'y', 'w', 'h', 'score', 'sWhite', 'sAspect', 'sArea', 'sFill', 'sInner', 'sTemp', 'cand', 'redArea', 'whiteRatio', 'tracking', 'sx', 'fps'];
  var CAL_TIMEOUT_MS = 90000, MAX_SESSION_MS = 300000, MAX_FRAMES = 300, RING = 30, QUEUE_CAP = 300 * 1048576, CHUNK = 2 * 1048576;
  var qs = new URLSearchParams(location.search);
  var LS = root.localStorage;
  var K = { key: 'kk_debug_key', mode: 'kk_debug_mode', local: 'kk_debug_local' };

  function get(k) { try { return LS.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { v == null ? LS.removeItem(k) : LS.setItem(k, v); } catch (e) { /* ignore */ } }
  function r4(v) { return Math.round(v * 10000) / 10000; }
  function uuid() {
    if (root.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  // ---- key, mode, replay --------------------------------------------------------------------------
  if (qs.get('debugkey')) set(K.key, qs.get('debugkey'));
  var key = get(K.key) || '';
  var replayId = /^[0-9a-f-]{36}$/.test(qs.get('replay') || '') ? qs.get('replay') : '';
  var serverMode = get(K.mode) || 'off';
  // Staff can lower the mode on this kiosk (setup panel); the server's "off" always wins.
  function effectiveMode() {
    if (!key || serverMode === 'off') return 'off';
    if (replayId && qs.get('record') !== '1') return 'off';   // a replay is only recorded when asked (used to test the recorder itself)
    var local = get(K.local);
    if (local === 'off') return 'off';
    if (local === 'public') return 'public';
    return serverMode;
  }
  try {
    fetch(API + '?a=config').then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) { serverMode = j.mode; set(K.mode, j.mode); paintPanel(); }
    }).catch(function () { /* offline: keep the last known mode */ });
  } catch (e) { /* ignore */ }

  // ---- IndexedDB queue ----------------------------------------------------------------------------
  var dbp = null;
  function idb() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var rq = indexedDB.open('kk_debug', 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore('sessions', { keyPath: 'id' }); };
      rq.onsuccess = function () { res(rq.result); }; rq.onerror = function () { rej(rq.error); };
    });
    return dbp;
  }
  function tx(mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction('sessions', mode), out = fn(t.objectStore('sessions'));
        t.oncomplete = function () { res(out && out.result !== undefined ? out.result : undefined); };
        t.onerror = t.onabort = function () { rej(t.error); };
      });
    });
  }
  function queued() { return tx('readonly', function (s) { return s.getAll(); }).then(function (a) { return a || []; }); }
  function sizeOf(rec) { var n = 0; for (var f in rec.files) n += rec.files[f].size; return n; }
  function enqueue(rec) {
    return queued().then(function (all) {
      // bounded storage: drop the oldest videos first, then the oldest sessions
      all.sort(function (a, b) { return a.at - b.at; });
      var total = sizeOf(rec) + all.reduce(function (n, r) { return n + sizeOf(r); }, 0), work = [];
      for (var i = 0; i < all.length && total > QUEUE_CAP; i++) if (all[i].files['camera.webm']) { total -= all[i].files['camera.webm'].size; delete all[i].files['camera.webm']; all[i].meta.flags.push('video-dropped-queue-full'); work.push(all[i]); }
      for (i = 0; i < all.length && total > QUEUE_CAP; i++) { total -= sizeOf(all[i]); all[i]._drop = true; work.push(all[i]); }
      return tx('readwrite', function (s) { work.forEach(function (r) { r._drop ? s.delete(r.id) : s.put(r); }); s.put(rec); });
    });
  }

  // ---- upload (between rounds only) ---------------------------------------------------------------
  var uploading = false, lastUpload = '', busyPlaying = false;
  function post(url, body, json) {
    var h = { 'X-KK-Key': key, 'Content-Type': json ? 'application/json' : 'application/octet-stream' };
    return fetch(url, { method: 'POST', headers: h, body: json ? JSON.stringify(body) : body }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!j || !j.ok) { var e = new Error((j && j.error) || ('http ' + r.status)); e.fatal = r.status >= 400 && r.status < 500 && r.status !== 429; throw e; }
        return j;
      });
    });
  }
  async function uploadOne(rec) {
    var begin = await post(API + '?a=begin', rec.meta, true);
    for (var name in rec.files) {
      var blob = rec.files[name], off = (begin.sizes && begin.sizes[name]) || 0;
      while (off < blob.size) {
        if (busyPlaying) throw new Error('paused for play');
        var j = await post(API + '?a=chunk&id=' + rec.id + '&name=' + name + '&offset=' + off, blob.slice(off, off + CHUNK), false);
        off = j.size;
      }
    }
    await post(API + '?a=finish&id=' + rec.id, rec.meta, true);
  }
  async function pump() {
    if (uploading || busyPlaying || !key || !navigator.onLine) return;
    uploading = true;
    try {
      var all = await queued(); all.sort(function (a, b) { return a.at - b.at; });
      for (var i = 0; i < all.length; i++) {
        try { await uploadOne(all[i]); await tx('readwrite', function (s) { s.delete(all[i].id); }); lastUpload = new Date().toLocaleTimeString(); }
        catch (e) {
          if (e.fatal) { await tx('readwrite', function (s) { s.delete(all[i].id); }); lastUpload = 'rejected: ' + e.message; }   // the server will never take it
          else { lastUpload = 'waiting: ' + e.message; break; }
        }
        paintPanel();
      }
    } catch (e) { /* storage unavailable */ }
    uploading = false; paintPanel();
  }
  root.addEventListener('online', pump);
  setInterval(pump, 30000);
  setTimeout(pump, 4000);

  // ---- session ------------------------------------------------------------------------------------
  var tracker = null, S = null, lastPhase = '', waitForPlay = false;
  function gz(bytes) {
    if (typeof CompressionStream === 'undefined') return Promise.resolve(null);
    return new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  }
  function cameraInfo() {
    var info = { label: '', settings: {}, capabilities: {} };
    try {
      var st = tracker.getStream && tracker.getStream(), tr = st && st.getVideoTracks()[0];
      if (tr) { info.label = tr.label; info.settings = tr.getSettings ? tr.getSettings() : {}; info.capabilities = tr.getCapabilities ? tr.getCapabilities() : {}; delete info.settings.deviceId; delete info.settings.groupId; delete info.capabilities.deviceId; delete info.capabilities.groupId; }
      var v = tracker.video; info.video = { w: v.videoWidth, h: v.videoHeight };
    } catch (e) { /* ignore */ }
    return info;
  }
  function start(mode, phase) {
    var o = tracker.getOptions();
    S = { id: uuid(), mode: mode, t0: performance.now(), rows: [], events: [], ring: [], kept: [], keptTs: {}, lastKeep: 0, calKept: 0, burst: 0, lowFps: 0, wasTracking: false,
          rec: null, chunks: [], videoStart: null, flags: [], w: o.width, h: o.height,
          meta: { id: null, v: 1, mode: mode, startedAt: new Date().toISOString(), page: location.pathname, ua: navigator.userAgent,
                  screen: { w: screen.width, h: screen.height, dpr: root.devicePixelRatio || 1 }, stage: root.KKStage ? { scale: root.KKStage.scale, mode: root.KKStage.mode } : null,
                  tracker: o, paramsStart: tracker.getParams(), settings: (root.__kk && root.__kk.settings) || null, camera: cameraInfo(), flags: [] } };
    S.meta.id = S.id; S.flags = S.meta.flags;
    event('session', { phase: phase });
    if (mode === 'test') startVideo();
    paintPanel();
  }
  function startVideo() {
    try {
      var st = tracker.getStream && tracker.getStream();
      if (!st && replayId && tracker.video.captureStream) st = tracker.video.captureStream();
      if (!st || typeof MediaRecorder === 'undefined') { S.flags.push('no-video-recorder'); return; }
      var type = ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'].filter(function (t) { return MediaRecorder.isTypeSupported(t); })[0];
      var s = S, rec = new MediaRecorder(st, { mimeType: type, videoBitsPerSecond: 600000 });
      rec.ondataavailable = function (e) { if (e.data && e.data.size) s.chunks.push(e.data); };
      rec.onstart = function () { s.videoStart = performance.now() - s.t0; };
      rec.onerror = function () { s.flags.push('video-error'); };
      rec.start(1000); s.rec = rec; s.videoType = type;
    } catch (e) { S.flags.push('video-failed:' + (e && e.name)); }
  }
  function stopVideo(s) {
    return new Promise(function (res) {
      if (!s.rec || s.rec.state === 'inactive') return res();
      s.rec.onstop = function () { res(); };
      try { s.rec.stop(); } catch (e) { res(); }
      setTimeout(res, 1500);
    });
  }
  function event(type, data) { if (S) S.events.push({ t: Math.round(performance.now() - S.t0), type: type, data: data || null }); }

  function keep(f) { if (S.kept.length < MAX_FRAMES && !S.keptTs[f.t]) { S.keptTs[f.t] = 1; S.kept.push(f); } }
  function onFrame(img, ts) {
    if (!S || img.width !== S.w || img.height !== S.h) return;
    var d = img.data, n = S.w * S.h, rgb = new Uint8Array(n * 3), i, j;
    for (i = 0, j = 0; i < n; i++, j += 4) { rgb[i * 3] = d[j]; rgb[i * 3 + 1] = d[j + 1]; rgb[i * 3 + 2] = d[j + 2]; }
    var f = { t: Math.round(ts - S.t0), rgb: rgb };
    S.ring.push(f); if (S.ring.length > RING) S.ring.shift();
    // calibration is sampled faster, but capped so a long wait cannot use up the round's frame budget
    var cal = lastPhase === 'calibrating' && S.calKept < 80, every = cal ? 200 : 500;
    if (S.burst > 0) { S.burst--; keep(f); }
    else if (f.t - S.lastKeep >= every && (cal || lastPhase !== 'calibrating' || f.t - S.lastKeep >= 2000)) { S.lastKeep = f.t; if (lastPhase === 'calibrating') S.calKept++; keep(f); }
  }
  function onDetect(res, ts, state) {
    if (!S) return;
    var sub = res.sub || [0, 0, 0, 0, 0, 0];
    S.rows.push([Math.round(ts - S.t0), res.found ? 1 : 0, r4(res.x), r4(res.y), r4(res.w), r4(res.h), r4(res.score),
      r4(sub[0]), r4(sub[1]), r4(sub[2]), r4(sub[3]), r4(sub[4]), r4(sub[5]), res.candidates | 0, res.redArea | 0, r4(res.whiteRatio),
      state.found ? 1 : 0, r4(state.x), Math.round(state.fps * 10) / 10]);
    // the mug was being tracked and is now lost: keep the second before and the second after, frame by frame
    if (S.wasTracking && !state.found) { S.ring.forEach(keep); S.burst = RING; event('track-lost'); }
    S.wasTracking = state.found;
    // recording must never cost the game its frame rate
    if (S.rec && S.rec.state === 'recording') {
      S.lowFps = state.fps > 0 && state.fps < 24 ? S.lowFps + 1 : 0;
      if (S.lowFps > 90) { S.flags.push('video-stopped-low-fps'); try { S.rec.stop(); } catch (e) { /* ignore */ } }
    }
    // nobody finished calibrating: close this session and wait for a round; a round itself is never cut short
    if (lastPhase === 'calibrating' && ts - S.t0 > CAL_TIMEOUT_MS) { waitForPlay = true; stop('calibration-timeout'); }
    else if (ts - S.t0 > MAX_SESSION_MS) stop('too-long');
  }

  async function stop(reason, result) {
    var s = S; if (!s) return; S = null;
    try {
      await stopVideo(s);
      s.meta.endedReason = reason; s.meta.result = result || null; s.meta.durationMs = Math.round(performance.now() - s.t0);
      s.meta.paramsEnd = tracker.getParams(); s.meta.trackerEnd = tracker.getOptions(); s.meta.camera = cameraInfo();
      s.meta.videoStartMs = s.videoStart; s.meta.videoType = s.videoType || null;
      s.kept.sort(function (a, b) { return a.t - b.t; });
      s.meta.frames = { w: s.w, h: s.h, channels: 3, count: s.kept.length, t: s.kept.map(function (f) { return f.t; }) };
      var files = {};
      var tel = await gz(new TextEncoder().encode(JSON.stringify({ cols: COLS, rows: s.rows, events: s.events })));
      if (!tel) { s.flags.push('no-compression'); return; }
      files['telemetry.json.gz'] = tel;
      if (s.kept.length) {
        var bin = new Uint8Array(s.kept.length * s.w * s.h * 3);
        s.kept.forEach(function (f, i) { bin.set(f.rgb, i * s.w * s.h * 3); });
        files['frames.bin.gz'] = await gz(bin);
      }
      if (s.chunks.length) files['camera.webm'] = new Blob(s.chunks, { type: s.videoType || 'video/webm' });
      await enqueue({ id: s.id, at: Date.now(), meta: s.meta, files: files });
    } catch (e) { /* a failed recording is simply lost */ }
    paintPanel(); setTimeout(pump, 1500);
  }

  // Phase watcher: flow.js exposes its phase on window.__kk.
  setInterval(function () {
    var kk = root.__kk, phase = kk ? kk.phase : '';
    if (!tracker || !phase) return;
    if (phase !== lastPhase) {
      if (S) event('phase', { phase: phase });
      if (phase === 'playing') event('play');
      if (phase !== 'calibrating') waitForPlay = false;
      busyPlaying = phase === 'countdown' || phase === 'playing';
      lastPhase = phase;
    }
    var mode = effectiveMode();
    if (!S && mode !== 'off' && !waitForPlay && (phase === 'calibrating' || phase === 'countdown') && tracker.getOptions().running) start(mode, phase);
  }, 200);

  // ---- hooks into the tracker and the game --------------------------------------------------------
  function wrap(obj, name, fn) { var orig = obj && obj[name]; if (typeof orig === 'function') obj[name] = function () { return fn(orig, this, arguments); }; }
  wrap(root.MugTracker, 'create', function (orig, self, args) {
    var t = orig.apply(self, args);
    try {
      tracker = t; t.onFrame = onFrame; t.onDetect = onDetect;
      if (replayId) t.replayUrl = API + '?a=file&id=' + replayId + '&name=camera.webm';
      var sa = t.setAcquire; if (sa) t.setAcquire = function (on) { event('acquire', { on: !!on }); return sa.apply(t, arguments); };
      var cal = t.calibrate;
      t.calibrate = function () { return cal.apply(t, arguments).then(function (r) { event('calibrate', { ok: !!(r && r.ok), samples: r && r.samples, reason: r && r.reason, params: r && r.params }); return r; }); };
    } catch (e) { /* ignore */ }
    return t;
  });
  wrap(root.DunkGame, 'create', function (orig, self, args) {
    try {
      var o = args[0] || {}, onEvent = o.onEvent, onEnd = o.onEnd;
      o.onEvent = function (e) { try { event('game', { type: e.type, kind: e.kind }); } catch (x) { /* ignore */ } return onEvent && onEvent.apply(this, arguments); };
      o.onEnd = function (result) {
        try { event('end', { score: result && result.score }); setTimeout(function () { stop('ended', result ? { score: result.score, caught: result.caught, bestStreak: result.bestStreak } : null); }, 1500); } catch (x) { /* ignore */ }
        return onEnd && onEnd.apply(this, arguments);
      };
    } catch (e) { /* ignore */ }
    return orig.apply(self, args);
  });
  document.addEventListener('visibilitychange', function () { event('visibility', { hidden: document.hidden }); });

  // ---- setup panel row ----------------------------------------------------------------------------
  var panel = null;
  function paintPanel() {
    if (!panel) return;
    queued().then(function (all) {
      var mb = all.reduce(function (n, r) { return n + sizeOf(r); }, 0) / 1048576;
      panel.stat.textContent = 'recording: ' + (key ? effectiveMode() : 'off (no kiosk key)') + (S ? '  [recording now]' : '') + '   server: ' + serverMode +
        '\nwaiting to upload: ' + all.length + ' round(s), ' + mb.toFixed(1) + ' MB   last: ' + (lastUpload || 'none yet') + (replayId ? '\nREPLAY of ' + replayId : '');
    }).catch(function () { /* ignore */ });
  }
  function buildPanel() {
    var setup = document.getElementById('setup'), before = setup && setup.querySelector('#su-cv');
    if (!setup || !before) return;
    var label = document.createElement('label'); label.textContent = 'Debug recording ';
    var sel = document.createElement('select'); sel.id = 'su-rec';
    [['', 'As the server says'], ['public', 'No video'], ['off', 'Off on this kiosk']].forEach(function (o) { var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; sel.appendChild(op); });
    sel.value = get(K.local) || ''; sel.addEventListener('change', function () { set(K.local, sel.value || null); paintPanel(); });
    label.appendChild(sel);
    var stat = document.createElement('div'); stat.className = 'stat'; stat.id = 'su-rec-stat';
    setup.insertBefore(label, before); setup.insertBefore(stat, before);
    panel = { sel: sel, stat: stat }; paintPanel(); setInterval(paintPanel, 3000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildPanel); else buildPanel();

  root.KKRecorder = { get mode() { return effectiveMode(); }, get active() { return !!S; }, get replay() { return replayId; }, queued: queued, pump: pump, stop: stop, event: event };
})(typeof window !== 'undefined' ? window : this);
