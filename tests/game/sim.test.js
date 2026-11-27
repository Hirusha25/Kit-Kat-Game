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
const DURATION = 40;
const RANGE = T.MUG_MAX_X - T.MUG_MIN_X;
const CATCH_HALF = T.MUG_HALF_WIDTH * T.CATCH_HALF_FRAC;
const toX01 = x => Math.min(1, Math.max(0, (x - T.MUG_MIN_X) / RANGE));
const isGood = k => k === 'wafer' || k === 'gold' || k === 'bonus-time';

/* ---------------------------------------------------------------- runner */
const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); console.log('  ok   ' + name); }
  catch (e) { results.push({ name, ok: false, err: e }); console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
}

/** Drive a full round with a scripted player at 30 Hz. */
function runRound({ seed, player, duration = DURATION, difficulty = 'normal', reducedEffects = false, tick = 1 / 30, onTickHook }) {
  const events = [];
  let endResult = null, endCount = 0;
  const game = DunkGame.create({
    canvas: null, sprites: null, duration, seed, difficulty, reducedEffects,
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

/** Perfect-ish player: chase the good item nearest the rim, step aside for a hazard that gets there first. */
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

const spawnsOf = r => r.events.filter(e => e.type === 'spawn');

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

test(`schedule ramps speed ${T.SPEED_START}->${T.SPEED_END} and interval ${T.SPAWN_START}->${T.SPAWN_END}`, () => {
  const a = I.schedule(0, DURATION), b = I.schedule(DURATION, DURATION), m = I.schedule(DURATION / 2, DURATION);
  const near = (x, y) => Math.abs(x - y) < 1e-9;
  assert.ok(near(a.speed, T.SPEED_START) && near(a.interval, T.SPAWN_START), 'start of ramp');
  assert.ok(near(b.speed, T.SPEED_END) && near(b.interval, T.SPAWN_END), 'end of ramp');
  assert.ok(Math.abs(m.speed - (T.SPEED_START + T.SPEED_END) / 2) < 1e-9);
  const h = I.schedule(0, DURATION, T, T.DIFFICULTY.hard), e = I.schedule(0, DURATION, T, T.DIFFICULTY.easy);
  assert.ok(h.speed > a.speed && h.interval < a.interval);
  assert.ok(e.speed < a.speed && e.interval > a.interval);
});

test('catchTest respects the rim band and the catch half-width', () => {
  const rim = T.MUG_RIM_Y, mug = 540;
  assert.ok(I.catchTest(mug, rim, mug));
  assert.ok(I.catchTest(mug + CATCH_HALF - 1, rim - T.CATCH_BAND, mug));
  assert.ok(!I.catchTest(mug + CATCH_HALF + 1, rim, mug));
  assert.ok(!I.catchTest(mug, rim - T.CATCH_BAND - 1, mug));
  assert.ok(!I.catchTest(mug, rim + T.CATCH_BAND + 1, mug));
});

test('layout: mug stays above the slider, spawn lanes stay inside the catchable range', () => {
  // mug.png body bottom is 0.698 of its height below the rim anchor (measured: rows 182 -> 810 of 900)
  const mugBottom = T.MUG_RIM_Y + 0.698 * 548 + T.MUG_BOB_AMP;
  assert.ok(mugBottom < 1575, 'mug bottom ' + mugBottom + ' must stay above the slider at 1575');
  assert.ok(T.KILL_Y <= 1560 && T.MISS_Y < T.KILL_Y);
  assert.ok(T.SPAWN_PAD < CATCH_HALF, 'SPAWN_PAD must be below the catch half-width');
  const laneW = (RANGE + 2 * T.SPAWN_PAD) / T.LANES;
  const extreme = laneW / 2 + laneW * T.LANE_JITTER + T.SWAY_AMP[1];
  assert.ok(T.MUG_MIN_X - T.SPAWN_PAD + extreme - CATCH_HALF > T.MUG_MIN_X - CATCH_HALF - 1e-9);
  assert.ok(T.MUG_MIN_X - T.SPAWN_PAD + (T.LANES - 0.5) * laneW + laneW * T.LANE_JITTER + T.SWAY_AMP[1] < T.MUG_MAX_X + CATCH_HALF, 'last lane reachable');
  assert.ok(T.MUG_MIN_X - T.SPAWN_PAD + 0.5 * laneW - laneW * T.LANE_JITTER - T.SWAY_AMP[1] > T.MUG_MIN_X - CATCH_HALF, 'first lane reachable');
});

test('pickKind: wafers only during warm-up, lane cooldown and global cap for hazards, gold share', () => {
  const rng = I.createRng(7);
  const lanes = Array.from({ length: T.LANES }, () => ({ lastBadAt: -Infinity }));
  for (let i = 0; i < 200; i++) assert.strictEqual(I.pickKind(rng, 1, 1, 0, lanes, 0), 'wafer');
  lanes[0].lastBadAt = 10;
  for (let i = 0; i < 200; i++) assert.notStrictEqual(I.pickKind(rng, 20, 10.5, 0, lanes, 0), 'hazard');
  for (let i = 0; i < 200; i++) assert.notStrictEqual(I.pickKind(rng, 20, 20, 1, lanes, T.MAX_CONSECUTIVE_BADS), 'hazard');
  let bads = 0, gold = 0, N = 6000;
  for (let i = 0; i < N; i++) { const k = I.pickKind(rng, 20, 20, 1, lanes, 0); if (k === 'hazard') bads++; else if (k === 'gold') gold++; }
  const expectBad = (1 - T.GOLD_SHARE) * T.MIX.hazard / (T.MIX.wafer + T.MIX.hazard);
  assert.ok(Math.abs(bads / N - expectBad) < 0.03, 'hazard share ' + (bads / N).toFixed(3) + ' expected ' + expectBad.toFixed(3));
  assert.ok(Math.abs(gold / N - T.GOLD_SHARE) < 0.015, 'gold share ' + (gold / N).toFixed(3));
  // no gold before GOLD_AFTER_SECONDS
  for (let i = 0; i < 500; i++) assert.notStrictEqual(I.pickKind(rng, T.GOLD_AFTER_SECONDS - 0.1, 20, 1, lanes, 0), 'gold');
  // easy/hard scale the hazard weight
  let be = 0, bh = 0;
  for (let i = 0; i < N; i++) { if (I.pickKind(rng, 20, 20, 1, lanes, 0, T, T.DIFFICULTY.easy) === 'hazard') be++; if (I.pickKind(rng, 20, 20, 1, lanes, 0, T, T.DIFFICULTY.hard) === 'hazard') bh++; }
  assert.ok(be < bads && bads < bh, `easy ${be} < normal ${bads} < hard ${bh}`);
});

test('pickHazard: uniform over the list, never the same as the previous pick', () => {
  const rng = I.createRng(11);
  const list = T.HAZARDS;
  const counts = {}; let last = null;
  for (let i = 0; i < 10000; i++) {
    const k = I.pickHazard(rng, list, last);
    assert.ok(list.includes(k));
    assert.notStrictEqual(k, last, 'immediate repeat');
    counts[k] = (counts[k] || 0) + 1; last = k;
  }
  for (const k of list) assert.ok(Math.abs(counts[k] / 10000 - 1 / list.length) < 0.03, `${k} share ${counts[k] / 10000}`);
  assert.strictEqual(I.pickHazard(rng, ['alarm'], 'alarm'), 'alarm', 'single-entry list always returns it');
});

test('exports stay backwards compatible', () => {
  assert.strictEqual(DunkGame.KIND.WAFER, 'wafer');
  assert.strictEqual(DunkGame.KIND.GOLD, 'gold');
  assert.strictEqual(DunkGame.KIND.ALARM, 'alarm');
  assert.strictEqual(DunkGame.KIND.DEADLINE, 'deadline');
  assert.ok(DunkGame.BAD_KINDS.includes('alarm') && DunkGame.BAD_KINDS.includes('deadline'));
  assert.deepStrictEqual(DunkGame.HAZARDS, T.HAZARDS);
  assert.ok(T.HAZARDS.every(h => DunkGame.BAD_KINDS.includes(h)));
});

/* ------------------------------------------------------------- full runs */
console.log('simulated rounds (' + DURATION + ' s, normal)');

const PERFECT_SEED = 20251126;
const perfect = runRound({ seed: PERFECT_SEED, player: perfectPlayer });

test('round ends exactly at the duration with a single onEnd', () => {
  assert.strictEqual(perfect.state.phase, 'ended');
  assert.strictEqual(perfect.state.timeLeft, 0);
  assert.strictEqual(perfect.endCount, 1);
  assert.ok(Math.abs(perfect.endResult.durationPlayed - DURATION) < 1e-6, 'durationPlayed ' + perfect.endResult.durationPlayed);
  assert.strictEqual(perfect.endResult.stopped, false);
  assert.strictEqual(perfect.events.filter(e => e.type === 'end').length, 1);
  assert.strictEqual(perfect.endResult.gold, perfect.state.gold);
  assert.strictEqual(perfect.endResult.dodged, perfect.state.dodged);
});

test('perfect player score is within the expected band (harder tuning: faster ramp, mixed from 1.5 s)', () => {
  const s = perfect.state;
  const spawned = spawnsOf(perfect);
  const good = spawned.filter(e => isGood(e.kind)).length;
  console.log(`       score=${s.score} caught=${s.caught} gold=${s.gold} missed=${s.missed} hits=${s.hits} dodged=${s.dodged} best=${s.bestStreak} spawned=${spawned.length} (good ${good}, hazards ${spawned.length - good})`);
  assert.ok(s.score >= 55 && s.score <= 100, 'score ' + s.score);
  assert.ok(s.caught >= 0.8 * (good - 3), 'caught most wafers: ' + s.caught + '/' + good);
  assert.ok(s.missed <= 6, 'misses ' + s.missed);
  assert.ok(s.hits <= 12, 'hits ' + s.hits);  // hazards now aim at the mug's lane; the simple dodge heuristic takes more
  assert.ok(s.caught + s.missed + s.hits + s.dodged <= spawned.length);
});

test(`spawn mix: first ${T.WAFERS_ONLY_SECONDS} s wafers only, then a real hazard share; gold only after ${T.GOLD_AFTER_SECONDS} s`, () => {
  const spawned = spawnsOf(perfect);
  assert.ok(spawned.filter(e => e.t < T.WAFERS_ONLY_SECONDS).every(e => e.kind === 'wafer'));
  const late = spawned.filter(e => e.t >= T.WAFERS_ONLY_SECONDS);
  const bad = late.filter(e => e.bad).length / late.length;
  assert.ok(bad > 0.25 && bad < 0.6, 'hazard share after warm-up ' + bad.toFixed(2));
  assert.ok(spawned.filter(e => e.kind === 'gold').every(e => e.t >= T.GOLD_AFTER_SECONDS));
  for (const e of spawned) {
    assert.strictEqual(e.bad, !isGood(e.kind));
    assert.strictEqual(e.cls, e.bad ? 'hazard' : e.kind);
    if (e.bad) assert.ok(T.HAZARDS.includes(e.kind), 'hazard kind ' + e.kind);
  }
});

test('gold: about 6 % of spawns after 10 s (12-seed aggregate), hazards rotate through all of HAZARDS with no immediate repeat', () => {
  let n = 0, gold = 0, lastHazard = null;
  const seen = {};
  for (let seed = 100; seed < 112; seed++) {
    const r = runRound({ seed, player: null });
    lastHazard = null;
    for (const e of spawnsOf(r)) {
      if (e.t >= T.GOLD_AFTER_SECONDS) { n++; if (e.kind === 'gold') gold++; }
      if (e.bad) { assert.notStrictEqual(e.kind, lastHazard, `hazard ${e.kind} twice in a row (seed ${seed}, t=${e.t.toFixed(2)})`); lastHazard = e.kind; seen[e.kind] = true; }
    }
  }
  const share = gold / n;
  console.log(`       gold share after ${T.GOLD_AFTER_SECONDS} s: ${(share * 100).toFixed(1)} % of ${n} spawns; hazards seen: ${Object.keys(seen).join(', ')}`);
  assert.ok(share > T.GOLD_SHARE - 0.025 && share < T.GOLD_SHARE + 0.03, 'gold share ' + share.toFixed(3));
  for (const h of T.HAZARDS) assert.ok(seen[h], 'hazard never spawned: ' + h);
});

test('never two hazards in the same lane within the cooldown; <= MAX_CONSECUTIVE_BADS in a row', () => {
  for (const r of [perfect, runRound({ seed: 77, player: null }), runRound({ seed: 78, player: null, difficulty: 'hard' })]) {
    const lastBad = {};
    let run = 0;
    for (const e of spawnsOf(r)) {
      if (e.bad) {
        if (lastBad[e.lane] !== undefined) assert.ok(e.t - lastBad[e.lane] >= T.BAD_LANE_COOLDOWN - 1e-9, `lane ${e.lane}: hazards at ${lastBad[e.lane]} and ${e.t}`);
        lastBad[e.lane] = e.t;
        run++; assert.ok(run <= T.MAX_CONSECUTIVE_BADS, 'consecutive hazards ' + run);
      } else run = 0;
    }
  }
});

test('crossfire: hazard + wafer CROSSFIRE_GAP apart in adjacent lanes from CROSSFIRE_AFTER; doubles are two wafers DOUBLE_GAP apart', () => {
  const spawned = spawnsOf(perfect);
  const patterns = perfect.events.filter(e => e.type === 'pattern');
  const cross = patterns.filter(p => p.name === 'crossfire');
  assert.ok(cross.length >= 2, 'crossfires in the round: ' + cross.length);
  assert.ok(cross.every(p => p.t >= T.CROSSFIRE_AFTER - 1e-9));
  for (let i = 1; i < cross.length; i++) assert.ok(cross[i].t - cross[i - 1].t >= T.CROSSFIRE_EVERY * T.DIFFICULTY.normal.crossfire * (1 - T.CROSSFIRE_JITTER) - 0.05, 'crossfires too close');
  let pairs = 0, doubles = 0;
  for (let i = 1; i < spawned.length; i++) {
    const a = spawned[i - 1], b = spawned[i];
    if (a.pattern === 'crossfire' && b.pattern === 'crossfire' && b.t - a.t < 0.5) {
      pairs++;
      assert.ok(Math.abs((b.t - a.t) - T.CROSSFIRE_GAP) <= T.DT + 1e-9, `crossfire gap ${(b.t - a.t).toFixed(3)}`);
      assert.strictEqual(Math.abs(a.lane - b.lane), 1, 'crossfire lanes adjacent');
      assert.ok(a.bad !== b.bad, 'one hazard, one wafer');
    }
    if (a.pattern === 'double' && b.pattern === 'double' && b.t - a.t < 0.5) {
      doubles++;
      assert.ok(Math.abs((b.t - a.t) - T.DOUBLE_GAP) <= T.DT + 1e-9, `double gap ${(b.t - a.t).toFixed(3)}`);
      assert.strictEqual(Math.abs(a.lane - b.lane), 1, 'double lanes adjacent');
      assert.ok(!a.bad && !b.bad);
      assert.ok(a.t >= T.DOUBLE_AFTER - 1e-9);
    }
  }
  console.log(`       crossfires=${cross.length} (pairs ${pairs}) doubles=${doubles}`);
  assert.ok(pairs >= 1, 'at least one complete crossfire pair');
  assert.ok(patterns.filter(p => p.name === 'double').length >= 1 || doubles >= 1, 'a double appeared');
});

test('items never exceed the pool size and spawn gaps follow the ramp (pattern pairs excepted)', () => {
  const runs = [perfect, runRound({ seed: 5, player: null, difficulty: 'hard' }), runRound({ seed: 6, player: perfectPlayer, difficulty: 'hard' })];
  for (const r of runs) assert.ok(r.maxItems <= T.ITEM_POOL, 'max items ' + r.maxItems);
  console.log(`       max concurrent items: ${runs.map(r => r.maxItems).join(', ')} (pool ${T.ITEM_POOL})`);
  const spawned = spawnsOf(perfect);
  const maxPatternGap = Math.max(T.CROSSFIRE_GAP, T.DOUBLE_GAP);
  for (let i = 1; i < spawned.length; i++) {
    const a = spawned[i - 1], b = spawned[i];
    const gap = b.t - a.t;
    if (a.pattern && a.pattern === b.pattern && gap < 0.5) continue; // second item of a pair
    const sch = I.schedule(a.pattern ? a.t : a.t, DURATION);
    assert.ok(gap >= sch.interval * (1 - T.SPAWN_JITTER) - 0.02 && gap <= sch.interval * (1 + T.SPAWN_JITTER) + maxPatternGap + 0.1,
      `gap ${gap.toFixed(3)} at t=${b.t.toFixed(2)} (interval ${sch.interval.toFixed(3)})`);
  }
});

test('events: catch carries kind/points/score/streak/x; gold is +3; streak every 3rd; final10 then final5 once each; exact score replay', () => {
  const catches = perfect.events.filter(e => e.type === 'catch');
  assert.strictEqual(catches.length, perfect.state.caught);
  for (const c of catches) {
    assert.ok(isGood(c.kind), 'catch kind ' + c.kind);
    assert.strictEqual(c.points, c.kind === 'gold' ? T.GOLD_SCORE : 1);
    assert.strictEqual(typeof c.score, 'number'); assert.strictEqual(typeof c.streak, 'number'); assert.strictEqual(typeof c.x, 'number');
    assert.ok(c.x >= T.MUG_MIN_X - T.SPAWN_PAD - 100 && c.x <= T.MUG_MAX_X + T.SPAWN_PAD + 100);
  }
  assert.strictEqual(catches.filter(c => c.kind === 'gold').length, perfect.state.gold);
  const streaks = perfect.events.filter(e => e.type === 'streak');
  assert.ok(streaks.length > 0 && streaks.every(s => s.n % T.STREAK_EVERY === 0));
  const final10 = perfect.events.filter(e => e.type === 'final10'), final5 = perfect.events.filter(e => e.type === 'final5');
  assert.strictEqual(final10.length, 1); assert.strictEqual(final5.length, 1);
  assert.ok(final10[0].timeLeft <= T.FINAL_FX_SECONDS + 1e-9 && final5[0].timeLeft <= T.FINAL_SECONDS + 1e-9);
  assert.ok(perfect.events.indexOf(final10[0]) < perfect.events.indexOf(final5[0]));
  // replay the score from the event stream
  let s = 0;
  for (const e of perfect.events) {
    if (e.type === 'catch') { s += e.points; }
    else if (e.type === 'streak') { s += T.STREAK_BONUS; assert.strictEqual(e.score, s); }
    else if (e.type === 'hit') { s = Math.max(0, s - T.HIT_PENALTY); assert.strictEqual(e.score, s); }
  }
  assert.strictEqual(s, perfect.state.score, 'score replay');
  assert.ok(perfect.minScore >= 0);
  for (const e of perfect.events.filter(e => e.type === 'miss' || e.type === 'dodge' || e.type === 'hit')) assert.strictEqual(typeof e.kind, 'string');
});

test('gold catch scores +3 (seed with at least one gold catch)', () => {
  let r = null;
  for (let seed = 200; seed < 260 && !r; seed++) { const x = runRound({ seed, player: perfectPlayer }); if (x.state.gold >= 1) r = x; }
  assert.ok(r, 'found a round with a gold catch');
  const g = r.events.find(e => e.type === 'catch' && e.kind === 'gold');
  const before = r.events.slice(0, r.events.indexOf(g)).reverse().find(e => e.type === 'catch' || e.type === 'streak' || e.type === 'hit');
  const prev = before ? before.score : 0;
  const gain = g.score - prev; // +3, or +3 plus the streak bonus when the gold completes a streak
  assert.ok(gain === T.GOLD_SCORE || gain === T.GOLD_SCORE + T.STREAK_BONUS, `gold catch ${prev} -> ${g.score}`);
});

test('same seed reproduces the round; different seed differs; reducedEffects never changes gameplay', () => {
  const log = r => spawnsOf(r).map(e => `${e.kind}@${e.lane}:${e.t.toFixed(4)}`);
  const again = runRound({ seed: PERFECT_SEED, player: perfectPlayer });
  assert.deepStrictEqual(log(again), log(perfect));
  assert.strictEqual(again.state.score, perfect.state.score);
  const reduced = runRound({ seed: PERFECT_SEED, player: perfectPlayer, reducedEffects: true });
  assert.deepStrictEqual(log(reduced), log(perfect));
  assert.strictEqual(reduced.state.score, perfect.state.score);
  const other = runRound({ seed: PERFECT_SEED + 1, player: perfectPlayer });
  assert.notDeepStrictEqual(log(other), log(perfect));
});

test('frozen centred player: misses counted, score in the 2..32 band (40-seed sweep: 4..31, median 12), never negative', () => {
  const frozen = runRound({ seed: 99, player: null });
  const s = frozen.state;
  const good = spawnsOf(frozen).filter(e => isGood(e.kind)).length;
  console.log(`       frozen: score=${s.score} caught=${s.caught} missed=${s.missed} hits=${s.hits} dodged=${s.dodged}`);
  assert.ok(s.missed > 0, 'missed ' + s.missed);
  assert.ok(s.missed > s.caught, 'a frozen mug misses more than it catches');
  assert.strictEqual(frozen.events.filter(e => e.type === 'miss').length, s.missed);
  assert.ok(s.caught + s.missed <= good);
  assert.ok(s.caught + s.missed >= good - 3, 'every good item that reached the rim band was caught or missed');
  assert.ok(s.score >= 2 && s.score <= 32, 'frozen score ' + s.score);
  assert.ok(frozen.minScore >= 0 && s.score >= 0);
  assert.strictEqual(s.phase, 'ended');
});

test('greedy player hits hazards: penalty, stun, hit events with rotating kinds', () => {
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
  assert.ok(hits.every(h => T.HAZARDS.includes(h.kind)));
  assert.ok(new Set(hits.map(h => h.kind)).size >= 2, 'more than one hazard kind was hit');
  assert.ok(sawStun, 'stunned flag seen');
  assert.ok(r.minScore >= 0);
  assert.ok(r.maxItems <= T.ITEM_POOL);
});

test('difficulty presets change the pace and the hazard share', () => {
  let se = [], sh = [];
  for (let seed = 3; seed < 15; seed++) {
    se = se.concat(spawnsOf(runRound({ seed, player: null, difficulty: 'easy' })));
    sh = sh.concat(spawnsOf(runRound({ seed, player: null, difficulty: 'hard' })));
  }
  assert.ok(sh.length > se.length * 1.2, `hard ${sh.length} spawns > easy ${se.length}`);
  const badShare = s => s.filter(e => e.bad).length / s.length;
  console.log(`       12-seed hazard share after warm-up: easy ${badShare(se.filter(e => e.t >= T.WAFERS_ONLY_SECONDS)).toFixed(2)}, hard ${badShare(sh.filter(e => e.t >= T.WAFERS_ONLY_SECONDS)).toFixed(2)}`);
  assert.ok(badShare(sh) > badShare(se), `hazard share hard ${badShare(sh).toFixed(2)} > easy ${badShare(se).toFixed(2)}`);
  assert.ok(sh.every(e => e.t < DURATION) && se.every(e => e.t < DURATION));
});

test('SPAWN_ONLY_IF_REACHABLE: the last item can still reach the rim before the end', () => {
  for (const r of [perfect, runRound({ seed: 8, player: null, difficulty: 'easy' })]) {
    const last = spawnsOf(r).slice(-1)[0];
    const sch = I.schedule(last.t, DURATION, T, r.game.tuning.DIFFICULTY.normal);
    assert.ok((DURATION - last.t) * sch.speed * 1.2 >= T.MUG_RIM_Y - T.SPAWN_Y, `last spawn at ${last.t.toFixed(2)} cannot reach the rim`);
  }
});

/* ----------------------------------------------------- pause / tracking */
console.log('pause and tracking');

test('tracking lost pauses after 2 s, regained resumes after 0.5 s, timer frozen meanwhile', () => {
  const events = [];
  const game = DunkGame.create({ canvas: null, duration: DURATION, seed: 1, onEvent: e => events.push(e) });
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
  const game = DunkGame.create({ canvas: null, duration: DURATION, seed: 2 });
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
  const game = DunkGame.create({ canvas: null, duration: DURATION, seed: 3, onEnd: r => { res = r; } });
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
