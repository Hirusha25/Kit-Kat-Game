#!/usr/bin/env node
/*
 * Unit / accuracy test for MugTracker.detect on synthetic frames. Plain Node, no deps.
 *   node tests/tracker/detect.test.js            (exit code 1 on failure)
 *   node tests/tracker/detect.test.js --dump     (also writes failing frames as PPM to the scratch dir)
 */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var synth = require('./synth.js');

// Load js/tracker.js exactly as a browser would: as a script in a fresh global context.
var src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'tracker.js'), 'utf8');
var sandbox = {};
vm.runInNewContext(src, sandbox, { filename: 'tracker.js' });
var MugTracker = sandbox.MugTracker;

var failures = [];
function check(cond, msg) { if (!cond) failures.push(msg); console.log((cond ? '  ok   ' : '  FAIL ') + msg); }
function pad(v, n) { v = String(v); while (v.length < n) v = ' ' + v; return v; }

// ---------------------------------------------------------------- API surface
console.log('API');
check(Object.keys(sandbox).join() === 'MugTracker', 'only MugTracker leaks into the global scope (' + Object.keys(sandbox).join() + ')');
check(typeof MugTracker.detect === 'function' && typeof MugTracker.create === 'function' && typeof MugTracker.listCameras === 'function', 'detect/create/listCameras exposed');
check(MugTracker.defaultParams && typeof MugTracker.defaultParams.redMin === 'number', 'defaultParams exposed');
var P = Object.assign({}, MugTracker.defaultParams);

// ---------------------------------------------------------------- positives
function runPositives(W, H, count, seedBase) {
  var found = 0, errSum = 0, errMax = 0, occFound = 0, occN = 0, worst = [];
  for (var i = 0; i < count; i++) {
    var f = synth.renderMugFrame({ width: W, height: H, seed: seedBase + i });
    var r = MugTracker.detect(f, P);
    if (f.truth.occluded) occN++;
    if (r.found) {
      found++;
      if (f.truth.occluded) occFound++;
      var e = Math.abs(r.x - f.truth.x);
      errSum += e; if (e > errMax) errMax = e;
      if (e > 0.03) worst.push({ seed: seedBase + i, err: e.toFixed(3), x: r.x.toFixed(3), tx: f.truth.x.toFixed(3) });
    } else {
      worst.push({ seed: seedBase + i, miss: true, score: r.score.toFixed(2), wr: r.whiteRatio.toFixed(2), cands: r.candidates, mugW: f.truth.mugW.toFixed(3), bg: f.truth.bg.map(Math.round).join(',') });
    }
  }
  return { found: found, count: count, rate: found / count, meanErr: found ? errSum / found : 1, maxErr: errMax, occN: occN, occFound: occFound, worst: worst };
}

var sizes = [[160, 90], [320, 180]];
var totalFound = 0, totalN = 0, totalErr = 0;
console.log('\nPositives (white mug + red logo, random backgrounds incl. red/white, 40% finger occlusion)');
sizes.forEach(function (s, si) {
  var res = runPositives(s[0], s[1], 200, 1000 + si * 10000);
  totalFound += res.found; totalN += res.count; totalErr += res.meanErr * res.found;
  console.log('  ' + s[0] + 'x' + s[1] + ': found ' + res.found + '/' + res.count + ' (' + (res.rate * 100).toFixed(1) + '%)' +
              '  mean|dx| ' + res.meanErr.toFixed(4) + '  max|dx| ' + res.maxErr.toFixed(4) +
              '  occluded found ' + res.occFound + '/' + res.occN);
  check(res.rate >= 0.95, s[0] + 'x' + s[1] + ' found rate >= 95%');
  check(res.meanErr <= 0.03, s[0] + 'x' + s[1] + ' mean |x error| <= 0.03');
  if (res.worst.length && process.argv.indexOf('-v') >= 0) res.worst.slice(0, 12).forEach(function (w) { console.log('     ', JSON.stringify(w)); });
});

// ---------------------------------------------------------------- negatives
console.log('\nNegatives (red/white clothing, skin, red accents, no white mug)');
var fp = 0, fpList = [];
for (var i = 0; i < 100; i++) {
  var f = synth.renderNegativeFrame({ width: 160, height: 90, seed: 5000 + i });
  var r = MugTracker.detect(f, P);
  if (r.found) { fp++; fpList.push({ seed: 5000 + i, score: r.score.toFixed(2), wr: r.whiteRatio.toFixed(2), area: r.redArea }); }
}
console.log('  160x90: false positives ' + fp + '/100');
check(fp <= 2, 'false positive rate <= 2%');
if (fpList.length && process.argv.indexOf('-v') >= 0) fpList.forEach(function (w) { console.log('     ', JSON.stringify(w)); });

// ---------------------------------------------------------------- temporal + merge sanity
console.log('\nBehaviour');
(function () {
  var f = synth.renderMugFrame({ width: 160, height: 90, seed: 42, mugX: 0.7, occlude: false });
  var r1 = MugTracker.detect(f, P), s1 = r1.score, f1 = r1.found, y1 = r1.y;
  var r2 = MugTracker.detect(f, Object.assign({}, P, { prevX: 0.7, prevY: y1 }));
  check(f1 && r2.found && r2.score > s1 + 0.04, 'temporal proximity raises the score (' + s1.toFixed(3) + ' -> ' + r2.score.toFixed(3) + ')');
  var r3 = MugTracker.detect(f, Object.assign({}, P, { prevX: 0.1, prevY: 0.1 }));
  check(r3.found && r3.score < s1, 'a far previous position lowers the score (' + r3.score.toFixed(3) + ')');
  // sensitivity: a very strict threshold rejects, a lax one accepts
  check(!MugTracker.detect(f, Object.assign({}, P, { threshold: 0.99 })).found, 'threshold 0.99 rejects');
  check(MugTracker.detect(f, Object.assign({}, P, { threshold: 0.47 })).found, 'threshold 0.47 accepts');
  // a red blob with no white around it never passes, whatever its shape
  var g = new synth.Frame(160, 90); g.fill([40, 40, 40]); g.ellipse(80, 45, 8, 5, [190, 0, 20]);
  var rg = MugTracker.detect(g, Object.assign({}, P, { threshold: 0.47 }));
  check(!rg.found, 'logo-shaped red blob without a white ring is rejected (score ' + rg.score.toFixed(2) + ')');
  // the same blob on a white mug passes
  g.fill([40, 40, 40]); g.roundRect(60, 25, 40, 46, 4, [245, 245, 240]); g.ellipse(80, 45, 8, 5, [190, 0, 20]); g.ellipse(80, 45, 6, 3, [245, 245, 240]);
  var rw = MugTracker.detect(g, P);
  check(rw.found && Math.abs(rw.x - 0.5) < 0.01 && Math.abs(rw.y - 0.5) < 0.02, 'red oval on white body is found at the right place (' + rw.x.toFixed(3) + ',' + rw.y.toFixed(3) + ')');
  // a split logo (gap of 2 px) is merged into one box
  g.fill([40, 40, 40]); g.roundRect(55, 25, 50, 46, 4, [245, 245, 240]);
  g.rect(68, 41, 8, 8, [190, 0, 20]); g.rect(76, 41, 2, 8, [224, 172, 140]); g.rect(78, 41, 8, 8, [190, 0, 20]);
  var rm = MugTracker.detect(g, P);
  check(rm.found && Math.abs(rm.w * 160 - 18) < 0.5 && Math.abs(rm.x - 77 / 160) < 0.004, 'two red fragments 2 px apart merge into one 18 px box (w=' + (rm.w * 160).toFixed(1) + ', x=' + (rm.x * 160).toFixed(1) + ')');
  g.rect(68, 41, 8, 8, [190, 0, 20]); g.rect(76, 41, 6, 8, [224, 172, 140]); g.rect(82, 41, 8, 8, [190, 0, 20]);
  var rn = MugTracker.detect(g, P);
  check(rn.found && Math.abs(rn.w * 160 - 8) < 0.5, 'fragments 6 px apart are not merged (w=' + (rn.w * 160).toFixed(1) + ')');
  // result object is reused but the frame buffers are not reallocated across calls of the same size
  check(MugTracker.detect(f, P) === r1, 'result object is reused (documented)');
})();

// ---------------------------------------------------------------- benchmark
console.log('\nBenchmark');
sizes.forEach(function (s) {
  var frames = [];
  for (var i = 0; i < 20; i++) frames.push(synth.renderMugFrame({ width: s[0], height: s[1], seed: 7000 + i }));
  for (var w = 0; w < 100; w++) MugTracker.detect(frames[w % 20], P);   // warm-up / JIT
  var N = 600, t0 = process.hrtime.bigint();
  for (var k = 0; k < N; k++) MugTracker.detect(frames[k % 20], P);
  var ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log('  ' + pad(s[0] + 'x' + s[1], 8) + ': ' + ms.toFixed(3) + ' ms/frame (' + N + ' frames)');
  if (s[0] === 160) check(ms < 2, '160x90 detect under 2 ms/frame');
});

console.log('\n' + (failures.length ? failures.length + ' FAILED:\n  ' + failures.join('\n  ') : 'ALL PASSED'));
process.exit(failures.length ? 1 : 0);
