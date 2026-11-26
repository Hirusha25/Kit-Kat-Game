#!/usr/bin/env node
/*
 * Writes a synthetic recorded round in the same format the kiosk recorder (js/recorder.js) uploads:
 * meta.json, telemetry.json.gz, frames.bin.gz and labels.json (the true mug position of every frame).
 * Used to test the upload endpoint, the review page and tests/tracker/replay.js without a kiosk.
 *
 *   node tests/tracker/make-debug-session.js <out-dir> [frames=60]
 */
'use strict';
var fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
var MugTracker = require('../../js/tracker.js'), synth = require('./synth.js');

var out = process.argv[2], N = parseInt(process.argv[3] || '60', 10);
if (!out) { console.error('usage: make-debug-session.js <out-dir> [frames]'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });

var W = 160, H = 90, COLS = ['t', 'found', 'x', 'y', 'w', 'h', 'score', 'sWhite', 'sAspect', 'sArea', 'sFill', 'sInner', 'sTemp', 'cand', 'redArea', 'whiteRatio', 'tracking', 'sx', 'fps'];
var p = Object.assign({}, MugTracker.defaultParams), rows = [], labels = {}, ts = [], bin = Buffer.alloc(N * W * H * 3), sx = 0.5, lastSeen = -1e9;
function r4(v) { return Math.round(v * 10000) / 10000; }
for (var i = 0; i < N; i++) {
  var t = 1000 + i * 500, x = 0.5 + 0.3 * Math.sin(i / 6);
  // every 10th frame has no mug at all, so "lost" paths and "none" labels are exercised too
  var none = i % 10 === 9;
  var f = none ? synth.renderNegativeFrame({ width: W, height: H, seed: 900 + i }) : synth.renderMugFrame({ width: W, height: H, seed: 100 + i, mugX: x, mugY: 0.5, occlude: false });
  var d = f.data;
  for (var a = 0; a < W * H; a++) { bin[(i * W * H + a) * 3] = d[a * 4]; bin[(i * W * H + a) * 3 + 1] = d[a * 4 + 1]; bin[(i * W * H + a) * 3 + 2] = d[a * 4 + 2]; }
  var res = MugTracker.detect({ data: new Uint8ClampedArray(d), width: W, height: H }, p);
  p.prevX = res.found ? res.x : -1; p.prevY = res.found ? res.y : -1;
  if (res.found) { sx = res.x; lastSeen = t; }
  rows.push([t, res.found ? 1 : 0, r4(res.x), r4(res.y), r4(res.w), r4(res.h), r4(res.score)].concat(res.sub.map(r4), [res.candidates, res.redArea, r4(res.whiteRatio), t - lastSeen <= 600 ? 1 : 0, r4(sx), 30]));
  labels[t] = none ? { none: true } : { x: r4(f.truth.x), y: r4(f.truth.y) };
  ts.push(t);
}
var id = crypto.randomUUID();
var meta = { id: id, v: 1, mode: 'public', startedAt: new Date().toISOString(), page: '/synthetic', ua: 'make-debug-session.js', flags: ['synthetic'],
  tracker: { width: W, height: H }, paramsStart: MugTracker.defaultParams, paramsEnd: MugTracker.defaultParams, camera: { label: 'synthetic', settings: { width: 640, height: 360, frameRate: 30 }, capabilities: {} },
  frames: { w: W, h: H, channels: 3, count: N, t: ts }, endedReason: 'ended', result: { score: 0 }, durationMs: N * 500, videoStartMs: null };
var events = [{ t: 1000, type: 'play', data: null }, { t: 1000 + N * 500, type: 'end', data: null }];
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta));
fs.writeFileSync(path.join(out, 'telemetry.json.gz'), zlib.gzipSync(JSON.stringify({ cols: COLS, rows: rows, events: events })));
fs.writeFileSync(path.join(out, 'frames.bin.gz'), zlib.gzipSync(bin));
fs.writeFileSync(path.join(out, 'labels.json'), JSON.stringify(labels));
console.log(id);
