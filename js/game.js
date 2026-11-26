/* DunkGame — engine for "KitKat Dunk the Break" (kiosk catch game).
 *
 *   const game = DunkGame.create({
 *     canvas,            // 1080x1920 transparent canvas (null => headless, for tests)
 *     sprites,           // result of DunkSprites.load(manifest)
 *     duration: 45,      // seconds of play
 *     difficulty: 'normal',   // 'easy' | 'normal' | 'hard'
 *     reducedEffects: false,  // fewer particles, no rays / vignette
 *     seed: 1234,        // optional; same seed => same spawn sequence
 *     onTick(state), onEvent(evt), onEnd(result)
 *   });
 *   game.setTargetX(x01); game.setTracking(found);
 *   game.start(); game.pause(); game.resume(); game.stop(); game.destroy();
 *   game.getState();      // live, read-only state object (see STATE below)
 *
 * Design notes (RK3566 kiosk, Chrome, weak GPU):
 *  - one requestAnimationFrame loop, fixed-timestep physics (1/120 s accumulator)
 *    with render interpolation; the loop pauses when document.hidden.
 *  - everything blitted is pre-rendered (sprites, popups, vignette, glow, rays);
 *    no per-frame gradients, shadowBlur, filters or text layout.
 *  - object pools for items / particles / popups / glows; zero per-frame allocation
 *    on the hot path (the state object is mutated in place).
 *  - all gameplay numbers live in TUNING at the top of this file.
 *  - the engine is deterministic for a given seed when stepped with advance();
 *    the mug idle bob and shake are driven by the wall clock and are cosmetic only.
 *
 * Only `window.DunkGame` is exported. `DunkGame.internals` exposes the pure parts
 * (PRNG, spring, schedule, catch test) for unit tests.
 */
(function (root) {
  'use strict';

  /* ================================================================== */
  /*  TUNING — every gameplay/feel constant. Units: px, s, px/s, rad.    */
  /* ================================================================== */
  var TUNING = {
    STAGE_W: 1080,
    STAGE_H: 1920,

    DT: 1 / 120,            // fixed physics step
    MAX_FRAME_DT: 0.1,      // clamp for a long frame (tab switch, GC pause)

    // --- Mug / layout (from reference/game-screen-reference.webp x 1.1477)
    MUG_MIN_X: 240,         // mug centre range
    MUG_MAX_X: 840,
    MUG_RIM_Y: 1195,        // y of the cocoa surface / rim centre
    MUG_HALF_WIDTH: 230,    // half of the 460 px mug sprite
    CATCH_HALF_FRAC: 0.75,  // catch window = MUG_HALF_WIDTH * this
    CATCH_BAND: 40,         // item centre must be within rim y +/- this
    MUG_BOB_AMP: 4,         // idle bob (px) — cosmetic
    MUG_BOB_HZ: 0.8,

    // --- Mug follow spring (critically damped). Higher = snappier.
    SPRING_OMEGA: 22,       // rad/s; settles ~95% in ~0.2 s
    SPRING_SNAP_IDLE: true, // before start() the mug snaps to the tracker

    // --- Spawning
    SPAWN_Y: -200,          // item centre y at spawn (above the stage)
    MISS_Y: 1330,           // a wafer passing this y is a miss; items fade from here
    KILL_Y: 1560,           // item fully gone (mug bottom; never over the slider)
    LANES: 5,               // spawn lanes across the mug range
    LANE_JITTER: 0.3,       // +/- fraction of lane width
    SPAWN_PAD: 0,           // widen the spawn range beyond the mug range by this many px per side
                            // (keep < MUG_HALF_WIDTH*CATCH_HALF_FRAC so edge items stay catchable)
    SPEED_START: 420,       // fall speed ramps linearly over the round
    SPEED_END: 820,
    SPAWN_START: 1.0,       // spawn interval ramps linearly over the round
    SPAWN_END: 0.5,
    SPAWN_JITTER: 0.15,     // +/- fraction of the interval
    WAFERS_ONLY_SECONDS: 8, // warm-up: only wafers
    MIX: { wafer: 0.65, alarm: 0.20, deadline: 0.15 },
    BAD_LANE_COOLDOWN: 0.8, // no bad in a lane within this of the previous bad there
    MAX_CONSECUTIVE_BADS: 2,// global: never more than N bads in a row
    SPAWN_ONLY_IF_REACHABLE: true, // stop spawning once an item could not reach the rim

    // --- Item motion
    SWAY_AMP: [8, 26],      // px, random per item
    SWAY_HZ: [0.45, 0.85],
    ROT_AMP: [0.15, 0.55],  // rad, slow tumble around a random base angle
    ROT_HZ: [0.2, 0.45],
    ROT_BASE: [-0.5, 0.5],  // rad; wafers fall mostly upright like the reference
    DUNK_SECONDS: 0.35,     // caught wafer sinks behind the mug
    POP_SECONDS: 0.25,      // bad item bursts on hit

    // --- Scoring
    STREAK_EVERY: 3,
    STREAK_BONUS: 1,
    HIT_PENALTY: 1,
    STUN_SECONDS: 1.2,
    STUN_BLOCKS_CATCH: false, // true => wafers pass through while stunned
    STUN_INVULNERABLE: true,  // no second hit while stunned
    STUN_SHAKE_PX: 10,
    FINAL_SECONDS: 5,         // 'final5' event

    // --- Tracking
    LOST_GRACE: 2.0,        // s without the mug before auto-pause
    REGAIN_DELAY: 0.5,      // s after regain before play resumes

    // --- Pools / effects
    ITEM_POOL: 12,
    PARTICLE_POOL: 80,
    POPUP_POOL: 8,
    GLOW_POOL: 4,
    SPLASH_PARTICLES: 14,   // per catch (reducedEffects: SPLASH_PARTICLES_REDUCED)
    SPLASH_PARTICLES_REDUCED: 6,
    SPLASH_SPEED: [260, 640],
    SPLASH_SPREAD: 320,     // horizontal speed +/-
    GRAVITY: 1900,
    PARTICLE_LIFE: [0.45, 0.85],
    POPUP_SECONDS: 0.9,
    BIG_POPUP_SECONDS: 1.3,
    GLOW_SECONDS: 0.35,
    SHOW_PENALTY_POPUP: true,
    RAYS_MIN_STREAK: 3,     // light rays behind the mug from this streak (not in reducedEffects)
    VIGNETTE_RES: 0.25,     // pre-rendered vignette resolution (fraction of stage)

    DIFFICULTY: {
      easy:   { speed: 0.85, spawn: 1.20, bad: 0.70 },
      normal: { speed: 1.00, spawn: 1.00, bad: 1.00 },
      hard:   { speed: 1.15, spawn: 0.85, bad: 1.30 }
    }
  };

  var KIND = { WAFER: 'wafer', ALARM: 'alarm', DEADLINE: 'deadline' };
  var BAD_KINDS = [KIND.ALARM, KIND.DEADLINE];
  var TWO_PI = Math.PI * 2;

  /* ================================================================== */
  /*  Pure helpers (exported via DunkGame.internals)                      */
  /* ================================================================== */

  /** mulberry32 — tiny deterministic PRNG. */
  function createRng(seed) {
    var a = (seed >>> 0) || 0x9e3779b9;
    var rng = function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    rng.range = function (lo, hi) { return lo + (hi - lo) * rng(); };
    rng.pick = function (pair) { return rng.range(pair[0], pair[1]); };
    rng.int = function (n) { return Math.floor(rng() * n); };
    return rng;
  }

  /**
   * One semi-implicit Euler step of a critically damped spring.
   * Returns nothing; mutates s = { x, v }.
   */
  function springStep(s, target, omega, dt) {
    var a = omega * omega * (target - s.x) - 2 * omega * s.v;
    s.v += a * dt;
    s.x += s.v * dt;
  }

  /** Linear ramp of fall speed / spawn interval over the round. */
  function schedule(elapsed, duration, T, diff) {
    T = T || TUNING; diff = diff || TUNING.DIFFICULTY.normal;
    var p = duration > 0 ? Math.min(1, Math.max(0, elapsed / duration)) : 1;
    return {
      speed: (T.SPEED_START + (T.SPEED_END - T.SPEED_START) * p) * diff.speed,
      interval: (T.SPAWN_START + (T.SPAWN_END - T.SPAWN_START) * p) * diff.spawn
    };
  }

  /** Catch test: item centre in the rim band and horizontally over the cup. */
  function catchTest(itemX, itemY, mugX, T) {
    T = T || TUNING;
    if (itemY < T.MUG_RIM_Y - T.CATCH_BAND || itemY > T.MUG_RIM_Y + T.CATCH_BAND) return false;
    return Math.abs(itemX - mugX) < T.MUG_HALF_WIDTH * T.CATCH_HALF_FRAC;
  }

  /**
   * Choose the kind for a spawn. `lanes[lane].lastBadAt` is the sim time of
   * the previous bad item in that lane; `consecutiveBads` is the global run.
   */
  function pickKind(rng, elapsed, now, lane, lanes, consecutiveBads, T, diff) {
    T = T || TUNING; diff = diff || TUNING.DIFFICULTY.normal;
    if (elapsed < T.WAFERS_ONLY_SECONDS) return KIND.WAFER;
    var wW = T.MIX.wafer, wA = T.MIX.alarm * diff.bad, wD = T.MIX.deadline * diff.bad;
    var r = rng() * (wW + wA + wD);
    var kind = r < wW ? KIND.WAFER : (r < wW + wA ? KIND.ALARM : KIND.DEADLINE);
    if (kind !== KIND.WAFER) {
      if (now - lanes[lane].lastBadAt < T.BAD_LANE_COOLDOWN) return KIND.WAFER;
      if (consecutiveBads >= T.MAX_CONSECUTIVE_BADS) return KIND.WAFER;
    }
    return kind;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOutCubic(t) { t = 1 - t; return 1 - t * t * t; }
  function easeOutBack(t) { var c = 1.70158; t -= 1; return 1 + t * t * ((c + 1) * t + c); }

  /* ================================================================== */
  /*  Pre-rendered effect layers                                          */
  /* ================================================================== */

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    return c;
  }

  var FONT_FAMILY = '"Poppins", "Libre Franklin", "Arial Black", Arial, sans-serif';

  /** Gold 3D-ish text: dark extrusion then gold gradient fill, white rim. */
  function fillGoldText(ctx, text, x, y, size, italic) {
    ctx.font = (italic ? 'italic ' : '') + '900 ' + size + 'px ' + FONT_FAMILY;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var depth = Math.max(2, Math.round(size * 0.06));
    ctx.fillStyle = '#5a2a06';
    for (var i = depth; i >= 1; i--) ctx.fillText(text, x + i * 0.6, y + i);
    ctx.lineWidth = Math.max(2, size * 0.05); ctx.lineJoin = 'round';
    ctx.strokeStyle = '#7a4a10'; ctx.strokeText(text, x, y);
    var g = ctx.createLinearGradient(0, y - size / 2, 0, y + size / 2);
    g.addColorStop(0, '#fff3c4'); g.addColorStop(0.45, '#f1c861'); g.addColorStop(0.55, '#d9a63a'); g.addColorStop(1, '#f7dc8a');
    ctx.fillStyle = g; ctx.fillText(text, x, y);
  }

  function buildTextSprites(scale) {
    var out = {};
    // small "+1"
    var s1 = makeCanvas(160 * scale, 110 * scale), c1 = s1.getContext('2d');
    c1.scale(scale, scale); fillGoldText(c1, '+1', 80, 55, 78, true);
    out.plus = { canvas: s1, w: 160, h: 110, ox: 80, oy: 55 };
    // big "+1 / N IN A ROW"
    var s2 = makeCanvas(440 * scale, 320 * scale), c2 = s2.getContext('2d');
    c2.scale(scale, scale); fillGoldText(c2, '+1', 220, 120, 190, true);
    c2.font = 'italic 900 48px ' + FONT_FAMILY; c2.textAlign = 'center'; c2.textBaseline = 'middle';
    c2.lineWidth = 8; c2.lineJoin = 'round'; c2.strokeStyle = 'rgba(70,0,10,.9)';
    c2.strokeText(TUNING.STREAK_EVERY + ' IN A ROW', 220, 262);
    c2.fillStyle = '#fff'; c2.fillText(TUNING.STREAK_EVERY + ' IN A ROW', 220, 262);
    out.big = { canvas: s2, w: 440, h: 320, ox: 220, oy: 160 };
    // "-1"
    var s3 = makeCanvas(160 * scale, 110 * scale), c3 = s3.getContext('2d');
    c3.scale(scale, scale);
    c3.font = 'italic 900 78px ' + FONT_FAMILY; c3.textAlign = 'center'; c3.textBaseline = 'middle';
    c3.lineWidth = 8; c3.lineJoin = 'round'; c3.strokeStyle = '#fff'; c3.strokeText('-1', 80, 55);
    c3.fillStyle = '#ba0018'; c3.fillText('-1', 80, 55);
    out.minus = { canvas: s3, w: 160, h: 110, ox: 80, oy: 55 };
    return out;
  }

  function buildVignette(scale) {
    var W = TUNING.STAGE_W, H = TUNING.STAGE_H, res = TUNING.VIGNETTE_RES;
    var c = makeCanvas(W * res, H * res), ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(c.width / 2, c.height / 2, c.height * 0.25, c.width / 2, c.height / 2, c.height * 0.62);
    g.addColorStop(0, 'rgba(200,0,24,0)'); g.addColorStop(1, 'rgba(200,0,24,0.85)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, c.width, c.height);
    return { canvas: c, w: W, h: H };
  }

  function buildGlow(scale) {
    var R = 170;
    var c = makeCanvas(R * 2 * scale, R * 2 * scale), ctx = c.getContext('2d');
    ctx.scale(scale, scale);
    var g = ctx.createRadialGradient(R, R, R * 0.45, R, R, R);
    g.addColorStop(0, 'rgba(255,220,120,0)'); g.addColorStop(0.55, 'rgba(255,215,110,0.85)');
    g.addColorStop(0.75, 'rgba(255,240,190,0.6)'); g.addColorStop(1, 'rgba(255,200,80,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(R, R, R, 0, TWO_PI); ctx.fill();
    return { canvas: c, w: R * 2, h: R * 2, ox: R, oy: R };
  }

  function buildRays(scale) {
    var R = 380, n = 14;
    var c = makeCanvas(R * 2 * scale, R * 2 * scale), ctx = c.getContext('2d');
    ctx.scale(scale, scale); ctx.translate(R, R);
    var g = ctx.createRadialGradient(0, 0, R * 0.1, 0, 0, R);
    g.addColorStop(0, 'rgba(255,215,120,0.55)'); g.addColorStop(1, 'rgba(255,200,80,0)');
    ctx.fillStyle = g;
    for (var i = 0; i < n; i++) {
      var a = (i / n) * TWO_PI, hw = 0.09;
      ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a - hw) * R, Math.sin(a - hw) * R);
      ctx.lineTo(Math.cos(a + hw) * R, Math.sin(a + hw) * R);
      ctx.closePath(); ctx.fill();
    }
    return { canvas: c, w: R * 2, h: R * 2, ox: R, oy: R };
  }

  /* ================================================================== */
  /*  Engine                                                              */
  /* ================================================================== */

  function create(opts) {
    opts = opts || {};
    var T = TUNING;
    var canvas = opts.canvas || null;
    var ctx = canvas ? canvas.getContext('2d', { alpha: true }) : null;
    var sprites = opts.sprites || null;
    var duration = opts.duration > 0 ? +opts.duration : 45;
    var diff = T.DIFFICULTY[opts.difficulty] || T.DIFFICULTY.normal;
    var reduced = !!opts.reducedEffects;
    var onTick = typeof opts.onTick === 'function' ? opts.onTick : null;
    var onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    var onEnd = typeof opts.onEnd === 'function' ? opts.onEnd : null;
    var autoLoop = opts.autoLoop !== false && !!canvas && typeof requestAnimationFrame === 'function';
    var seed = (opts.seed === undefined || opts.seed === null) ? ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0) : (opts.seed >>> 0);
    var rng = createRng(seed);
    var scale = sprites && sprites.$scale ? sprites.$scale : (canvas ? canvas.width / T.STAGE_W : 1);

    var hasDoc = typeof document !== 'undefined' && document && typeof document.addEventListener === 'function';
    var perf = (typeof performance !== 'undefined' && performance.now) ? performance : { now: function () { return Date.now(); } };

    // ---- Public, live state (mutated in place; never replaced) ---------
    var state = {
      phase: 'idle',          // 'idle' | 'playing' | 'paused' | 'ended'
      timeLeft: duration,
      elapsed: 0,
      score: 0,
      streak: 0,
      bestStreak: 0,
      caught: 0,
      missed: 0,
      hits: 0,
      dodged: 0,
      mugX: (T.MUG_MIN_X + T.MUG_MAX_X) / 2,
      mugX01: 0.5,
      targetX01: 0.5,
      tracking: true,
      stunned: false,
      pauseReason: null,      // 'user' | 'lost' | 'hidden' | null
      seed: seed,
      stats: { items: 0, particles: 0, popups: 0, drawCalls: 0, frameMs: 0, fps: 0 }
    };

    // ---- Internal sim state ---------------------------------------------
    var mug = { x: state.mugX, v: 0, px: state.mugX, target: state.mugX };
    var acc = 0;                 // physics accumulator
    var simTime = 0;             // sim seconds while playing (== elapsed)
    var clock = 0;               // real seconds since create (runs while paused)
    var spawnTimer = 0.6;        // first item shortly after start
    var consecutiveBads = 0;
    var stunT = 0;
    var final5Sent = false;
    var pausedBy = { user: false, lost: false, hidden: false };
    var lostAt = -1;             // clock when tracking was lost (-1 = tracking)
    var regainTimer = 0;
    var destroyed = false;
    var rafId = 0;
    var lastFrame = 0;
    var frameSamples = 0, frameAccumMs = 0, fpsWindowStart = 0;

    var lanes = [];
    for (var li = 0; li < T.LANES; li++) lanes.push({ lastBadAt: -Infinity, lastAt: -Infinity, lastKind: null });
    var spawnMinX = T.MUG_MIN_X - T.SPAWN_PAD;
    var laneW = (T.MUG_MAX_X - T.MUG_MIN_X + 2 * T.SPAWN_PAD) / T.LANES;

    // ---- Pools --------------------------------------------------------------
    function makeItem() {
      return { active: false, kind: KIND.WAFER, bad: false, state: 'fall', lane: 0,
        x: 0, y: 0, px: 0, py: 0, rot: 0, prot: 0, baseX: 0, vy: 0, t: 0, ft: 0,
        swayAmp: 0, swayW: 0, swayPh: 0, rotBase: 0, rotAmp: 0, rotW: 0, rotPh: 0,
        alpha: 1, size: 1, resolved: false };
    }
    var items = [];
    for (var ii = 0; ii < T.ITEM_POOL; ii++) items.push(makeItem());
    var particles = [];
    for (var pi = 0; pi < T.PARTICLE_POOL; pi++) particles.push({ active: false, x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, life: 0, maxLife: 0, size: 1, piece: false, rot: 0, rotV: 0 });
    var popups = [];
    for (var qi = 0; qi < T.POPUP_POOL; qi++) popups.push({ active: false, kind: 'plus', x: 0, y: 0, t: 0, dur: 0 });
    var glows = [];
    for (var gi = 0; gi < T.GLOW_POOL; gi++) glows.push({ active: false, t: 0 });

    // ---- Render resources (browser only) --------------------------------------
    var text = null, vignette = null, glowTex = null, raysTex = null;
    if (ctx) {
      vignette = buildVignette(scale);
      glowTex = buildGlow(scale);
      if (!reduced) raysTex = buildRays(scale);
      text = buildTextSprites(scale);
      // Re-rasterise popups once web fonts arrive (first build may use a fallback font).
      if (hasDoc && document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () { if (!destroyed) text = buildTextSprites(scale); });
      }
      if (sprites) {
        ['wafer', 'alarm', 'deadline', 'wafer-piece'].forEach(function (n) { if (sprites[n]) sprites[n].prewarm(); });
      }
    }

    // ---- Events -------------------------------------------------------------
    function emit(evt) {
      if (onEvent) { try { onEvent(evt); } catch (e) { if (typeof console !== 'undefined') console.error(e); } }
    }

    function updateDerived() {
      state.mugX = mug.x;
      state.mugX01 = (mug.x - T.MUG_MIN_X) / (T.MUG_MAX_X - T.MUG_MIN_X);
      state.stunned = stunT > 0;
      state.timeLeft = Math.max(0, duration - simTime);
      state.elapsed = simTime;
      state.pauseReason = pausedBy.lost ? 'lost' : (pausedBy.hidden ? 'hidden' : (pausedBy.user ? 'user' : null));
    }

    function anyPause() { return pausedBy.user || pausedBy.lost || pausedBy.hidden; }

    function applyPhase() {
      if (state.phase === 'idle' || state.phase === 'ended') return;
      state.phase = anyPause() ? 'paused' : 'playing';
    }

    function setPause(reason, on) {
      if (state.phase === 'idle' || state.phase === 'ended') { pausedBy[reason] = on; return; }
      var was = anyPause();
      pausedBy[reason] = on;
      var now = anyPause();
      applyPhase();
      if (!was && now) emit({ type: 'pause', reason: reason });
      else if (was && !now) { acc = 0; emit({ type: 'resume' }); }
    }

    // ---- Spawning -----------------------------------------------------------
    function freeItem() {
      for (var i = 0; i < items.length; i++) if (!items[i].active) return items[i];
      return null;
    }

    function spawn(speed) {
      var it = freeItem();
      if (!it) return;
      var lane = rng.int(T.LANES);
      var kind = pickKind(rng, simTime, simTime, lane, lanes, consecutiveBads, T, diff);
      var bad = kind !== KIND.WAFER;
      var L = lanes[lane];
      L.lastAt = simTime; L.lastKind = kind;
      if (bad) { L.lastBadAt = simTime; consecutiveBads++; } else consecutiveBads = 0;

      it.active = true; it.kind = kind; it.bad = bad; it.state = 'fall'; it.lane = lane;
      it.baseX = spawnMinX + laneW * (lane + 0.5) + rng.range(-1, 1) * laneW * T.LANE_JITTER;
      it.swayAmp = rng.pick(T.SWAY_AMP); it.swayW = rng.pick(T.SWAY_HZ) * TWO_PI; it.swayPh = rng() * TWO_PI;
      it.rotBase = rng.pick(T.ROT_BASE); it.rotAmp = rng.pick(T.ROT_AMP); it.rotW = rng.pick(T.ROT_HZ) * TWO_PI; it.rotPh = rng() * TWO_PI;
      it.vy = speed; it.t = 0; it.ft = 0; it.alpha = 1; it.size = 1; it.resolved = false;
      it.x = it.px = it.baseX + Math.sin(it.swayPh) * it.swayAmp;
      it.y = it.py = T.SPAWN_Y;
      it.rot = it.prot = it.rotBase + Math.sin(it.rotPh) * it.rotAmp;
      emit({ type: 'spawn', kind: kind, lane: lane, t: simTime, x: it.baseX });
    }

    // ---- Effects ------------------------------------------------------------
    function addPopup(kind, x, y) {
      var p = null;
      for (var i = 0; i < popups.length; i++) if (!popups[i].active) { p = popups[i]; break; }
      if (!p) { // steal the oldest
        p = popups[0]; for (var j = 1; j < popups.length; j++) if (popups[j].t > p.t) p = popups[j];
      }
      p.active = true; p.kind = kind; p.x = x; p.y = y; p.t = 0;
      p.dur = kind === 'big' ? T.BIG_POPUP_SECONDS : T.POPUP_SECONDS;
    }

    /** Catch glow ring; rendered at the mug rim (follows the mug). */
    function addGlow() {
      for (var i = 0; i < glows.length; i++) if (!glows[i].active) { glows[i].active = true; glows[i].t = 0; return; }
    }

    function splash(y) {
      var n = reduced ? T.SPLASH_PARTICLES_REDUCED : T.SPLASH_PARTICLES;
      for (var i = 0, k = 0; i < particles.length && k < n; i++) {
        var p = particles[i];
        if (p.active) continue;
        p.active = true; k++;
        // x is stored RELATIVE to the mug so the splash travels with the cup.
        p.x = p.px = rng.range(-60, 60); p.y = p.py = y - 10;
        p.vx = rng.range(-1, 1) * T.SPLASH_SPREAD; p.vy = -rng.pick(T.SPLASH_SPEED);
        p.maxLife = p.life = rng.pick(T.PARTICLE_LIFE);
        p.piece = rng() < 0.3; p.size = rng.range(0.6, 1.25);
        p.rot = rng() * TWO_PI; p.rotV = rng.range(-6, 6);
      }
    }

    // ---- Resolution ---------------------------------------------------------
    function resolveCatch(it) {
      it.resolved = true; it.state = 'dunk'; it.ft = 0;
      state.caught++; state.score += 1; state.streak++;
      if (state.streak > state.bestStreak) state.bestStreak = state.streak;
      splash(T.MUG_RIM_Y);
      addGlow();
      var isStreak = T.STREAK_EVERY > 0 && state.streak % T.STREAK_EVERY === 0;
      if (isStreak) {
        state.score += T.STREAK_BONUS;
        addPopup('big', clamp(mug.x + 300, 260, T.STAGE_W - 240), T.MUG_RIM_Y - 300);
      } else {
        addPopup('plus', it.x, T.MUG_RIM_Y - 120);
      }
      emit({ type: 'catch', score: state.score, streak: state.streak, x: it.x });
      if (isStreak) emit({ type: 'streak', n: state.streak, score: state.score });
    }

    function resolveHit(it) {
      it.resolved = true; it.state = 'pop'; it.ft = 0;
      state.hits++; state.streak = 0;
      state.score = Math.max(0, state.score - T.HIT_PENALTY);
      stunT = T.STUN_SECONDS;
      if (T.SHOW_PENALTY_POPUP && T.HIT_PENALTY > 0) addPopup('minus', it.x, T.MUG_RIM_Y - 120);
      emit({ type: 'hit', kind: it.kind, score: state.score });
    }

    function resolveMiss(it) {
      it.resolved = true; it.state = 'fade';
      if (it.bad) { state.dodged++; emit({ type: 'dodge', kind: it.kind }); }
      else { state.missed++; state.streak = 0; emit({ type: 'miss' }); }
    }

    // ---- Fixed step ---------------------------------------------------------
    function step(dt) {
      simTime += dt;
      var sch = schedule(simTime, duration, T, diff);

      // Mug spring
      mug.px = mug.x;
      springStep(mug, mug.target, T.SPRING_OMEGA, dt);
      if (mug.x < T.MUG_MIN_X) { mug.x = T.MUG_MIN_X; if (mug.v < 0) mug.v = 0; }
      if (mug.x > T.MUG_MAX_X) { mug.x = T.MUG_MAX_X; if (mug.v > 0) mug.v = 0; }
      if (stunT > 0) stunT -= dt;

      // Spawning
      spawnTimer -= dt;
      if (spawnTimer <= 0) {
        var reachable = !T.SPAWN_ONLY_IF_REACHABLE || (duration - simTime) * sch.speed >= (T.MUG_RIM_Y - T.SPAWN_Y);
        if (reachable) spawn(sch.speed);
        spawnTimer = sch.interval * (1 + rng.range(-1, 1) * T.SPAWN_JITTER);
      }

      // Items
      var canCatch = !(T.STUN_BLOCKS_CATCH && stunT > 0);
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it.active) continue;
        it.px = it.x; it.py = it.y; it.prot = it.rot;
        it.t += dt;
        if (it.state === 'fall' || it.state === 'fade') {
          it.y += it.vy * dt;
          it.x = it.baseX + Math.sin(it.swayPh + it.t * it.swayW) * it.swayAmp;
          it.rot = it.rotBase + Math.sin(it.rotPh + it.t * it.rotW) * it.rotAmp;
          if (!it.resolved) {
            if (catchTest(it.x, it.y, mug.x, T)) {
              if (it.bad) { if (!(T.STUN_INVULNERABLE && stunT > 0)) resolveHit(it); }
              else if (canCatch) resolveCatch(it);
            }
            if (!it.resolved && it.y > T.MISS_Y) resolveMiss(it);
          }
          if (it.state === 'fade') {
            it.alpha = clamp(1 - (it.y - T.MISS_Y) / (T.KILL_Y - T.MISS_Y), 0, 1);
            if (it.y >= T.KILL_Y) it.active = false;
          }
        } else if (it.state === 'dunk') {
          it.ft += dt;
          var k = it.ft / T.DUNK_SECONDS;
          it.y += it.vy * 0.55 * dt;
          it.x = lerp(it.x, mug.x, Math.min(1, 10 * dt));
          it.alpha = clamp(1 - k, 0, 1);
          it.size = 1 - 0.25 * k;
          if (k >= 1) it.active = false;
        } else if (it.state === 'pop') {
          it.ft += dt;
          var kp = it.ft / T.POP_SECONDS;
          it.alpha = clamp(1 - kp, 0, 1);
          it.size = 1 + 0.5 * kp;
          if (kp >= 1) it.active = false;
        }
      }

      // Particles
      for (var p = 0; p < particles.length; p++) {
        var pt = particles[p];
        if (!pt.active) continue;
        pt.px = pt.x; pt.py = pt.y;
        pt.vy += T.GRAVITY * dt;
        pt.x += pt.vx * dt; pt.y += pt.vy * dt;
        pt.rot += pt.rotV * dt;
        pt.life -= dt;
        // Droplets that fall back below the rim vanish into the cocoa.
        if (pt.life <= 0 || (pt.vy > 0 && pt.y > T.MUG_RIM_Y + 30)) pt.active = false;
      }

      // Popups / glows
      for (var q = 0; q < popups.length; q++) if (popups[q].active && (popups[q].t += dt) >= popups[q].dur) popups[q].active = false;
      for (var g = 0; g < glows.length; g++) if (glows[g].active && (glows[g].t += dt) >= T.GLOW_SECONDS) glows[g].active = false;

      // Timer
      if (!final5Sent && duration - simTime <= T.FINAL_SECONDS) { final5Sent = true; emit({ type: 'final5', timeLeft: Math.max(0, duration - simTime) }); }
      if (simTime >= duration) finish(false);
    }

    /** Per-frame update: meta timers in real time, physics in fixed steps. */
    function update(frameDt) {
      if (destroyed) return;
      clock += frameDt;

      // Tracking lost -> auto pause after grace. Only during play.
      if (state.phase === 'playing' && lostAt >= 0 && !pausedBy.lost && clock - lostAt >= T.LOST_GRACE) {
        setPause('lost', true);
        emit({ type: 'lost' });
      }
      if (regainTimer > 0) {
        regainTimer -= frameDt;
        if (regainTimer <= 0) { regainTimer = 0; setPause('lost', false); }
      }

      if (state.phase === 'playing') {
        acc += frameDt;
        // Guard against the spiral of death: never simulate more than MAX_FRAME_DT per frame.
        if (acc > T.MAX_FRAME_DT) acc = T.MAX_FRAME_DT;
        while (acc >= T.DT && state.phase === 'playing') { step(T.DT); acc -= T.DT; }
      }
      updateDerived();
    }

    function finish(stopped) {
      if (state.phase === 'ended') return;
      state.phase = 'ended';
      simTime = Math.min(simTime, duration);
      stunT = 0;
      for (var i = 0; i < items.length; i++) items[i].active = false;
      for (var p = 0; p < particles.length; p++) particles[p].active = false;
      for (var q = 0; q < popups.length; q++) popups[q].active = false;
      updateDerived();
      var result = {
        score: state.score, caught: state.caught, missed: state.missed, hits: state.hits,
        bestStreak: state.bestStreak, durationPlayed: simTime, stopped: !!stopped, seed: seed
      };
      emit({ type: 'end', result: result });
      if (onEnd) { try { onEnd(result); } catch (e) { if (typeof console !== 'undefined') console.error(e); } }
    }

    // ---- Rendering ----------------------------------------------------------
    var drawCalls = 0;

    function blit(v, x, y, alpha, size) {
      if (alpha <= 0) return;
      if (alpha < 1) ctx.globalAlpha = alpha;
      if (size && size !== 1) {
        var w = v.w * size, h = v.h * size;
        ctx.drawImage(v.canvas, x - v.ox * size, y - v.oy * size, w, h);
      } else {
        ctx.drawImage(v.canvas, x - v.ox, y - v.oy, v.w, v.h);
      }
      if (alpha < 1) ctx.globalAlpha = 1;
      drawCalls++;
    }

    function drawItem(it, a) {
      var sp = sprites && sprites[it.kind];
      if (!sp) return;
      var x = lerp(it.px, it.x, a), y = lerp(it.py, it.y, a), rot = lerp(it.prot, it.rot, a);
      blit(sp.rotated(rot), x, y, it.alpha, it.size);
    }

    function render(a) {
      if (!ctx) return;
      drawCalls = 0;
      var W = T.STAGE_W, H = T.STAGE_H;
      ctx.clearRect(0, 0, W, H);
      if (state.phase === 'idle' && !sprites) return;

      var mugX = lerp(mug.px, mug.x, a);
      var bobY = Math.sin(clock * TWO_PI * T.MUG_BOB_HZ) * T.MUG_BOB_AMP;
      var shakeX = 0;
      if (stunT > 0) {
        var s = stunT / T.STUN_SECONDS;
        shakeX = Math.sin(clock * 90) * T.STUN_SHAKE_PX * s;
      }
      var rimY = T.MUG_RIM_Y;

      // 1. streak rays behind the mug
      if (raysTex && state.streak >= T.RAYS_MIN_STREAK && state.phase !== 'ended') {
        ctx.save();
        ctx.globalAlpha = 0.6;
        ctx.translate(mugX, rimY + 40);
        ctx.rotate(clock * 0.35);
        ctx.drawImage(raysTex.canvas, -raysTex.ox, -raysTex.oy, raysTex.w, raysTex.h);
        ctx.restore();
        drawCalls++;
      }

      // 2. items at/below the rim (behind the mug) — includes dunking wafers
      var i, it;
      for (i = 0; i < items.length; i++) {
        it = items[i];
        if (it.active && (it.y >= rimY || it.state === 'dunk')) drawItem(it, a);
      }

      // 3. mug
      var mugSp = sprites && sprites.mug;
      if (mugSp) blit(mugSp.rotated(0), mugX + shakeX, rimY + bobY, 1, 1);

      // 4. catch glow on the rim
      if (glowTex) for (i = 0; i < glows.length; i++) {
        var g = glows[i];
        if (!g.active) continue;
        var k = g.t / T.GLOW_SECONDS;
        blit(glowTex, mugX + shakeX, rimY + bobY, 0.85 * (1 - k), 0.7 + 0.5 * k);
      }

      // 5. items above the rim (in front of the mug)
      for (i = 0; i < items.length; i++) {
        it = items[i];
        if (it.active && !(it.y >= rimY || it.state === 'dunk')) drawItem(it, a);
      }

      // 6. particles
      var drop = sprites && sprites['splash-drop'], piece = sprites && sprites['wafer-piece'];
      for (i = 0; i < particles.length; i++) {
        var p = particles[i];
        if (!p.active) continue;
        var lf = p.life / p.maxLife;
        var al = lf < 0.3 ? lf / 0.3 : 1;
        var px = mugX + shakeX + lerp(p.px, p.x, a), py = lerp(p.py, p.y, a);
        if (p.piece && piece) blit(piece.rotated(p.rot), px, py, al, p.size);
        else if (drop) blit(drop.rotated(0), px, py, al, p.size);
      }

      // 7. popups
      if (text) for (i = 0; i < popups.length; i++) {
        var pp = popups[i];
        if (!pp.active) continue;
        var tt = pp.t / pp.dur;
        if (pp.kind === 'big') {
          var sc = tt < 0.25 ? easeOutBack(tt / 0.25) : 1;
          var fade = tt > 0.7 ? 1 - (tt - 0.7) / 0.3 : 1;
          blit(text.big, pp.x, pp.y - 30 * tt, fade, sc);
        } else {
          var rise = easeOutCubic(tt) * 110;
          var fd = tt > 0.55 ? 1 - (tt - 0.55) / 0.45 : 1;
          var scp = tt < 0.2 ? easeOutBack(tt / 0.2) : 1;
          blit(pp.kind === 'minus' ? text.minus : text.plus, pp.x, pp.y - rise, fd, scp);
        }
      }

      // 8. stun vignette
      if (vignette && stunT > 0 && !reduced) {
        var va = Math.min(1, stunT / T.STUN_SECONDS * 1.6) * 0.9;
        ctx.globalAlpha = va;
        ctx.drawImage(vignette.canvas, 0, 0, W, H);
        ctx.globalAlpha = 1;
        drawCalls++;
      }

      // stats
      var ni = 0, np = 0, nq = 0;
      for (i = 0; i < items.length; i++) if (items[i].active) ni++;
      for (i = 0; i < particles.length; i++) if (particles[i].active) np++;
      for (i = 0; i < popups.length; i++) if (popups[i].active) nq++;
      state.stats.items = ni; state.stats.particles = np; state.stats.popups = nq; state.stats.drawCalls = drawCalls;
    }

    // ---- Loop -----------------------------------------------------------------
    function frame(now) {
      if (destroyed) return;
      rafId = requestAnimationFrame(frame);
      var dt = lastFrame ? (now - lastFrame) / 1000 : 0;
      lastFrame = now;
      if (dt > T.MAX_FRAME_DT) dt = T.MAX_FRAME_DT;
      var t0 = perf.now();
      update(dt);
      render(state.phase === 'playing' ? acc / T.DT : 1);
      var ms = perf.now() - t0;
      state.stats.frameMs = ms;
      frameSamples++; frameAccumMs += dt * 1000;
      if (now - fpsWindowStart >= 500) {
        state.stats.fps = frameSamples > 1 ? Math.round(1000 / (frameAccumMs / frameSamples)) : 0;
        frameSamples = 0; frameAccumMs = 0; fpsWindowStart = now;
      }
      if (onTick) onTick(state);
      if (state.phase === 'ended') { cancelAnimationFrame(rafId); rafId = 0; }
    }

    function startLoop() {
      if (!autoLoop || rafId || destroyed) return;
      lastFrame = 0; fpsWindowStart = perf.now();
      rafId = requestAnimationFrame(frame);
    }

    function onVisibility() {
      if (document.hidden) { setPause('hidden', true); }
      else { lastFrame = 0; setPause('hidden', false); }
    }
    if (hasDoc) document.addEventListener('visibilitychange', onVisibility);

    // Draw the idle mug immediately so the page is never blank under the countdown.
    if (ctx) { updateDerived(); render(1); }

    // ---- Public API -----------------------------------------------------------
    var api = {
      /** Tracker input, 0..1 across the allowed mug range. */
      setTargetX: function (x01) {
        if (typeof x01 !== 'number' || x01 !== x01) return;
        x01 = clamp(x01, 0, 1);
        state.targetX01 = x01;
        mug.target = T.MUG_MIN_X + x01 * (T.MUG_MAX_X - T.MUG_MIN_X);
        if (state.phase === 'idle' && T.SPRING_SNAP_IDLE) { mug.x = mug.px = mug.target; mug.v = 0; updateDerived(); if (ctx && !rafId) render(1); }
      },
      /** Mug detection status from the tracker. */
      setTracking: function (found) {
        found = !!found;
        if (found === state.tracking) return;
        state.tracking = found;
        if (!found) { lostAt = clock; regainTimer = 0; }
        else {
          lostAt = -1;
          if (pausedBy.lost) { emit({ type: 'regained' }); regainTimer = T.REGAIN_DELAY; }
        }
      },
      start: function () {
        if (state.phase !== 'idle') return;
        state.phase = 'playing';
        pausedBy.user = false; pausedBy.lost = false;
        pausedBy.hidden = !!(hasDoc && document.hidden);
        acc = 0; lastFrame = 0;
        applyPhase();
        updateDerived();
        emit({ type: 'start', seed: seed });
        if (hasDoc && document.hidden) emit({ type: 'pause', reason: 'hidden' });
        startLoop();
      },
      pause: function () { setPause('user', true); },
      resume: function () { setPause('user', false); },
      /** End the round now (onEnd fires with durationPlayed < duration). */
      stop: function () { if (state.phase !== 'idle') finish(true); else { state.phase = 'ended'; } },
      destroy: function () {
        destroyed = true;
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        if (hasDoc) document.removeEventListener('visibilitychange', onVisibility);
        if (ctx) ctx.clearRect(0, 0, T.STAGE_W, T.STAGE_H);
      },
      getState: function () { return state; },
      /** Headless/manual stepping: advance real time by `seconds` (no rAF). */
      advance: function (seconds) {
        var left = seconds;
        while (left > 0) { var d = Math.min(left, T.MAX_FRAME_DT); update(d); left -= d; }
        if (ctx && !rafId) render(1);
        return state;
      },
      /** Render one frame now (used by advance() callers that drive their own loop). */
      render: function () { render(state.phase === 'playing' ? acc / T.DT : 1); if (onTick) onTick(state); },
      /** Debug: snapshot of active items (allocates; not for the hot path). */
      getItems: function () {
        var out = [];
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (it.active) out.push({ kind: it.kind, bad: it.bad, state: it.state, lane: it.lane, x: it.x, y: it.y, vy: it.vy, resolved: it.resolved });
        }
        return out;
      },
      /** Count of active items (no allocation). */
      activeItems: function () { var n = 0; for (var i = 0; i < items.length; i++) if (items[i].active) n++; return n; },
      tuning: T,
      seed: seed
    };
    return api;
  }

  root.DunkGame = {
    create: create,
    TUNING: TUNING,
    KIND: KIND,
    BAD_KINDS: BAD_KINDS,
    internals: { createRng: createRng, springStep: springStep, schedule: schedule, catchTest: catchTest, pickKind: pickKind }
  };
})(typeof window !== 'undefined' ? window : this);
