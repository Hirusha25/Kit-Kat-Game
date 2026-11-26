#!/usr/bin/env node
/* Headless simulation tests for js/game.js (no DOM, no canvas).
 *
 * Run:  node tests/game/sim.test.js
 * Exit code 1 on any failure.
 *
 * The engine is loaded in a vm context with a minimal window/document stub,
 * then driven with game.advance() at a tracker-like 30 Hz by scripted players.
 */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ENGINE_PATH = path.join(__dirname, '..', '..', 'js', 'game.js');

/** Load game.js into a fresh sandbox. Returns { DunkGame, document }. */
function loadEngine() {
  const src = fs.readFileSync(ENGINE_PATH, 'utf8');
  const listeners = {};
  const document = {
    hidden: false,
    addEventListener(type, fn) { listeners[type] = fn; },
    removeEventListener(type) { delete listeners[type]; },
    createElement() { throw new Error('headless engine must not create DOM elements'); },
    _fire(type) { if (listeners[type]) listeners[type](); },
    _listeners: listeners
  };
  const sandbox = { console, performance: { now: () => 0 }, document };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'game.js' });
  const leaked = Object.keys(sandbox).filter(k => !['console', 'performance', 'document', 'window', 'DunkGame'].includes(k));
  assert.deepStrictEqual(leaked, [], 'game.js must not leak globals');
  assert.ok(sandbox.DunkGame && typeof sandbox.DunkGame.create === 'function', 'DunkGame.create exported');
  return { DunkGame: sandbox.DunkGame, document };
}

const { DunkGame, document } = loadEngine();
const T = DunkGame.TUNING;
const I = DunkGame.internals;
const RANGE = T.MUG_MAX_X - T.MUG_MIN_X;
const CATCH_HALF = T.MUG_HALF_WIDTH * T.CATCH_HALF_FRAC;
const toX01 = x => Math.min(1, Math.max(0, (x - T.MUG_MIN_X) / RANGE));

/* ---------------------------------------------------------------- runner */
const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); console.log('  ok   ' + name); }
  catch (e) { results.push({ name, ok: false, err: e }); console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
}

/** Drive a full round with a scripted player at 30 Hz. */
function runRound({ seed, player, duration = 45, difficulty = 'normal', tick = 1 / 30, onTickHook }) {
  const events = [];
  let endResult = null, endCount = 0;
  const game = DunkGame.create({
    canvas: null, sprites: null, duration, seed, difficulty,
    onEvent: e => events.push(e),
    onEnd: r => { endResult = r; endCount++; }
  });
  game.start();
  let maxItems = 0, minScore = Infinity, t = 0;
  while (game.getState().phase !== 'ended' && t < duration + 5) {
    const st = game.getState();
    const items = game.getItems();
    if (items.length > maxItems) maxItems = items.length;
    if (st.score < minScore) minScore = st.score;
    if (player) { const x01 = player(st, items, t); if (x01 !== null && x01 !== undefined) game.setTargetX(x01); }
    if (onTickHook) onTickHook(game, st, t);
    game.advance(tick);
    t += tick;
  }
  return { game, state: game.getState(), events, endResult, endCount, maxItems, minScore };
}

/** Perfect-ish player: chase the wafer nearest the rim, step aside for a bad that gets there first. */
function perfectPlayer(st, items) {
  let wafer = null, bad = null;
  for (const it of items) {
    if (it.resolved || it.y > T.MUG_RIM_Y + T.CATCH_BAND) continue;
    if (!it.bad) { if (!wafer || it.y > wafer.y) wafer = it; }
    else if (!bad || it.y > bad.y) bad = it;
  }
  let target = wafer ? wafer.x : st.mugX;
  if (bad && bad.y > T.MUG_RIM_Y - 420 && (!wafer || bad.y > wafer.y) && Math.abs(bad.x - target) < CATCH_HALF + 40) {
    // dodge to whichever side keeps us inside the range, preferring the wafer side
    const side = wafer && wafer.x < bad.x ? -1 : (wafer ? 1 : (bad.x > (T.MUG_MIN_X + T.MUG_MAX_X) / 2 ? -1 : 1));
    target = bad.x + side * (CATCH_HALF + 60);
  }
  return toX01(target);
}

/* ------------------------------------------------------------ pure parts */
console.log('pure helpers');

test('PRNG is deterministic and in [0,1)', () => {
  const a = I.createRng(42), b = I.createRng(42), c = I.createRng(43);
  const sa = [], sb = [], sc = [];
  for (let i = 0; i < 100; i++) { sa.push(a()); sb.push(b()); sc.push(c()); }
  assert.deepStrictEqual(sa, sb);
  assert.notDeepStrictEqual(sa, sc);
  assert.ok(sa.every(v => v >= 0 && v < 1));
});

test('spring is critically damped: converges without overshoot', () => {
  const s = { x: 0, v: 0 };
  let maxX = -Infinity, settled = null;
  for (let i = 0; i < 240; i++) {
    I.springStep(s, 100, T.SPRING_OMEGA, T.DT);
    if (s.x > maxX) maxX = s.x;
    if (settled === null && Math.abs(100 - s.x) < 1) settled = (i + 1) * T.DT;
  }
  assert.ok(maxX <= 100 + 1e-6, 'overshoot ' + maxX);
  assert.ok(Math.abs(100 - s.x) < 0.01, 'did not converge: ' + s.x);
  assert.ok(settled < 0.6, 'settles within 0.6 s (got ' + settled + ')');
});

test('schedule ramps speed 420->820 and interval 1.0->0.5', () => {
  const a = I.schedule(0, 45), b = I.schedule(45, 45), m = I.schedule(22.5, 45);
  assert.strictEqual(a.speed, T.SPEED_START); assert.strictEqual(a.interval, T.SPAWN_START);
  assert.strictEqual(b.speed, T.SPEED_END); assert.strictEqual(b.interval, T.SPAWN_END);
  assert.ok(Math.abs(m.speed - (T.SPEED_START + T.SPEED_END) / 2) < 1e-9);
  const h = I.schedule(0, 45, T, T.DIFFICULTY.hard);
  assert.ok(h.speed > a.speed && h.interval < a.interval);
});

test('catchTest respects the rim band and the catch half-width', () => {
  const rim = T.MUG_RIM_Y, mug = 540;
  assert.ok(I.catchTest(mug, rim, mug));
  assert.ok(I.catchTest(mug + CATCH_HALF - 1, rim - T.CATCH_BAND, mug));
  assert.ok(!I.catchTest(mug + CATCH_HALF + 1, rim, mug));
  assert.ok(!I.catchTest(mug, rim - T.CATCH_BAND - 1, mug));
  assert.ok(!I.catchTest(mug, rim + T.CATCH_BAND + 1, mug));
});

test('pickKind: wafers only during warm-up, lane cooldown and global cap for bads', () => {
  const rng = I.createRng(7);
  const lanes = Array.from({ length: T.LANES }, () => ({ lastBadAt: -Infinity }));
  for (let i = 0; i < 200; i++) assert.strictEqual(I.pickKind(rng, 1, 1, 0, lanes, 0), 'wafer');
  lanes[0].lastBadAt = 10;
  for (let i = 0; i < 200; i++) assert.strictEqual(I.pickKind(rng, 20, 10.5, 0, lanes, 0), 'wafer');
  for (let i = 0; i < 200; i++) assert.strictEqual(I.pickKind(rng, 20, 20, 1, lanes, T.MAX_CONSECUTIVE_BADS), 'wafer');
  let bads = 0;
  for (let i = 0; i < 2000; i++) if (I.pickKind(rng, 20, 20, 1, lanes, 0) !== 'wafer') bads++;
  const expect = (T.MIX.alarm + T.MIX.deadline) / (T.MIX.wafer + T.MIX.alarm + T.MIX.deadline);
  assert.ok(Math.abs(bads / 2000 - expect) < 0.04, 'bad share ' + bads / 2000);
});

/* ------------------------------------------------------------- full runs */
console.log('simulated rounds');

const PERFECT_SEED = 20251126;
const perfect = runRound({ seed: PERFECT_SEED, player: perfectPlayer });

test('round ends exactly at the duration with a single onEnd', () => {
  assert.strictEqual(perfect.state.phase, 'ended');
  assert.strictEqual(perfect.state.timeLeft, 0);
  assert.strictEqual(perfect.endCount, 1);
  assert.ok(Math.abs(perfect.endResult.durationPlayed - 45) < 1e-6, 'durationPlayed ' + perfect.endResult.durationPlayed);
  assert.strictEqual(perfect.endResult.stopped, false);
  assert.strictEqual(perfect.events.filter(e => e.type === 'end').length, 1);
});

test('perfect player score is within the expected band', () => {
  const s = perfect.state;
  const spawned = perfect.events.filter(e => e.type === 'spawn');
  const wafers = spawned.filter(e => e.kind === 'wafer').length;
  console.log(`       score=${s.score} caught=${s.caught} missed=${s.missed} hits=${s.hits} dodged=${s.dodged} best=${s.bestStreak} spawned=${spawned.length} (wafers ${wafers})`);
  assert.ok(s.score >= 40 && s.score <= 75, 'score ' + s.score);
  assert.ok(s.caught >= 0.8 * (wafers - 3), 'caught most wafers: ' + s.caught + '/' + wafers);
  assert.ok(s.missed <= 6, 'misses ' + s.missed);
  assert.ok(s.hits <= 6, 'hits ' + s.hits);   // 40-seed sweep: 0..5 with the simple dodge heuristic
  assert.strictEqual(s.caught + s.missed + s.hits + s.dodged <= spawned.length, true);
});

test('spawn mix: warm-up is wafers only, then roughly 65/20/15', () => {
  const spawned = perfect.events.filter(e => e.type === 'spawn');
  assert.ok(spawned.filter(e => e.t < T.WAFERS_ONLY_SECONDS).every(e => e.kind === 'wafer'));
  const late = spawned.filter(e => e.t >= T.WAFERS_ONLY_SECONDS);
  const bad = late.filter(e => e.kind !== 'wafer').length / late.length;
  assert.ok(bad > 0.15 && bad < 0.45, 'bad share after warm-up ' + bad.toFixed(2));
});

test('never two bads back to back in the same lane within 0.8 s; <= 2 bads in a row', () => {
  const spawned = perfect.events.filter(e => e.type === 'spawn');
  const lastBad = {};
  let run = 0;
  for (const e of spawned) {
    const isBad = e.kind !== 'wafer';
    if (isBad) {
      if (lastBad[e.lane] !== undefined) assert.ok(e.t - lastBad[e.lane] >= T.BAD_LANE_COOLDOWN - 1e-9, `lane ${e.lane}: bads at ${lastBad[e.lane]} and ${e.t}`);
      lastBad[e.lane] = e.t;
      run++; assert.ok(run <= T.MAX_CONSECUTIVE_BADS, 'consecutive bads ' + run);
    } else run = 0;
  }
});

test('items never exceed the pool size and spawn gaps follow the ramp', () => {
  assert.ok(perfect.maxItems <= T.ITEM_POOL, 'max items ' + perfect.maxItems);
  const spawned = perfect.events.filter(e => e.type === 'spawn');
  for (let i = 1; i < spawned.length; i++) {
    const gap = spawned[i].t - spawned[i - 1].t;
    const sch = I.schedule(spawned[i - 1].t, 45);
    assert.ok(gap >= sch.interval * (1 - T.SPAWN_JITTER) - 0.02 && gap <= sch.interval * (1 + T.SPAWN_JITTER) + 0.1, `gap ${gap.toFixed(3)} at t=${spawned[i].t.toFixed(2)} (interval ${sch.interval.toFixed(3)})`);
  }
});

test('events: catch carries score/streak/x; streak fires every 3rd; final5 once', () => {
  const catches = perfect.events.filter(e => e.type === 'catch');
  assert.strictEqual(catches.length, perfect.state.caught);
  for (const c of catches) {
    assert.strictEqual(typeof c.score, 'number'); assert.strictEqual(typeof c.streak, 'number'); assert.strictEqual(typeof c.x, 'number');
    assert.ok(c.x >= T.MUG_MIN_X - 100 && c.x <= T.MUG_MAX_X + 100);
  }
  const streaks = perfect.events.filter(e => e.type === 'streak');
  assert.ok(streaks.length > 0 && streaks.every(s => s.n % T.STREAK_EVERY === 0));
  const final5 = perfect.events.filter(e => e.type === 'final5');
  assert.strictEqual(final5.length, 1);
  assert.ok(final5[0].timeLeft <= T.FINAL_SECONDS + 1e-9);
  // score = caught + streak bonuses - penalties (never below 0)
  const bonuses = streaks.length * T.STREAK_BONUS;
  assert.ok(perfect.state.score <= perfect.state.caught + bonuses);
  assert.ok(perfect.minScore >= 0);
});

test('same seed reproduces the round; different seed differs', () => {
  const again = runRound({ seed: PERFECT_SEED, player: perfectPlayer });
  const log = r => r.events.filter(e => e.type === 'spawn').map(e => `${e.kind}@${e.lane}:${e.t.toFixed(4)}`);
  assert.deepStrictEqual(log(again), log(perfect));
  assert.strictEqual(again.state.score, perfect.state.score);
  const other = runRound({ seed: PERFECT_SEED + 1, player: perfectPlayer });
  assert.notDeepStrictEqual(log(other), log(perfect));
});

test('frozen player: misses are counted, score never negative', () => {
  const frozen = runRound({ seed: 99, player: null });
  const s = frozen.state;
  const wafers = frozen.events.filter(e => e.type === 'spawn' && e.kind === 'wafer').length;
  console.log(`       frozen: score=${s.score} caught=${s.caught} missed=${s.missed} hits=${s.hits}`);
  assert.ok(s.missed > 0, 'missed ' + s.missed);
  assert.strictEqual(frozen.events.filter(e => e.type === 'miss').length, s.missed);
  assert.ok(s.caught + s.missed <= wafers);
  assert.ok(s.caught + s.missed >= wafers - 3, 'every wafer that reached the rim band was caught or missed');
  assert.ok(frozen.minScore >= 0 && s.score >= 0);
  assert.strictEqual(s.phase, 'ended');
});

test('greedy player hits bads: penalty, stun, hit events', () => {
  const greedy = (st, items) => {
    let low = null;
    for (const it of items) if (!it.resolved && (!low || it.y > low.y)) low = it;
    return low ? toX01(low.x) : null;
  };
  let sawStun = false;
  const r = runRound({ seed: 5, player: greedy, onTickHook: (g, st) => { if (st.stunned) sawStun = true; } });
  const hits = r.events.filter(e => e.type === 'hit');
  assert.ok(hits.length > 0, 'expected hits');
  assert.strictEqual(hits.length, r.state.hits);
  assert.ok(hits.every(h => h.kind === 'alarm' || h.kind === 'deadline'));
  assert.ok(sawStun, 'stunned flag seen');
  assert.ok(r.minScore >= 0);
});

test('difficulty presets change the pace', () => {
  const easy = runRound({ seed: 3, player: null, difficulty: 'easy' }).events.filter(e => e.type === 'spawn');
  const hard = runRound({ seed: 3, player: null, difficulty: 'hard' }).events.filter(e => e.type === 'spawn');
  assert.ok(hard.length > easy.length, `hard ${hard.length} > easy ${easy.length}`);
});

/* ----------------------------------------------------- pause / tracking */
console.log('pause and tracking');

test('tracking lost pauses after 2 s, regained resumes after 0.5 s, timer frozen meanwhile', () => {
  const events = [];
  const game = DunkGame.create({ canvas: null, duration: 45, seed: 1, onEvent: e => events.push(e) });
  game.start();
  game.advance(3);
  game.setTracking(false);
  game.advance(1.9);
  assert.strictEqual(game.getState().phase, 'playing');
  game.advance(0.2);
  assert.strictEqual(game.getState().phase, 'paused');
  assert.strictEqual(game.getState().pauseReason, 'lost');
  assert.strictEqual(events.filter(e => e.type === 'lost').length, 1);
  const frozen = game.getState().timeLeft;
  game.advance(2);
  assert.strictEqual(game.getState().timeLeft, frozen);
  game.setTracking(true);
  assert.strictEqual(events.filter(e => e.type === 'regained').length, 1);
  game.advance(0.3);
  assert.strictEqual(game.getState().phase, 'paused');
  game.advance(0.3);
  assert.strictEqual(game.getState().phase, 'playing');
  game.advance(1);
  assert.ok(game.getState().timeLeft < frozen - 0.9);
  // a short blip (< grace) never pauses
  game.setTracking(false); game.advance(1); game.setTracking(true); game.advance(2);
  assert.strictEqual(events.filter(e => e.type === 'lost').length, 1);
  assert.strictEqual(game.getState().phase, 'playing');
  game.destroy();
});

test('pause()/resume() and document.hidden freeze the timer', () => {
  const game = DunkGame.create({ canvas: null, duration: 45, seed: 2 });
  game.start(); game.advance(1);
  game.pause();
  const t1 = game.getState().timeLeft;
  game.advance(1.5);
  assert.strictEqual(game.getState().phase, 'paused');
  assert.strictEqual(game.getState().timeLeft, t1);
  game.resume(); game.advance(0.5);
  assert.strictEqual(game.getState().phase, 'playing');
  assert.ok(game.getState().timeLeft < t1);
  document.hidden = true; document._fire('visibilitychange');
  const t2 = game.getState().timeLeft;
  game.advance(1);
  assert.strictEqual(game.getState().pauseReason, 'hidden');
  assert.strictEqual(game.getState().timeLeft, t2);
  document.hidden = false; document._fire('visibilitychange');
  game.advance(0.1);
  assert.strictEqual(game.getState().phase, 'playing');
  game.destroy();
  assert.strictEqual(Object.keys(document._listeners).length, 0, 'destroy removes listeners');
});

test('stop() ends early with durationPlayed < duration; mugX01 tracks the spring', () => {
  let res = null;
  const game = DunkGame.create({ canvas: null, duration: 45, seed: 3, onEnd: r => { res = r; } });
  game.setTargetX(0.25);                       // idle: snaps
  assert.ok(Math.abs(game.getState().mugX01 - 0.25) < 1e-9);
  game.start();
  game.setTargetX(1);
  game.advance(0.05);
  const mid = game.getState().mugX01;
  assert.ok(mid > 0.25 && mid < 1, 'spring in flight ' + mid);
  game.advance(1);
  assert.ok(Math.abs(game.getState().mugX01 - 1) < 0.01);
  assert.ok(Math.abs(game.getState().mugX - T.MUG_MAX_X) < 1);
  game.advance(3);
  game.stop();
  assert.ok(res && res.stopped && res.durationPlayed > 4 && res.durationPlayed < 5);
  assert.strictEqual(game.getState().phase, 'ended');
  game.destroy();
});

/* -------------------------------------------------------------- summary */
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
