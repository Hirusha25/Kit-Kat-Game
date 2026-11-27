/* DunkGame — engine for "KitKat Dunk the Break" (kiosk catch game).
 *
 *   const game = DunkGame.create({
 *     canvas,            // 1080x1920 transparent canvas (null => headless, for tests)
 *     sprites,           // result of DunkSprites.load(manifest)
 *     duration: 40,      // seconds of play
 *     difficulty: 'normal',   // 'easy' | 'normal' | 'hard'
 *     reducedEffects: false,  // fewer particles, no rays / trails / speed lines / vignette
 *     seed: 1234,        // optional; same seed => same spawn sequence
 *     onTick(state), onEvent(evt), onEnd(result)
 *   });
 *   game.setTargetX(x01); game.setTracking(found);
 *   game.start(); game.pause(); game.resume(); game.stop(); game.destroy();
 *   game.getState();      // live, read-only state object (see STATE below)
 *
 * Events (onEvent): start, spawn{kind,cls,bad,lane,t,x,pattern}, pattern{name,t},
 *   catch{kind:'wafer'|'gold',points,score,streak,x}, streak{n,score}, miss{kind},
 *   hit{kind,score}, dodge{kind}, final10{timeLeft}, final5{timeLeft}, pause{reason},
 *   resume, lost, regained, end{result}.
 *
 * Design notes (RK3566 / Mali-G52 kiosk, Chrome, weak GPU):
 *  - one requestAnimationFrame loop, fixed-timestep physics (1/120 s accumulator)
 *    with render interpolation; the loop pauses when document.hidden.
 *  - everything blitted is pre-rendered (sprites, popups, vignette, glows, rays,
 *    speed lines, combo text, hazard fragments); no per-frame gradients,
 *    shadowBlur, filters or text layout. Only the mug and the hazard fragments
 *    use a per-frame canvas transform (one drawImage each).
 *  - object pools for items / particles / popups / glows / fragments; zero per-frame
 *    allocation on the hot path (the state object is mutated in place).
 *  - all gameplay numbers live in TUNING at the top of this file.
 *  - the gameplay sim is deterministic for a given seed when stepped with advance();
 *    effects use their own PRNG, so reducedEffects never changes a round.
 *
 * Only `window.DunkGame` is exported. `DunkGame.internals` exposes the pure parts
 * (PRNG, spring, schedule, catch test, kind pickers) for unit tests.
 */
(function (root) {
  'use strict';

  /* ================================================================== */
  /*  TUNING — every gameplay/feel constant. Units: px, s, px/s, deg.    */
  /* ================================================================== */
  var TUNING = {
    STAGE_W: 1080,
    STAGE_H: 1920,

    DT: 1 / 120,            // fixed physics step
    MAX_FRAME_DT: 0.1,      // clamp for a long frame (tab switch, GC pause)

    // --- Mug / layout. mug.png is drawn 560 px wide (manifest); the rim/drink
    //     centre is the sprite anchor and sits at MUG_RIM_Y. The body bottom is
    //     382 px below the rim, so 1180 keeps it above the slider at y 1575.
    MUG_MIN_X: 240,         // mug centre range
    MUG_MAX_X: 840,
    MUG_RIM_Y: 1150,        // y of the drink surface / rim centre
    MUG_HALF_WIDTH: 240,    // half of the 480 px mug sprite
    CATCH_HALF_FRAC: 0.55,  // catch window = MUG_HALF_WIDTH * this (132 px = the drink surface, no edge catches)
    CATCH_BAND: 44,         // item centre must be within rim y +/- this
    MUG_BOB_AMP: 4,         // idle bob (px) — cosmetic
    DRINK_RX: 128,          // drink surface ellipse inside the mug sprite (logical px, centred on the rim anchor)
    DRINK_RY: 36,
    DRINK_ROW: 2,           // row height for the liquid displacement (px)
    DRINK_SLOSH_PX: 34,     // max horizontal shear of the surface from a hard move
    DRINK_TILT_PX: 14,      // the liquid level rises on one side and drops on the other by up to this (px at the rim)
    DRINK_WAVE_PX: 2.6,     // travelling vertical ripple across the surface
    DRINK_COL: 3,           // column width for the vertical displacement (px)
    DRINK_SLOSH_K: 55,      // slosh spring stiffness / damping (liquid swings then settles)
    DRINK_SLOSH_C: 6,
    DRINK_SLOSH_GAIN: 0.0075,// mug acceleration (px/s^2) -> slosh drive
    DRINK_RIPPLE_PX: 3.6,   // always-on ripple so the drink never looks frozen
    DRINK_RIPPLE_HZ: 0.9,
    DRINK_TREMBLE_PX: 1.5,  // fine fast shimmer on top
    MUG_BOB_HZ: 0.8,
    MUG_TILT_MAX: 6,        // deg; lean into the direction of motion
    MUG_TILT_SPEED: 900,    // mug velocity (px/s) that gives the full tilt
    MUG_TILT_SMOOTH: 9,     // 1/s; tilt follows velocity with this rate
    MUG_RECOIL_PX: 22,      // sideways jolt away from a hazard on hit
    MUG_RECOIL_TILT: 7,     // deg kick on hit
    MUG_RECOIL_SECONDS: 0.4,
    MUG_WOBBLE_SECONDS: 0.8,// after a hit the mug rocks side to side, decaying
    MUG_WOBBLE_DEG: 9,
    MUG_WOBBLE_HZ: 2.8,
    HIT_SLOSH_KICK: 24,     // drink slosh velocity kick on a hit
    MUG_SHADOW_DROP: 336,   // px below the rim where the shadow ellipse sits (just under the mug base)
    MUG_SHADOW_W: 378,      // shadow ellipse size at rest (px)
    MUG_SHADOW_H: 68,
    MUG_SHADOW_ALPHA: 0.9,
    ITEM_SHADOW_DX: 22,     // falling-item drop shadow offset (px, down-left)
    ITEM_SHADOW_DY: 34,
    ITEM_SHADOW_ALPHA: 0.42,
    ITEM_SHADOW_BLUR: 7,    // px; soft edge so the shadow reads as depth, not a copy
    SPLASH_FRAME_SECONDS: 0.4, // mug-splash sprite shown this long after a catch
    SPLASH_SQUASH: 0.06,    // 1.0 -> 1.06 -> 1.0 width squash at the start of the splash

    // --- Mug follow spring (critically damped). Higher = snappier.
    SPRING_OMEGA: 30,       // rad/s; settles ~95% in ~0.15 s (snappier follow of the tracker)
    SPRING_SNAP_IDLE: true, // before start() the mug snaps to the tracker

    // --- Spawning
    SPAWN_Y: -220,          // item centre y at spawn (above the stage)
    MISS_Y: 1330,           // a wafer passing this y is a miss; items fade from here
    KILL_Y: 1540,           // item fully gone (mug bottom; never over the slider)
    LANES: 5,               // spawn lanes across the mug range
    LANE_JITTER: 0.25,      // +/- fraction of lane width
    SPAWN_PAD: 115,         // widen the spawn range beyond the mug range by this many px per side
                            // (keep < MUG_HALF_WIDTH*CATCH_HALF_FRAC so edge items stay catchable)
    SPEED_START: 560,       // fall speed ramps linearly over the round
    SPEED_END: 1120,
    SPAWN_START: 0.85,      // spawn interval ramps linearly over the round
    SPAWN_END: 0.38,
    SPAWN_JITTER: 0.15,     // +/- fraction of the interval
    WAFERS_ONLY_SECONDS: 1.5, // warm-up: only wafers (just the first couple of items)
    MIX: { wafer: 0.48, hazard: 0.52 }, // after warm-up (hazard weight x DIFFICULTY.bad)
    HAZARD_AT_MUG: 0.6,    // share of hazards aimed at the lane the mug is in right now (forces a dodge)
    WAFER_AWAY: 0.70,       // share of wafers sent to a lane other than the mug's (forces a move)
    GOLD_SHARE: 0.088,      // per regular spawn; with doubles and crossfires this lands near 6 % of all spawns ...
    GOLD_AFTER_SECONDS: 5,  // ... after this many seconds
    GOLD_SCORE: 3,
    // --- Bonus pick-ups (good items that are not wafers). The gold stopwatch adds seconds to the clock.
    BONUS_TIME_SECONDS: 5,
    BONUS_AFTER_SECONDS: 8, // first one no earlier than this ...
    BONUS_LAST_SECONDS: 8,  // ... and none inside the final N seconds
    BONUS_SHARE: 0.06,      // per regular spawn
    BONUS_FORCE_AT: 14,     // if none has appeared by now, the next regular spawn is the stopwatch (every round sees one)
    BONUS_MAX_PER_ROUND: 2,
    FRAME_FLIP_HZ: 2.6,     // two-frame icons ("<kind>-on" sprite present) cross-fade at this rate
    BONUS_FLIP_HZ: 1.4,
    HAZARDS: ['alarm', 'deadline', 'phone', 'inbox'], // rotated, no immediate repeat (reference set)
    HAZARD_FALLBACK: ['alarm', 'deadline'], // used when none of HAZARDS loaded (vector fallbacks exist)
    BAD_LANE_COOLDOWN: 0.6, // no hazard in a lane within this of the previous hazard there
    MAX_CONSECUTIVE_BADS: 3,// global: never more than N hazards in a row
    SPAWN_ONLY_IF_REACHABLE: true, // stop spawning once an item could not reach the rim

    // --- Patterns
    CROSSFIRE_AFTER: 6,     // from this time: a hazard + a wafer CROSSFIRE_GAP apart in adjacent lanes
    CROSSFIRE_EVERY: 4.5,   // seconds between crossfires (+/- CROSSFIRE_JITTER)
    CROSSFIRE_JITTER: 0.2,
    CROSSFIRE_GAP: 0.25,
    DOUBLE_AFTER: 2,        // from this time: occasional two wafers DOUBLE_GAP apart in adjacent lanes
    DOUBLE_CHANCE: 0.16,    // per regular spawn
    DOUBLE_GAP: 0.2,

    // --- Item motion
    SWAY_AMP: [8, 34],      // px, random per item
    SWAY_HZ: [0.45, 0.85],
    ROT_AMP: [0.08, 0.25],  // rad, slow sway around the base angle
    ROT_HZ: [0.2, 0.45],
    ROT_BASE: [0.45, 0.75], // rad (≈26–43°); sign is random per item — the diagonal tumble (hazards)
    WAFER_ROT_BASE: 0.22,   // wafers swing about the vertical: base +/- this (rad), broken end down
    WAFER_ROT_AMP: [0.28, 0.5],
    WAFER_ROT_HZ: [0.25, 0.45],
    WAFER_ALIGN_PX: 420,    // over the last N px above the rim a wafer straightens so the broken end goes in first
    WAFER_ALIGN: 0.85,      // how fully it straightens (1 = perfectly vertical)
    DUNK_SECONDS: 0.35,     // caught wafer sinks behind the mug
    MISS_FADE_SECONDS: 0.6, // a wafer that passes the mug slows, blinks and vanishes over this long
    MISS_FADE_SPEED: 0.3,   // its fall speed during the fade (fraction of the fall speed)
    MISS_BLINKS: 2,         // blink cycles during the fade
    HAZARD_PULSE_HZ: 2.6,   // warning ring + blink rate on hazards
    HAZARD_RING_ALPHA: 0.85,
    HAZARD_JITTER_PX: 3,    // nervous shake of a hazard as it falls
    HAZARD_BLINK_MIN: 0.7,  // hazard alpha dips to this at the bottom of each blink
    POP_SECONDS: 0.12,      // hit hazard flashes out (its fragments carry on)

    // --- Scoring
    STREAK_EVERY: 3,
    STREAK_BONUS: 1,
    HIT_PENALTY: 1,
    STUN_SECONDS: 1.2,
    STUN_BLOCKS_CATCH: false, // true => wafers pass through while stunned
    STUN_INVULNERABLE: true,  // no second hit while stunned
    FINAL_SECONDS: 5,         // 'final5' event
    FINAL_FX_SECONDS: 10,     // 'final10' event; speed lines + stronger rays from here

    // --- Tracking
    LOST_GRACE: 2.0,        // s without the mug before auto-pause
    REGAIN_DELAY: 0.5,      // s after regain before play resumes

    // --- Pools
    ITEM_POOL: 16,
    PARTICLE_POOL: 140,
    POPUP_POOL: 8,
    GLOW_POOL: 4,
    FLASH_POOL: 3,
    FRAGMENT_POOL: 12,      // 4 per hazard hit

    // --- Catch effects
    SPLASH_PARTICLES: 30,   // splash-drop droplets per catch (reducedEffects: SPLASH_PARTICLES_REDUCED)
    SPLASH_PARTICLES_REDUCED: 8,
    SPLASH_CRUMBS: 5,       // wafer-piece crumbs per catch
    SPLASH_SPEED: [300, 760],
    SPLASH_SPREAD: 420,     // horizontal speed +/-
    SPLASH_SPIN: 9,         // rad/s +/- for droplets and crumbs
    GRAVITY: 2000,
    PARTICLE_LIFE: [0.45, 0.9],
    GOLD_BURST: 9,          // sparkle.png particles on a gold catch
    GOLD_TRAIL_EVERY: 0.05, // s between trail sparkles behind a falling gold wafer
    POPUP_SECONDS: 0.9,
    BIG_POPUP_SECONDS: 1.3,
    POPUP_POP: 1.35,        // "+1" overshoot scale
    GLOW_SECONDS: 0.35,     // gold ring pulse
    FLASH_SECONDS: 0.22,    // radial flash on catch
    SHOW_PENALTY_POPUP: true,

    // --- Hit effects
    SHAKE_SECONDS: 0.35,
    SHAKE_PX: 14,
    FRAGMENT_SECONDS: 0.6,
    FRAGMENT_SPEED: [220, 420],
    FRAGMENT_SPIN: 9,
    VIGNETTE_RES: 0.25,     // pre-rendered vignette resolution (fraction of stage)

    // --- Ambience
    TRAIL_GHOSTS: 3,        // motion-trail copies behind each falling item (reduced: 1)
    STREAK_MIN_SPEED: 350,  // light streak fades in from this fall speed
    STREAK_LENGTH: 1.45,    // streak length multiplier (1 = texture height)
    STREAK_ALPHA: 1.0,
    TRAIL_SPACING: 0.03,    // s of travel between ghosts
    TRAIL_ALPHA: 0.34,      // first ghost alpha at full speed
    TRAIL_MIN_SPEED: 300,   // trails fade in from this fall speed to SPEED_END
    ITEM_GLOW_ALPHA: 0,     // no halo under items (3D shadow instead)
    RAYS_MIN_STREAK: 3,     // rays brighten from this streak ...
    RAYS_FULL_STREAK: 7,    // ... and reach RAYS_MAX_ALPHA here
    RAYS_IDLE_ALPHA: 0.07,  // kept faint: the gold rays sit outside the brand red
    RAYS_MAX_ALPHA: 0.28,
    RAYS_ROT_SPEED: 0.12,   // rad/s
    RAYS_Y_OFFSET: 150,     // ray origin this far above the rim
    RAYS_RADIUS: 600,
    SPEEDLINES_SPEED: 820,  // px/s scroll of the light beams (times 0.5..0.85 over the round)
    SPEEDLINES_ALPHA: 0.55,
    SPEEDLINES_IDLE: 0,     // background falling light lines are off (read as rain); items keep their own streaks
    SPEEDLINE_COUNT: 46,    // streak blits per frame
    MOTES: 7,               // ambient sparkle motes (0 in reducedEffects)
    MOTE_ALPHA: 0.5,
    MOTE_SPEED: [22, 48],   // px/s upwards
    COMBO_MIN_STREAK: 3,    // "xN STREAK" meter from this streak ...
    COMBO_Y_OFFSET: 22,     // ... drawn this far below the rim centre (on the drink surface, under the splash crown)

    // multipliers: fall speed, spawn interval, hazard weight, crossfire cadence (CROSSFIRE_EVERY x this)
    DIFFICULTY: {
      easy:   { speed: 0.85, spawn: 1.20, bad: 0.70, crossfire: 1.6 },
      normal: { speed: 1.00, spawn: 1.00, bad: 1.00, crossfire: 1.0 },
      hard:   { speed: 1.15, spawn: 0.85, bad: 1.30, crossfire: 0.7 }
    }
  };

  // Sprite names. 'alarm'/'deadline' kept as named constants for backwards compatibility.
  var KIND = { WAFER: 'wafer', GOLD: 'gold', ALARM: 'alarm', DEADLINE: 'deadline', PHONE: 'phone', INBOX: 'inbox', BONUS_TIME: 'bonus-time' };
  // Item classes (what the rules care about). Hazard items carry their sprite name in `kind`.
  var CLS = { WAFER: 'wafer', GOLD: 'gold', HAZARD: 'hazard', BONUS: 'bonus' };
  var BAD_KINDS = TUNING.HAZARDS.slice();
  var TWO_PI = Math.PI * 2, DEG = Math.PI / 180;

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

  /** One semi-implicit Euler step of a critically damped spring. Mutates s = { x, v }. */
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
   * Choose the class ('wafer' | 'gold' | 'hazard') for a regular spawn.
   * `lanes[lane].lastBadAt` is the sim time of the previous hazard in that lane;
   * `consecutiveBads` is the global run.
   */
  function pickKind(rng, elapsed, now, lane, lanes, consecutiveBads, T, diff) {
    T = T || TUNING; diff = diff || TUNING.DIFFICULTY.normal;
    if (elapsed < T.WAFERS_ONLY_SECONDS) return CLS.WAFER;
    if (elapsed >= T.GOLD_AFTER_SECONDS && rng() < T.GOLD_SHARE) return CLS.GOLD;
    var wW = T.MIX.wafer, wH = T.MIX.hazard * diff.bad;
    var cls = rng() * (wW + wH) < wW ? CLS.WAFER : CLS.HAZARD;
    if (cls === CLS.HAZARD) {
      if (now - lanes[lane].lastBadAt < T.BAD_LANE_COOLDOWN) return CLS.WAFER;
      if (consecutiveBads >= T.MAX_CONSECUTIVE_BADS) return CLS.WAFER;
    }
    return cls;
  }

  /** Uniform pick from `list` excluding `last` (no immediate repeat). */
  function pickHazard(rng, list, last) {
    if (list.length === 1) return list[0];
    var i = rng.int(list.length - 1);
    var k = list[i];
    if (k === last) k = list[list.length - 1];
    return k;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOutCubic(t) { t = 1 - t; return 1 - t * t * t; }
  function easeOutBack(t, c) { c = c || 1.70158; t -= 1; return 1 + t * t * ((c + 1) * t + c); }

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
    // "+3" (gold wafer)
    var s4 = makeCanvas(220 * scale, 150 * scale), c4 = s4.getContext('2d');
    c4.scale(scale, scale); fillGoldText(c4, '+3', 110, 75, 108, true);
    out.plus3 = { canvas: s4, w: 220, h: 150, ox: 110, oy: 75 };
    // "+5s" (time bonus)
    var s5 = makeCanvas(260 * scale, 150 * scale), c5 = s5.getContext('2d');
    c5.scale(scale, scale); fillGoldText(c5, '+' + TUNING.BONUS_TIME_SECONDS + 's', 130, 75, 96, true);
    out.time = { canvas: s5, w: 260, h: 150, ox: 130, oy: 75 };
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

  /** "xN STREAK" combo meter, rasterised once per streak value. */
  function buildComboText(n, scale) {
    var w = 360, h = 90;
    var c = makeCanvas(w * scale, h * scale), ctx = c.getContext('2d');
    ctx.scale(scale, scale);
    fillGoldText(ctx, 'x' + n + ' STREAK', w / 2, h / 2, 46, true);
    return { canvas: c, w: w, h: h, ox: w / 2, oy: h / 2 };
  }

  function buildVignette(scale) {
    var W = TUNING.STAGE_W, H = TUNING.STAGE_H, res = TUNING.VIGNETTE_RES;
    var c = makeCanvas(W * res, H * res), ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(c.width / 2, c.height / 2, c.height * 0.25, c.width / 2, c.height / 2, c.height * 0.62);
    g.addColorStop(0, 'rgba(120,0,14,0)'); g.addColorStop(0.55, 'rgba(150,0,18,0.45)'); g.addColorStop(1, 'rgba(70,0,8,0.92)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, c.width, c.height);
    return { canvas: c, w: W, h: H };
  }

  /** Gold ring pulse on the rim. */
  function buildGlow(scale) {
    var R = 200;
    var c = makeCanvas(R * 2 * scale, R * 2 * scale), ctx = c.getContext('2d');
    ctx.scale(scale, scale);
    var g = ctx.createRadialGradient(R, R, R * 0.45, R, R, R);
    g.addColorStop(0, 'rgba(255,220,120,0)'); g.addColorStop(0.55, 'rgba(255,215,110,0.85)');
    g.addColorStop(0.75, 'rgba(255,240,190,0.6)'); g.addColorStop(1, 'rgba(255,200,80,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(R, R, R, 0, TWO_PI); ctx.fill();
    return { canvas: c, w: R * 2, h: R * 2, ox: R, oy: R };
  }

  /** Soft elliptical ground shadow for the mug (drawn stretched/offset per frame). */
  function buildShadow(scale) {
    var W = 320, H = 90, res = 0.5 * scale;
    var c = makeCanvas(W * res, H * res), ctx = c.getContext('2d');
    ctx.scale(res, res);
    var g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W / 2);
    g.addColorStop(0, 'rgba(50,0,4,0.62)'); g.addColorStop(0.45, 'rgba(50,0,4,0.40)'); g.addColorStop(0.8, 'rgba(50,0,4,0.12)'); g.addColorStop(1, 'rgba(50,0,4,0)');
    ctx.fillStyle = g; ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(1, H / W); ctx.beginPath(); ctx.arc(0, 0, W / 2, 0, TWO_PI); ctx.fill(); ctx.restore();
    return { canvas: c, w: W, h: H, ox: W / 2, oy: H / 2 };
  }

  /** Dark silhouette of a sprite view, cached on the view, for a cheap drop shadow under falling items. */
  function silhouette(v) {
    if (v.shadow) return v.shadow;
    // dark copy of the sprite, softened by stacking it at small offsets (no ctx.filter: Safari lacks it)
    var res = v.canvas.width / v.w, b = TUNING.ITEM_SHADOW_BLUR, pad = Math.ceil(b * 2 * res);
    var c = makeCanvas(v.canvas.width + pad * 2, v.canvas.height + pad * 2), ctx = c.getContext('2d');
    var taps = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];
    ctx.globalAlpha = 1 / taps.length;
    for (var i = 0; i < taps.length; i++) ctx.drawImage(v.canvas, pad + taps[i][0] * b * res, pad + taps[i][1] * b * res);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = 'rgba(40,0,6,1)'; ctx.fillRect(0, 0, c.width, c.height);
    v.shadow = { canvas: c, w: v.w + 2 * pad / res, h: v.h + 2 * pad / res, ox: v.ox + pad / res, oy: v.oy + pad / res };
    return v.shadow;
  }

  /** Soft radial disc (item glow / catch flash). Rendered at half resolution. */
  function buildRadial(R, stops, scale) {
    var res = 0.5 * scale;
    var c = makeCanvas(R * 2 * res, R * 2 * res), ctx = c.getContext('2d');
    ctx.scale(res, res);
    var g = ctx.createRadialGradient(R, R, 0, R, R, R);
    for (var i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, R * 2, R * 2);
    return { canvas: c, w: R * 2, h: R * 2, ox: R, oy: R };
  }

  function buildItemGlows(scale) {
    return {
      wafer: buildRadial(190, [[0, 'rgba(255,225,150,0.95)'], [0.4, 'rgba(255,200,90,0.5)'], [1, 'rgba(255,170,60,0)']], scale),
      gold: buildRadial(230, [[0, 'rgba(255,245,190,1)'], [0.35, 'rgba(255,215,100,0.6)'], [1, 'rgba(255,190,60,0)']], scale),
      // hazards: hot orange-white core so the halo still reads on the red stage
      hazard: buildRadial(165, [[0, 'rgba(255,170,110,0.95)'], [0.4, 'rgba(255,80,40,0.5)'], [1, 'rgba(255,40,30,0)']], scale)
    };
  }

  /** Warm light streak drawn behind a falling item (bright at the item, fading up its path). */
  function buildItemStreak(w, h, rgb, scale) {
    var res = 0.5 * scale;
    var c = makeCanvas(w * res, h * res), ctx = c.getContext('2d');
    ctx.scale(res, res);
    var g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(' + rgb + ',0)'); g.addColorStop(0.55, 'rgba(' + rgb + ',0.22)'); g.addColorStop(0.85, 'rgba(' + rgb + ',0.75)'); g.addColorStop(1, 'rgba(' + rgb + ',0.95)');
    ctx.fillStyle = g;
    // soft sides: three overlapping lanes narrower toward the centre
    ctx.globalAlpha = 0.35; ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 0.5; ctx.fillRect(w * 0.2, 0, w * 0.6, h);
    ctx.globalAlpha = 1; ctx.fillRect(w * 0.38, 0, w * 0.24, h);
    return { canvas: c, w: w, h: h, ox: w / 2, oy: h };
  }
  function buildStreaks(scale) {
    return {
      wafer: buildItemStreak(70, 420, '255,205,120', scale),
      gold: buildItemStreak(90, 520, '255,235,150', scale),
      hazard: buildItemStreak(70, 360, '255,120,70', scale)
    };
  }

  function buildFlash(scale) {
    return buildRadial(240, [[0, 'rgba(255,255,235,1)'], [0.25, 'rgba(255,235,170,0.8)'], [0.6, 'rgba(255,200,90,0.3)'], [1, 'rgba(255,190,80,0)']], scale);
  }

  /** Warm gold light rays from a point; one texture, rotated slowly per frame. */
  function buildRays(scale) {
    var R = TUNING.RAYS_RADIUS, n = 18, res = 0.5 * scale;
    var c = makeCanvas(R * 2 * res, R * 2 * res), ctx = c.getContext('2d');
    ctx.scale(res, res); ctx.translate(R, R);
    var rng = createRng(4242);
    var g = ctx.createRadialGradient(0, 0, R * 0.05, 0, 0, R);
    g.addColorStop(0, 'rgba(255,225,150,0.7)'); g.addColorStop(0.35, 'rgba(255,205,110,0.42)'); g.addColorStop(1, 'rgba(255,190,80,0)');
    ctx.fillStyle = g;
    for (var i = 0; i < n; i++) {
      var a = (i / n) * TWO_PI + rng.range(-0.08, 0.08), hw = rng.range(0.035, 0.11);
      ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a - hw) * R, Math.sin(a - hw) * R);
      ctx.lineTo(Math.cos(a + hw) * R, Math.sin(a + hw) * R);
      ctx.closePath(); ctx.fill();
    }
    // soft bloom at the origin
    var b = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.35);
    b.addColorStop(0, 'rgba(255,235,180,0.55)'); b.addColorStop(1, 'rgba(255,220,150,0)');
    ctx.fillStyle = b; ctx.beginPath(); ctx.arc(0, 0, R * 0.35, 0, TWO_PI); ctx.fill();
    return { canvas: c, w: R * 2, h: R * 2, ox: R, oy: R };
  }

  /**
   * Speed lines for the final seconds: ONE soft streak sprite (white + gold variant)
   * blitted SPEEDLINE_COUNT times at scrolling positions. Small blits are far cheaper
   * than a full-stage scrolling layer, on the GPU and on a software rasteriser alike.
   */
  function buildStreak(scale, gold) {
    var w = 12, h = 512, res = 0.5 * scale;
    var c = makeCanvas(w * res, h * res), ctx = c.getContext('2d');
    ctx.scale(res, res);
    var col = gold ? '255,214,130' : '255,236,205'; // warm gold / warm cream (reference light streaks)
    var g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(' + col + ',0)'); g.addColorStop(0.5, 'rgba(' + col + ',1)'); g.addColorStop(1, 'rgba(' + col + ',0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    var hg = ctx.createLinearGradient(0, 0, w, 0);
    hg.addColorStop(0, 'rgba(0,0,0,0)'); hg.addColorStop(0.5, 'rgba(0,0,0,1)'); hg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'destination-in'; ctx.fillStyle = hg; ctx.fillRect(0, 0, w, h);
    return { canvas: c, w: w, h: h };
  }

  function buildSpeedLines(scale) {
    var rng = createRng(777), lines = [];
    for (var i = 0; i < TUNING.SPEEDLINE_COUNT; i++) {
      lines.push({ x: rng.range(10, TUNING.STAGE_W - 10), ph: rng(), len: rng.range(320, 980), w: rng.range(6, 26), a: rng.range(0.25, 0.8), gold: rng() < 0.65 });
    }
    return { white: buildStreak(scale, false), gold: buildStreak(scale, true), lines: lines };
  }

  /** Four quadrants of a hazard sprite (shatter fragments), anchored at their centres. */
  function buildFragments(sprite) {
    var out = [], hw = sprite.w / 2, hh = sprite.h / 2, s = sprite.scale;
    for (var q = 0; q < 4; q++) {
      var qx = q % 2, qy = q >> 1;
      var c = makeCanvas(hw * s, hh * s), ctx = c.getContext('2d');
      ctx.drawImage(sprite.canvas, qx * hw * s, qy * hh * s, hw * s, hh * s, 0, 0, hw * s, hh * s);
      // offset of the quadrant centre from the sprite anchor (logical px)
      out.push({ canvas: c, w: hw, h: hh, ox: hw / 2, oy: hh / 2, dx: qx * hw + hw / 2 - sprite.ax, dy: qy * hh + hh / 2 - sprite.ay });
    }
    return out;
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
    var duration = opts.duration > 0 ? +opts.duration : 40;
    var diff = T.DIFFICULTY[opts.difficulty] || T.DIFFICULTY.normal;
    var reduced = !!opts.reducedEffects;
    var onTick = typeof opts.onTick === 'function' ? opts.onTick : null;
    var onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    var onEnd = typeof opts.onEnd === 'function' ? opts.onEnd : null;
    var autoLoop = opts.autoLoop !== false && !!canvas && typeof requestAnimationFrame === 'function';
    var seed = (opts.seed === undefined || opts.seed === null) ? ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0) : (opts.seed >>> 0);
    var rng = createRng(seed);                     // gameplay
    var frng = createRng((seed ^ 0x5bd1e995) >>> 0); // effects only (never touches gameplay)
    var scale = sprites && sprites.$scale ? sprites.$scale : (canvas ? canvas.width / T.STAGE_W : 1);

    var hasDoc = typeof document !== 'undefined' && document && typeof document.addEventListener === 'function';
    var perf = (typeof performance !== 'undefined' && performance.now) ? performance : { now: function () { return Date.now(); } };

    // Hazard rotation: whichever of TUNING.HAZARDS actually loaded (headless: all).
    var hazards = T.HAZARDS.filter(function (n) { return !sprites || (sprites[n] && sprites[n].fromImage); });
    if (!hazards.length) hazards = T.HAZARD_FALLBACK.slice();

    // ---- Public, live state (mutated in place; never replaced) ---------
    var state = {
      phase: 'idle',          // 'idle' | 'playing' | 'paused' | 'ended'
      timeLeft: duration,
      elapsed: 0,
      score: 0,
      streak: 0,
      bestStreak: 0,
      caught: 0,
      gold: 0,                // gold wafers caught (included in caught)
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
      hazards: hazards.slice(),
      stats: { items: 0, particles: 0, popups: 0, drawCalls: 0, frameMs: 0, fps: 0 }
    };

    // ---- Internal sim state ---------------------------------------------
    var mug = { x: state.mugX, v: 0, px: state.mugX, target: state.mugX };
    var acc = 0;                 // physics accumulator
    var simTime = 0;             // sim seconds while playing (== elapsed)
    var clock = 0;               // real seconds since create (runs while paused)
    var spawnTimer = 0.6;        // first item shortly after start
    var consecutiveBads = 0;
    var lastHazard = null;
    var nextCrossfireAt = T.CROSSFIRE_AFTER;
    var stunT = 0;
    var finalSent = false, final10Sent = false;
    var pausedBy = { user: false, lost: false, hidden: false };
    var lostAt = -1;             // clock when tracking was lost (-1 = tracking)
    var regainTimer = 0;
    var destroyed = false;
    var rafId = 0;
    var lastFrame = 0;
    var frameSamples = 0, frameAccumMs = 0, fpsWindowStart = 0;

    // cosmetic timers (real time)
    var splashT = 0, shakeT = 0, recoilT = 0, recoilDir = 1, tilt = 0, comboPulse = 0, comboN = 0;
    var sloshX = 0, sloshV = 0, prevMugV = 0; // drink surface slosh (damped oscillator driven by mug acceleration)
    var wobbleT = 0;                             // post-hit rocking
    var bonusSpawned = 0;                        // bonus pick-ups spawned this round
    var raysX = T.STAGE_W / 2; // rays are pinned to the stage centre and only rotate

    var lanes = [];
    for (var li = 0; li < T.LANES; li++) lanes.push({ lastBadAt: -Infinity, lastAt: -Infinity, lastKind: null });
    var spawnMinX = T.MUG_MIN_X - T.SPAWN_PAD;
    var laneW = (T.MUG_MAX_X - T.MUG_MIN_X + 2 * T.SPAWN_PAD) / T.LANES;

    // ---- Pools --------------------------------------------------------------
    function makeItem() {
      return { active: false, kind: KIND.WAFER, cls: CLS.WAFER, bad: false, gold: false, state: 'fall', lane: 0, pattern: null,
        x: 0, y: 0, px: 0, py: 0, rot: 0, prot: 0, baseX: 0, vy: 0, t: 0, ft: 0, trailT: 0,
        swayAmp: 0, swayW: 0, swayPh: 0, rotBase: 0, rotAmp: 0, rotW: 0, rotPh: 0,
        alpha: 1, size: 1, resolved: false };
    }
    var items = [];
    for (var ii = 0; ii < T.ITEM_POOL; ii++) items.push(makeItem());
    // particle kinds: 0 droplet (mug-relative), 1 crumb (mug-relative), 2 sparkle (world)
    var particles = [];
    for (var pi = 0; pi < T.PARTICLE_POOL; pi++) particles.push({ active: false, kind: 0, x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, g: 0, life: 0, maxLife: 0, size: 1, rot: 0, rotV: 0 });
    var popups = [];
    for (var qi = 0; qi < T.POPUP_POOL; qi++) popups.push({ active: false, kind: 'plus', x: 0, y: 0, t: 0, dur: 0 });
    var glows = [];
    for (var gi = 0; gi < T.GLOW_POOL; gi++) glows.push({ active: false, t: 0 });
    var flashes = [];
    for (var fi = 0; fi < T.FLASH_POOL; fi++) flashes.push({ active: false, t: 0, gold: false });
    var fragments = [];
    for (var ri = 0; ri < T.FRAGMENT_POOL; ri++) fragments.push({ active: false, kind: null, q: 0, x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, rot: 0, rotV: 0, t: 0 });
    // spawn queue for patterns (second item of a pair)
    var queue = [{ active: false, at: 0, cls: CLS.WAFER, lane: 0, pattern: null }, { active: false, at: 0, cls: CLS.WAFER, lane: 0, pattern: null }];
    // ambient motes (cosmetic, real time)
    var motes = [];
    var moteCount = (reduced || !sprites) ? 0 : T.MOTES;
    for (var mi = 0; mi < moteCount; mi++) {
      motes.push({ x: frng.range(60, T.STAGE_W - 60), y: frng.range(300, T.KILL_Y), vy: frng.pick(T.MOTE_SPEED),
        swayAmp: frng.range(10, 30), swayW: frng.range(0.3, 0.7) * TWO_PI, ph: frng() * TWO_PI, size: frng.range(0.55, 1.1), rot: frng() * TWO_PI, rotV: frng.range(-0.6, 0.6) });
    }

    // ---- Render resources (browser only) --------------------------------------
    var text = null, vignette = null, glowTex = null, raysTex = null, linesTex = null, flashTex = null, itemGlow = null, shadowTex = null, streakTex = null;
    var comboCache = {};
    var fragmentCache = {};
    if (ctx) {
      vignette = buildVignette(scale);
      glowTex = buildGlow(scale);
      flashTex = buildFlash(scale);
      shadowTex = buildShadow(scale);
      if (!reduced) streakTex = buildStreaks(scale);
      itemGlow = buildItemGlows(scale);
      if (!reduced) { raysTex = buildRays(scale); linesTex = buildSpeedLines(scale); }
      text = buildTextSprites(scale);
      for (var cn = T.COMBO_MIN_STREAK; cn <= T.COMBO_MIN_STREAK + 9; cn++) comboCache[cn] = buildComboText(cn, scale);
      // Re-rasterise text once web fonts arrive (first build may use a fallback font).
      if (hasDoc && document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () { if (!destroyed) { text = buildTextSprites(scale); comboCache = {}; } });
      }
      if (sprites) {
        var pre = ['wafer', 'gold', 'wafer-piece', 'splash-drop', 'sparkle'].concat(hazards);
        pre.forEach(function (n) { if (sprites[n]) sprites[n].prewarm(); });
        hazards.forEach(function (n) { if (sprites[n]) fragmentCache[n] = buildFragments(sprites[n]); });
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

    function reachable(speed) {
      return !T.SPAWN_ONLY_IF_REACHABLE || (duration - simTime) * speed >= (T.MUG_RIM_Y - T.SPAWN_Y);
    }

    /** Put one item in play. `cls` is a CLS value; hazards get a rotating sprite. */
    function spawnItem(cls, lane, pattern, speed) {
      var it = freeItem();
      if (!it) return null;
      var L = lanes[lane];
      if (cls === CLS.HAZARD) {
        // queued hazards re-check the rules (a regular spawn may have moved the counters)
        if (consecutiveBads >= T.MAX_CONSECUTIVE_BADS || simTime - L.lastBadAt < T.BAD_LANE_COOLDOWN) cls = CLS.WAFER;
      }
      var bad = cls === CLS.HAZARD;
      var kind = bad ? pickHazard(rng, hazards, lastHazard) : (cls === CLS.GOLD ? KIND.GOLD : cls === CLS.BONUS ? KIND.BONUS_TIME : KIND.WAFER);
      if (cls === CLS.BONUS) bonusSpawned++;
      if (bad) lastHazard = kind;
      L.lastAt = simTime; L.lastKind = kind;
      if (bad) { L.lastBadAt = simTime; consecutiveBads++; } else consecutiveBads = 0;

      it.active = true; it.kind = kind; it.cls = cls; it.bad = bad; it.gold = cls === CLS.GOLD; it.bonus = cls === CLS.BONUS; it.state = 'fall'; it.lane = lane; it.pattern = pattern;
      it.baseX = spawnMinX + laneW * (lane + 0.5) + rng.range(-1, 1) * laneW * T.LANE_JITTER;
      it.swayAmp = rng.pick(T.SWAY_AMP); it.swayW = rng.pick(T.SWAY_HZ) * TWO_PI; it.swayPh = rng() * TWO_PI;
      if (bad || cls === CLS.BONUS) { it.rotBase = 0; it.rotAmp = 0; it.rotW = 0; } // icons fall upright, exactly as drawn
      else { it.rotBase = rng.range(-T.WAFER_ROT_BASE, T.WAFER_ROT_BASE); it.rotAmp = rng.pick(T.WAFER_ROT_AMP); it.rotW = rng.pick(T.WAFER_ROT_HZ) * TWO_PI; } // swings, broken end down
      it.rotPh = rng() * TWO_PI;
      it.vy = speed; it.t = 0; it.ft = 0; it.trailT = 0; it.alpha = 1; it.size = 1; it.resolved = false;
      it.x = it.px = it.baseX + Math.sin(it.swayPh) * it.swayAmp;
      it.y = it.py = T.SPAWN_Y;
      it.rot = it.prot = it.rotBase + Math.sin(it.rotPh) * it.rotAmp;
      emit({ type: 'spawn', kind: kind, cls: cls, bad: bad, lane: lane, t: simTime, x: it.baseX, pattern: pattern });
      return it;
    }

    function enqueue(at, cls, lane, pattern) {
      for (var i = 0; i < queue.length; i++) if (!queue[i].active) {
        var q = queue[i]; q.active = true; q.at = at; q.cls = cls; q.lane = lane; q.pattern = pattern; return;
      }
    }

    function adjacentLane(lane) {
      if (lane === 0) return 1;
      if (lane === T.LANES - 1) return lane - 1;
      return rng() < 0.5 ? lane - 1 : lane + 1;
    }

    /** A lane that may take a hazard now, or -1. */
    function hazardLane() {
      var start = rng.int(T.LANES);
      for (var k = 0; k < T.LANES; k++) {
        var l = (start + k) % T.LANES;
        if (simTime - lanes[l].lastBadAt >= T.BAD_LANE_COOLDOWN) return l;
      }
      return -1;
    }

    /** Regular spawn tick. Returns the extra delay to add before the next regular spawn. */
    function spawn(speed) {
      var lane = rng.int(T.LANES);
      // crossfire: hazard + wafer CROSSFIRE_GAP apart in adjacent lanes (order flips when the hazard cap is hit)
      if (simTime >= nextCrossfireAt && simTime >= T.WAFERS_ONLY_SECONDS) {
        var hl = hazardLane();
        if (hl >= 0) {
          var adj = adjacentLane(hl);
          var hazardFirst = consecutiveBads < T.MAX_CONSECUTIVE_BADS;
          nextCrossfireAt = simTime + T.CROSSFIRE_EVERY * (diff.crossfire || 1) * (1 + rng.range(-1, 1) * T.CROSSFIRE_JITTER);
          emit({ type: 'pattern', name: 'crossfire', t: simTime });
          spawnItem(hazardFirst ? CLS.HAZARD : CLS.WAFER, hazardFirst ? hl : adj, 'crossfire', speed);
          enqueue(simTime + T.CROSSFIRE_GAP, hazardFirst ? CLS.WAFER : CLS.HAZARD, hazardFirst ? adj : hl, 'crossfire');
          return T.CROSSFIRE_GAP;
        }
        nextCrossfireAt = simTime + 1;
      }
      // double wafer: "catch both"
      if (simTime >= T.DOUBLE_AFTER && rng() < T.DOUBLE_CHANCE) {
        emit({ type: 'pattern', name: 'double', t: simTime });
        spawnItem(CLS.WAFER, lane, 'double', speed);
        enqueue(simTime + T.DOUBLE_GAP, CLS.WAFER, adjacentLane(lane), 'double');
        return T.DOUBLE_GAP;
      }
      var cls = pickKind(rng, simTime, simTime, lane, lanes, consecutiveBads, T, diff);
      var bonusOk = bonusSpawned < T.BONUS_MAX_PER_ROUND && simTime >= T.BONUS_AFTER_SECONDS && duration - simTime > T.BONUS_LAST_SECONDS && sprites && sprites[KIND.BONUS_TIME] && sprites[KIND.BONUS_TIME].fromImage;
      var forcedBonus = bonusOk && bonusSpawned === 0 && simTime >= T.BONUS_FORCE_AT;
      if (bonusOk && (rng() < T.BONUS_SHARE || forcedBonus)) cls = CLS.BONUS;
      // Make the player move: most hazards drop into the mug's own lane, most wafers land a lane or two away.
      var mugLane = clamp(Math.floor((mug.x - spawnMinX) / laneW), 0, T.LANES - 1);
      if (forcedBonus) { spawnItem(cls, mugLane, null, speed); return 0; } // the guaranteed stopwatch comes to the player
      if (cls === CLS.HAZARD && rng() < T.HAZARD_AT_MUG && simTime - lanes[mugLane].lastBadAt >= T.BAD_LANE_COOLDOWN) lane = mugLane;
      else if (cls !== CLS.HAZARD && rng() < T.WAFER_AWAY && T.LANES > 1) { var off = rng.int(T.LANES - 1) + 1; lane = (mugLane + off) % T.LANES; }
      spawnItem(cls, lane, null, speed);
      return 0;
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

    function addFlash(gold) {
      for (var i = 0; i < flashes.length; i++) if (!flashes[i].active) { flashes[i].active = true; flashes[i].t = 0; flashes[i].gold = gold; return; }
    }

    function freeParticle() {
      for (var i = 0; i < particles.length; i++) if (!particles[i].active) return particles[i];
      return null;
    }

    function splash(y) {
      var n = reduced ? T.SPLASH_PARTICLES_REDUCED : T.SPLASH_PARTICLES;
      var crumbs = reduced ? 1 : T.SPLASH_CRUMBS;
      for (var k = 0; k < n + crumbs; k++) {
        var p = freeParticle();
        if (!p) return;
        p.active = true;
        p.kind = k < n ? 0 : 1;
        // x is stored RELATIVE to the mug so the splash travels with the cup.
        p.x = p.px = frng.range(-70, 70); p.y = p.py = y - 10;
        p.vx = frng.range(-1, 1) * T.SPLASH_SPREAD; p.vy = -frng.pick(T.SPLASH_SPEED) * (p.kind ? 0.85 : 1);
        p.g = T.GRAVITY;
        p.maxLife = p.life = frng.pick(T.PARTICLE_LIFE);
        p.size = p.kind ? frng.range(0.7, 1.1) : frng.range(0.55, 1.3);
        p.rot = frng() * TWO_PI; p.rotV = frng.range(-1, 1) * T.SPLASH_SPIN;
      }
    }

    function sparkleBurst(x, y, n) {
      for (var k = 0; k < n; k++) {
        var p = freeParticle();
        if (!p) return;
        p.active = true; p.kind = 2;
        p.x = p.px = x + frng.range(-40, 40); p.y = p.py = y - 20;
        var a = frng.range(-Math.PI, 0), sp = frng.range(220, 620);
        p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp; p.g = 600;
        p.maxLife = p.life = frng.range(0.5, 0.9);
        p.size = frng.range(0.8, 1.6); p.rot = frng() * TWO_PI; p.rotV = frng.range(-4, 4);
      }
    }

    function trailSparkle(it) {
      var p = freeParticle();
      if (!p) return;
      p.active = true; p.kind = 2;
      p.x = p.px = it.x + frng.range(-30, 30); p.y = p.py = it.y + frng.range(-90, 60);
      p.vx = frng.range(-30, 30); p.vy = it.vy * 0.25; p.g = 0;
      p.maxLife = p.life = frng.range(0.35, 0.6);
      p.size = frng.range(0.5, 1.1); p.rot = frng() * TWO_PI; p.rotV = frng.range(-3, 3);
    }

    function shatter(it) {
      var speed = T.FRAGMENT_SPEED;
      for (var q = 0; q < 4; q++) {
        var f = null;
        for (var i = 0; i < fragments.length; i++) if (!fragments[i].active) { f = fragments[i]; break; }
        if (!f) return;
        f.active = true; f.kind = it.kind; f.q = q; f.t = 0;
        var dx = (q % 2) ? 1 : -1, dy = (q >> 1) ? 1 : -1;
        f.x = f.px = it.x; f.y = f.py = it.y;
        f.vx = dx * frng.pick(speed) + frng.range(-60, 60);
        f.vy = dy * frng.pick(speed) * 0.6 - 260;
        f.rot = it.rot; f.rotV = frng.range(-1, 1) * T.FRAGMENT_SPIN;
      }
    }

    // ---- Resolution ---------------------------------------------------------
    function resolveCatch(it) {
      it.resolved = true; it.state = 'dunk'; it.ft = 0;
      if (it.bonus) {
        // gold stopwatch: more time on the clock, no score, streak untouched
        duration += T.BONUS_TIME_SECONDS; state.bonusTime = (state.bonusTime || 0) + T.BONUS_TIME_SECONDS;
        splash(T.MUG_RIM_Y); addGlow(); addFlash(true); splashT = T.SPLASH_FRAME_SECONDS;
        sparkleBurst(mug.x, T.MUG_RIM_Y, reduced ? 4 : T.GOLD_BURST);
        addPopup('time', it.x, T.MUG_RIM_Y - 120);
        emit({ type: 'catch', kind: it.kind, points: 0, bonus: 'time', seconds: T.BONUS_TIME_SECONDS, score: state.score, streak: state.streak, x: it.x });
        return;
      }
      var points = it.gold ? T.GOLD_SCORE : 1;
      state.caught++; if (it.gold) state.gold++;
      state.score += points; state.streak++;
      if (state.streak > state.bestStreak) state.bestStreak = state.streak;
      splash(T.MUG_RIM_Y);
      addGlow(); addFlash(it.gold);
      splashT = T.SPLASH_FRAME_SECONDS;
      if (it.gold) sparkleBurst(mug.x, T.MUG_RIM_Y, reduced ? 4 : T.GOLD_BURST);
      var isStreak = T.STREAK_EVERY > 0 && state.streak % T.STREAK_EVERY === 0;
      if (isStreak) {
        state.score += T.STREAK_BONUS;
        addPopup('big', clamp(mug.x + 300, 260, T.STAGE_W - 240), T.MUG_RIM_Y - 300);
        if (it.gold) addPopup('plus3', it.x, T.MUG_RIM_Y - 120);
      } else {
        addPopup(it.gold ? 'plus3' : 'plus', it.x, T.MUG_RIM_Y - 120);
      }
      if (state.streak >= T.COMBO_MIN_STREAK) comboPulse = 1;
      emit({ type: 'catch', kind: it.kind, points: points, score: state.score, streak: state.streak, x: it.x });
      if (isStreak) emit({ type: 'streak', n: state.streak, score: state.score });
    }

    function resolveHit(it) {
      it.resolved = true; it.state = 'pop'; it.ft = 0;
      state.hits++; state.streak = 0;
      state.score = Math.max(0, state.score - T.HIT_PENALTY);
      stunT = T.STUN_SECONDS;
      shakeT = T.SHAKE_SECONDS; recoilT = T.MUG_RECOIL_SECONDS; recoilDir = it.x < mug.x ? 1 : -1;
      wobbleT = T.MUG_WOBBLE_SECONDS; sloshV += recoilDir * T.HIT_SLOSH_KICK;
      shatter(it);
      if (T.SHOW_PENALTY_POPUP && T.HIT_PENALTY > 0) addPopup('minus', it.x, T.MUG_RIM_Y - 120);
      emit({ type: 'hit', kind: it.kind, score: state.score });
    }

    function resolveMiss(it) {
      it.resolved = true; it.state = 'fade'; it.ft = 0;
      if (it.bad) { state.dodged++; emit({ type: 'dodge', kind: it.kind }); }
      else { state.missed++; state.streak = 0; emit({ type: 'miss', kind: it.kind }); }
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
      var mugAcc = (mug.v - prevMugV) / dt; prevMugV = mug.v;
      sloshV += (-T.DRINK_SLOSH_K * sloshX - T.DRINK_SLOSH_C * sloshV - mugAcc * T.DRINK_SLOSH_GAIN) * dt;
      sloshX = clamp(sloshX + sloshV * dt, -1.5, 1.5);
      if (stunT > 0) stunT -= dt;
      if (wobbleT > 0) wobbleT -= dt;

      // Spawning: regular timer + pattern queue
      spawnTimer -= dt;
      if (spawnTimer <= 0) {
        var extra = reachable(sch.speed) ? spawn(sch.speed) : 0;
        spawnTimer = sch.interval * (1 + rng.range(-1, 1) * T.SPAWN_JITTER) + extra;
      }
      for (var qq = 0; qq < queue.length; qq++) {
        var qe = queue[qq];
        if (qe.active && simTime >= qe.at) { qe.active = false; if (reachable(sch.speed)) spawnItem(qe.cls, qe.lane, qe.pattern, sch.speed); }
      }

      // Items
      var canCatch = !(T.STUN_BLOCKS_CATCH && stunT > 0);
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it.active) continue;
        it.px = it.x; it.py = it.y; it.prot = it.rot;
        it.t += dt;
        if (it.state === 'fall' || it.state === 'fade') {
          it.y += it.vy * (it.state === 'fade' ? T.MISS_FADE_SPEED : 1) * dt;
          it.x = it.baseX + Math.sin(it.swayPh + it.t * it.swayW) * it.swayAmp;
          it.rot = it.rotBase + Math.sin(it.rotPh + it.t * it.rotW) * it.rotAmp;
          if (!it.bad && !it.bonus) { var ak = clamp((it.y - (T.MUG_RIM_Y - T.WAFER_ALIGN_PX)) / T.WAFER_ALIGN_PX, 0, 1); ak = ak * ak * (3 - 2 * ak); it.rot *= 1 - T.WAFER_ALIGN * ak; }
          if ((it.gold || it.bonus) && ctx && !reduced) { it.trailT -= dt; if (it.trailT <= 0) { it.trailT = T.GOLD_TRAIL_EVERY * (it.bonus ? 0.7 : 1); trailSparkle(it); } }
          if (!it.resolved) {
            if (catchTest(it.x, it.y, mug.x, T)) {
              if (it.bad) { if (!(T.STUN_INVULNERABLE && stunT > 0)) resolveHit(it); }
              else if (canCatch) resolveCatch(it);
            }
            if (!it.resolved && it.y > T.MISS_Y) resolveMiss(it);
          }
          if (it.state === 'fade') {
            // slow, blink and vanish on the spot instead of sliding on past the mug
            it.ft += dt;
            var fk = clamp(it.ft / T.MISS_FADE_SECONDS, 0, 1);
            it.alpha = (1 - fk) * (0.45 + 0.55 * Math.abs(Math.cos(fk * Math.PI * T.MISS_BLINKS)));
            it.size = 1 - 0.25 * fk;
            if (fk >= 1 || it.y >= T.KILL_Y) it.active = false;
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
          it.size = 1 + 0.4 * kp;
          if (kp >= 1) it.active = false;
        }
      }

      // Particles
      for (var p = 0; p < particles.length; p++) {
        var pt = particles[p];
        if (!pt.active) continue;
        pt.px = pt.x; pt.py = pt.y;
        pt.vy += pt.g * dt;
        pt.x += pt.vx * dt; pt.y += pt.vy * dt;
        pt.rot += pt.rotV * dt;
        pt.life -= dt;
        // Droplets / crumbs that fall back below the rim vanish into the drink.
        if (pt.life <= 0 || (pt.kind !== 2 && pt.vy > 0 && pt.y > T.MUG_RIM_Y + 30)) pt.active = false;
      }

      // Hazard fragments
      for (var f = 0; f < fragments.length; f++) {
        var fr = fragments[f];
        if (!fr.active) continue;
        fr.px = fr.x; fr.py = fr.y;
        fr.vy += T.GRAVITY * dt;
        fr.x += fr.vx * dt; fr.y += fr.vy * dt; fr.rot += fr.rotV * dt;
        fr.t += dt;
        if (fr.t >= T.FRAGMENT_SECONDS || fr.y > T.KILL_Y) fr.active = false;
      }

      // Popups / glows / flashes
      for (var q = 0; q < popups.length; q++) if (popups[q].active && (popups[q].t += dt) >= popups[q].dur) popups[q].active = false;
      for (var g = 0; g < glows.length; g++) if (glows[g].active && (glows[g].t += dt) >= T.GLOW_SECONDS) glows[g].active = false;
      for (var fl = 0; fl < flashes.length; fl++) if (flashes[fl].active && (flashes[fl].t += dt) >= T.FLASH_SECONDS) flashes[fl].active = false;

      // Timer
      if (!final10Sent && duration - simTime <= T.FINAL_FX_SECONDS) { final10Sent = true; emit({ type: 'final10', timeLeft: Math.max(0, duration - simTime) }); }
      if (!finalSent && duration - simTime <= T.FINAL_SECONDS) { finalSent = true; emit({ type: 'final5', timeLeft: Math.max(0, duration - simTime) }); }
      if (simTime >= duration) finish(false);
    }

    /** Cosmetic animation in real time (mug tilt, splash frame, shake, motes). */
    function cosmetic(dt) {
      if (splashT > 0) splashT -= dt;
      if (shakeT > 0) shakeT -= dt;
      if (recoilT > 0) recoilT -= dt;
      if (comboPulse > 0) comboPulse = Math.max(0, comboPulse - dt * 4);
      var tiltTarget = state.phase === 'playing' ? clamp(mug.v / T.MUG_TILT_SPEED, -1, 1) * T.MUG_TILT_MAX : 0;
      tilt += (tiltTarget - tilt) * Math.min(1, T.MUG_TILT_SMOOTH * dt);
      for (var i = 0; i < motes.length; i++) {
        var m = motes[i];
        m.y -= m.vy * dt; m.rot += m.rotV * dt;
        if (m.y < 260) { m.y = T.KILL_Y + 20; m.x = frng.range(60, T.STAGE_W - 60); }
      }
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
      cosmetic(frameDt);
      updateDerived();
    }

    function finish(stopped) {
      if (state.phase === 'ended') return;
      state.phase = 'ended';
      simTime = Math.min(simTime, duration);
      stunT = 0; shakeT = 0;
      for (var i = 0; i < items.length; i++) items[i].active = false;
      for (var p = 0; p < particles.length; p++) particles[p].active = false;
      for (var q = 0; q < popups.length; q++) popups[q].active = false;
      for (var f = 0; f < fragments.length; f++) fragments[f].active = false;
      for (var k = 0; k < queue.length; k++) queue[k].active = false;
      updateDerived();
      var result = {
        score: state.score, caught: state.caught, gold: state.gold, missed: state.missed, hits: state.hits, dodged: state.dodged,
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

    /** Transformed blit (rotation / non-uniform scale) — used only for the mug and fragments. */
    /** Live drink surface: the ellipse of liquid in the mug sprite is redrawn in thin rows with a horizontal
     *  shear that swings with the mug's acceleration (slosh) plus a soft ripple, so it reads as liquid. */
    function drawDrink(v, x, y, rot, sx, sy) {
      // Vertical displacement per column: the level tips with the slosh (one side up, the other down) and a
      // ripple travels across. Columns are sourced taller than the drink so the mug's inner wall slides into
      // view where the liquid drops, which is what makes the motion read.
      var cs = v.canvas.width / v.w, rx = T.DRINK_RX, ry = T.DRINK_RY, cw = T.DRINK_COL, M = ry;
      var tilt = sloshX * T.DRINK_TILT_PX, ph = clock * T.DRINK_RIPPLE_HZ * TWO_PI;
      ctx.save(); ctx.translate(x, y); if (rot) ctx.rotate(rot); if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);
      ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, TWO_PI); ctx.clip();
      var syPx = (v.oy - ry - M) * cs, shPx = (2 * ry + 2 * M) * cs, swPx = cw * cs;
      for (var j = -rx; j < rx; j += cw) {
        var f = (j + cw / 2) / rx;
        var dy = tilt * f + T.DRINK_WAVE_PX * Math.sin(ph * 1.4 - j * 0.045) + T.DRINK_TREMBLE_PX * 0.7 * Math.sin(ph * 4.3 + j * 0.07);
        ctx.drawImage(v.canvas, (v.ox + j) * cs, syPx, swPx, shPx, j, -ry - M + dy, cw, 2 * ry + 2 * M);
      }
      // a soft sheen that slides against the tilt, like light catching the moving surface
      var gx = -tilt * 4;
      var g = ctx.createRadialGradient(gx, -ry * 0.25, 0, gx, -ry * 0.25, rx * 0.7);
      g.addColorStop(0, 'rgba(255,235,210,0.22)'); g.addColorStop(1, 'rgba(255,235,210,0)');
      ctx.fillStyle = g; ctx.fillRect(-rx, -ry, 2 * rx, 2 * ry);
      ctx.restore(); drawCalls++;
    }
    function blitT(v, x, y, rot, sx, sy, alpha) {
      if (alpha <= 0) return;
      ctx.save();
      if (alpha < 1) ctx.globalAlpha = alpha;
      ctx.translate(x, y);
      if (rot) ctx.rotate(rot);
      if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);
      ctx.drawImage(v.canvas, -v.ox, -v.oy, v.w, v.h);
      ctx.restore();
      drawCalls++;
    }

    var ghosts = reduced ? 1 : T.TRAIL_GHOSTS;

    function drawItem(it, a) {
      var sp = sprites && sprites[it.kind];
      if (!sp) return;
      var x = lerp(it.px, it.x, a), y = lerp(it.py, it.y, a), rot = lerp(it.prot, it.rot, a);
      var falling = it.state === 'fall' || it.state === 'fade';
      // light streak along the fall path (reference look): longer and brighter with speed
      if (streakTex && falling && it.alpha > 0.05) {
        var st = it.bad ? streakTex.hazard : (it.gold ? streakTex.gold : streakTex.wafer);
        var sp2 = clamp((it.vy - T.STREAK_MIN_SPEED) / (T.SPEED_END - T.STREAK_MIN_SPEED), 0.2, 1);
        var sl = (0.55 + 0.45 * sp2) * T.STREAK_LENGTH;
        ctx.save(); ctx.globalAlpha = T.STREAK_ALPHA * sp2 * it.alpha; ctx.globalCompositeOperation = 'lighter';
        ctx.translate(x, y + 10); ctx.rotate(rot * 0.35); ctx.scale(it.size, sl * it.size);
        ctx.drawImage(st.canvas, -st.ox, -st.oy, st.w, st.h); ctx.restore(); drawCalls++;
      }
      // glow under the item
      if (itemGlow && it.alpha > 0.05) {
        var gl = it.bad ? itemGlow.hazard : (it.gold ? itemGlow.gold : itemGlow.wafer);
        var ga = T.ITEM_GLOW_ALPHA * it.alpha;
        if (it.gold) ga *= 0.8 + 0.25 * Math.sin(clock * 9 + it.swayPh);
        blit(gl, x, y, ga, it.size);
      }
      // hazards announce themselves: a pulsing warning ring, a slow blink and a nervous shake
      var hz = 0, itemAlpha = it.alpha;
      if (it.bad && falling && it.alpha > 0.05) {
        hz = 0.5 + 0.5 * Math.sin(clock * T.HAZARD_PULSE_HZ * TWO_PI + it.swayPh);
        x += Math.sin(clock * 47 + it.swayPh) * T.HAZARD_JITTER_PX; y += Math.cos(clock * 53 + it.swayPh) * T.HAZARD_JITTER_PX * 0.6;
        itemAlpha = it.alpha * (T.HAZARD_BLINK_MIN + (1 - T.HAZARD_BLINK_MIN) * hz);
        var rr = (sp.w > sp.h ? sp.w : sp.h) * 0.62 * it.size * (1 + 0.18 * hz);
        ctx.save(); ctx.globalAlpha = T.HAZARD_RING_ALPHA * (0.35 + 0.65 * hz) * it.alpha; ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = 'rgba(255,120,70,1)'; ctx.lineWidth = 5; ctx.setLineDash([18, 12]); ctx.lineDashOffset = -clock * 90;
        ctx.beginPath(); ctx.arc(x, y, rr, 0, TWO_PI); ctx.stroke();
        ctx.setLineDash([]); ctx.lineWidth = 2; ctx.globalAlpha *= 0.6; ctx.beginPath(); ctx.arc(x, y, rr * 1.18, 0, TWO_PI); ctx.stroke();
        ctx.restore(); drawCalls += 2;
      }
      // bonus: breathing golden halo and a slow spin of light behind it
      if (it.bonus && falling && itemGlow && it.alpha > 0.05) {
        var bk = 0.5 + 0.5 * Math.sin(clock * 2.2 * TWO_PI + it.swayPh);
        blit(itemGlow.gold, x, y, (0.45 + 0.45 * bk) * it.alpha, 1.1 + 0.25 * bk);
        ctx.save(); ctx.globalAlpha = (0.35 + 0.45 * bk) * it.alpha; ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = 'rgba(255,225,150,1)'; ctx.lineWidth = 4; ctx.setLineDash([26, 16]); ctx.lineDashOffset = clock * 70;
        ctx.beginPath(); ctx.arc(x, y, (sp.w > sp.h ? sp.w : sp.h) * 0.6 * it.size, 0, TWO_PI); ctx.stroke(); ctx.restore(); drawCalls += 2;
      }
      // continuous rotation (the cached 15-degree variants stepped visibly on a slow tumble)
      var v = sp.rotated(0);
      // drop shadow: dark silhouette offset down-left, so items read as 3D objects over the backdrop
      if (T.ITEM_SHADOW_ALPHA > 0 && it.alpha > 0.05) blitT(silhouette(v), x - T.ITEM_SHADOW_DX, y + T.ITEM_SHADOW_DY, rot, it.size, it.size, T.ITEM_SHADOW_ALPHA * it.alpha);
      // motion trail: ghost copies back along the fall direction
      if (falling && ghosts > 0) {
        var sf = clamp((it.vy - T.TRAIL_MIN_SPEED) / (T.SPEED_END - T.TRAIL_MIN_SPEED), 0.25, 1);
        for (var k = ghosts; k >= 1; k--) {
          var ta = T.TRAIL_ALPHA * sf * (1 - k / (ghosts + 1)) * it.alpha, ts = 1 - 0.04 * k;
          blitT(v, x, y - it.vy * T.TRAIL_SPACING * k, rot, ts, ts, ta);
        }
      }
      blitT(v, x, y, rot, it.size, it.size, itemAlpha);
      // two-frame icon: the "<kind>-on" frame fades in and out over the still one (bells ringing, glow pulsing)
      var on = sprites[it.kind + '-on'];
      if (on && on.fromImage && it.alpha > 0.05) {
        var fk = it.bad ? hz : 0.5 + 0.5 * Math.sin(clock * T.BONUS_FLIP_HZ * TWO_PI + it.swayPh);
        if (it.bad) fk = 0.5 + 0.5 * Math.sin(clock * T.FRAME_FLIP_HZ * TWO_PI + it.swayPh);
        blitT(on.rotated(0), x, y, rot, it.size, it.size, itemAlpha * fk);
      }
    }

    function render(a) {
      if (!ctx) return;
      drawCalls = 0;
      var W = T.STAGE_W, H = T.STAGE_H;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (state.phase === 'idle' && !sprites) return;

      // screen shake: translate the whole frame by a decaying random offset
      var shX = 0, shY = 0;
      if (shakeT > 0) {
        var sk = shakeT / T.SHAKE_SECONDS; sk *= sk;
        shX = (Math.random() * 2 - 1) * T.SHAKE_PX * sk; shY = (Math.random() * 2 - 1) * T.SHAKE_PX * sk;
      }
      ctx.setTransform(scale, 0, 0, scale, shX * scale, shY * scale);

      var mugX = lerp(mug.px, mug.x, a);
      var bobY = Math.sin(clock * TWO_PI * T.MUG_BOB_HZ) * T.MUG_BOB_AMP;
      var rimY = T.MUG_RIM_Y;
      var playing = state.phase === 'playing' || state.phase === 'paused';
      var finalK = playing ? clamp((T.FINAL_FX_SECONDS - state.timeLeft) / 1.0, 0, 1) : 0;
      var speedK = duration > 0 ? clamp(1 - state.timeLeft / duration, 0, 1) : 1; // 0 at the start of the round, 1 at the end
      var i, it, k;

      // 1. background layers, clipped to the play area (never over the slider)
      if (raysTex || linesTex || motes.length) {
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, W, T.KILL_Y); ctx.clip();
        if (raysTex && state.phase !== 'ended') {
          var sk2 = state.streak >= T.RAYS_MIN_STREAK ? clamp((state.streak - T.RAYS_MIN_STREAK + 1) / (T.RAYS_FULL_STREAK - T.RAYS_MIN_STREAK + 1), 0, 1) : 0;
          var ra = T.RAYS_IDLE_ALPHA + (T.RAYS_MAX_ALPHA - T.RAYS_IDLE_ALPHA) * Math.max(sk2, finalK * 0.7);
          // one textured quad: slow rotation, a gentle breathing scale, brighter with the streak / final seconds
          var rs = 1 + 0.08 * Math.max(sk2, finalK); // no breathing: a steady wheel that only turns
          ctx.save();
          ctx.translate(raysX, rimY - T.RAYS_Y_OFFSET);
          ctx.globalAlpha = ra;
          ctx.rotate(clock * T.RAYS_ROT_SPEED * (1 + 0.6 * Math.max(sk2, finalK)));
          ctx.drawImage(raysTex.canvas, -raysTex.ox * rs, -raysTex.oy * rs, raysTex.w * rs, raysTex.h * rs);
          drawCalls++;
          ctx.restore();
        }
        var lineK = playing && T.SPEEDLINES_IDLE > 0 ? T.SPEEDLINES_IDLE * (0.6 + 0.4 * speedK) : 0; // 0 = off
        if (linesTex && lineK > 0 && state.phase !== 'ended') {
          var L = T.KILL_Y + 600, scroll = clock * T.SPEEDLINES_SPEED * (0.5 + 0.35 * speedK);
          for (i = 0; i < linesTex.lines.length; i++) {
            var ln = linesTex.lines[i];
            var ly = (ln.ph * L + scroll) % L - 600;
            if (ly + ln.len < 0) continue;
            ctx.globalAlpha = ln.a * T.SPEEDLINES_ALPHA * lineK;
            ctx.drawImage((ln.gold ? linesTex.gold : linesTex.white).canvas, ln.x - ln.w / 2, ly, ln.w, ln.len);
            drawCalls++;
          }
          ctx.globalAlpha = 1;
        }
        var spk = sprites && sprites.sparkle;
        if (spk) for (i = 0; i < motes.length; i++) {
          var m = motes[i];
          var mx = m.x + Math.sin(m.ph + clock * m.swayW) * m.swayAmp;
          var ma = T.MOTE_ALPHA * (0.55 + 0.45 * Math.sin(m.ph * 3 + clock * 2.3));
          blit(spk.rotated(m.rot), mx, m.y, ma, m.size);
        }
        ctx.restore();
      }

      // 2. items at/below the rim (behind the mug) — includes dunking wafers
      for (i = 0; i < items.length; i++) {
        it = items[i];
        if (it.active && (it.y >= rimY || it.state === 'dunk')) drawItem(it, a);
      }

      // 3a. ground shadow under the mug: stretches with speed, slides against the lean, lifts with the bob
      if (shadowTex && sprites && sprites.mug) {
        var mugBottom = rimY + T.MUG_SHADOW_DROP;
        var spd = clamp(Math.abs(mug.v) / T.MUG_TILT_SPEED, 0, 1);
        var shW = (T.MUG_SHADOW_W * (1 + 0.35 * spd)) / shadowTex.w, shH = (T.MUG_SHADOW_H * (1 - 0.15 * spd)) / shadowTex.h;
        var shX = mugX - tilt * 2.2, shY = mugBottom + bobY * 0.3;
        var shA = T.MUG_SHADOW_ALPHA * (1 - 0.25 * (bobY < 0 ? -bobY / T.MUG_BOB_AMP : 0)) * (1 - 0.3 * spd);
        ctx.save(); ctx.globalAlpha = shA; ctx.translate(shX, shY); ctx.scale(shW, shH);
        ctx.drawImage(shadowTex.canvas, -shadowTex.ox, -shadowTex.oy, shadowTex.w, shadowTex.h); ctx.restore(); drawCalls++;
      }

      // 3. mug (tilt into motion, splash frame + squash, recoil on hit)
      var mugSp = sprites && ((splashT > 0 && sprites['mug-splash'] && sprites['mug-splash'].fromImage) ? sprites['mug-splash'] : sprites.mug);
      if (mugSp) {
        var sx = 1, sy = 1, rot = tilt * DEG, dx = 0, dy = 0;
        if (splashT > 0) {
          var sp = 1 - splashT / T.SPLASH_FRAME_SECONDS;
          var sq = sp < 0.5 ? Math.sin(Math.PI * sp * 2) : 0;
          sx = 1 + T.SPLASH_SQUASH * sq; sy = 1 - T.SPLASH_SQUASH * 0.7 * sq;
        }
        if (recoilT > 0) {
          var rr = Math.sin(Math.PI * recoilT / T.MUG_RECOIL_SECONDS);
          dx = recoilDir * T.MUG_RECOIL_PX * rr; dy = 6 * rr; rot += -recoilDir * T.MUG_RECOIL_TILT * DEG * rr;
        }
        if (stunT > 0) dx += Math.sin(clock * 90) * 6 * (stunT / T.STUN_SECONDS);
        if (wobbleT > 0) { var wk = wobbleT / T.MUG_WOBBLE_SECONDS; rot += -recoilDir * Math.sin((1 - wk) * T.MUG_WOBBLE_SECONDS * T.MUG_WOBBLE_HZ * TWO_PI) * T.MUG_WOBBLE_DEG * DEG * wk * wk; }
        blitT(mugSp.rotated(0), mugX + dx, rimY + bobY + dy, rot, sx, sy, 1);
        if (splashT <= 0 && mugSp.fromImage && T.DRINK_RX > 0 && !reduced) drawDrink(mugSp.rotated(0), mugX + dx, rimY + bobY + dy, rot, sx, sy);
      }

      // 4. catch flash + glow ring on the rim
      if (flashTex) for (i = 0; i < flashes.length; i++) {
        var fls = flashes[i];
        if (!fls.active) continue;
        k = fls.t / T.FLASH_SECONDS;
        blit(flashTex, mugX, rimY - 20, (fls.gold ? 1 : 0.8) * (1 - k), 0.6 + (fls.gold ? 1.3 : 0.9) * k);
      }
      if (glowTex) for (i = 0; i < glows.length; i++) {
        var g = glows[i];
        if (!g.active) continue;
        k = g.t / T.GLOW_SECONDS;
        blit(glowTex, mugX, rimY + bobY, 0.85 * (1 - k), 0.7 + 0.5 * k);
      }

      // 5. items above the rim (in front of the mug)
      for (i = 0; i < items.length; i++) {
        it = items[i];
        if (it.active && !(it.y >= rimY || it.state === 'dunk')) drawItem(it, a);
      }

      // 6. hazard fragments
      for (i = 0; i < fragments.length; i++) {
        var fr = fragments[i];
        if (!fr.active) continue;
        var set = fragmentCache[fr.kind];
        if (!set) continue;
        var fq = set[fr.q], fa = 1 - fr.t / T.FRAGMENT_SECONDS;
        var frot = lerp(fr.rot - fr.rotV * T.DT, fr.rot, a);
        var cs = Math.cos(frot), sn = Math.sin(frot);
        var fx = lerp(fr.px, fr.x, a) + fq.dx * cs - fq.dy * sn, fy = lerp(fr.py, fr.y, a) + fq.dx * sn + fq.dy * cs;
        blitT(fq, fx, fy, frot, 1, 1, fa);
      }

      // 7. particles
      var drop = sprites && sprites['splash-drop'], piece = sprites && sprites['wafer-piece'], spark = sprites && sprites.sparkle;
      for (i = 0; i < particles.length; i++) {
        var p = particles[i];
        if (!p.active) continue;
        var lf = p.life / p.maxLife;
        var al = lf < 0.3 ? lf / 0.3 : 1;
        var px = lerp(p.px, p.x, a), py = lerp(p.py, p.y, a);
        if (p.kind === 2) { if (spark) blit(spark.rotated(p.rot), px, py, al, p.size * (0.4 + 0.6 * lf)); }
        else {
          px += mugX;
          if (p.kind === 1) { if (piece) blit(piece.rotated(p.rot), px, py, al, p.size); }
          else if (drop) blit(drop.rotated(p.rot), px, py, al, p.size);
        }
      }

      // 8. popups
      if (text) for (i = 0; i < popups.length; i++) {
        var pp = popups[i];
        if (!pp.active) continue;
        var tt = pp.t / pp.dur;
        if (pp.kind === 'big') {
          var sc = tt < 0.25 ? easeOutBack(tt / 0.25) : 1;
          var fade = tt > 0.7 ? 1 - (tt - 0.7) / 0.3 : 1;
          blit(text.big, pp.x, pp.y - 30 * tt, fade, sc);
        } else {
          var rise = easeOutCubic(tt) * 120;
          var fd = tt > 0.55 ? 1 - (tt - 0.55) / 0.45 : 1;
          var scp = tt < 0.22 ? easeOutBack(tt / 0.22, 2.4) * T.POPUP_POP : T.POPUP_POP - (T.POPUP_POP - 1) * Math.min(1, (tt - 0.22) / 0.2);
          blit(pp.kind === 'minus' ? text.minus : pp.kind === 'plus3' ? text.plus3 : pp.kind === 'time' ? text.time : text.plus, pp.x, pp.y - rise, fd, scp);
        }
      }

      // 9. combo meter on the drink surface
      if (state.streak >= T.COMBO_MIN_STREAK && state.phase !== 'ended') {
        var ct = comboCache[state.streak];
        if (!ct) ct = comboCache[state.streak] = buildComboText(state.streak, scale);
        var cps = 1 + 0.35 * easeOutCubic(comboPulse) * comboPulse;
        blit(ct, mugX, rimY + T.COMBO_Y_OFFSET + bobY, 1, cps);
      }

      // 10. stun vignette
      if (vignette && stunT > 0 && !reduced) {
        var va = Math.min(1, stunT / T.STUN_SECONDS * 1.6) * 0.9;
        ctx.globalAlpha = va;
        ctx.drawImage(vignette.canvas, -shX, -shY, W, H);
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
        if (ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); }
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
          if (it.active) out.push({ kind: it.kind, cls: it.cls, bad: it.bad, gold: it.gold, state: it.state, lane: it.lane, pattern: it.pattern, x: it.x, y: it.y, vy: it.vy, resolved: it.resolved });
        }
        return out;
      },
      /** Count of active items (no allocation). */
      activeItems: function () { var n = 0; for (var i = 0; i < items.length; i++) if (items[i].active) n++; return n; },
      /** Hazard sprite names in rotation for this round. */
      hazards: hazards.slice(),
      tuning: T,
      seed: seed
    };
    return api;
  }

  root.DunkGame = {
    create: create,
    TUNING: TUNING,
    KIND: KIND,
    CLS: CLS,
    BAD_KINDS: BAD_KINDS,
    HAZARDS: TUNING.HAZARDS,
    internals: { createRng: createRng, springStep: springStep, schedule: schedule, catchTest: catchTest, pickKind: pickKind, pickHazard: pickHazard }
  };
})(typeof window !== 'undefined' ? window : this);
