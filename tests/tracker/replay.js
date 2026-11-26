#!/usr/bin/env node
/*
 * Replay bench: runs the detector over the exact frames of recorded kiosk rounds and prints how it did.
 *
 *   node tests/tracker/replay.js <session-dir> [<session-dir> ...] [--param name=value ...] [--min-right 0.9]
 *
 * A session directory holds the files downloaded from the review page (debug/): meta.json,
 * telemetry.json.gz, frames.bin.gz and, when frames were labelled there, labels.json.
 * Put kept rounds under tests/tracker/sessions/<name>/ to make them part of the regression set.
 *
 * For each round it reports, on the stored frames:
 *   kiosk found   frames where the kiosk reported the mug
 *   now found     frames where the current js/tracker.js reports it (with --param overrides)
 *   right         against the labels: found within 6% of the labelled centre, or correctly nothing
 * "Found" alone proves little (it may have found the wrong thing); "right" needs labels.
 * With --min-right the exit code is 1 when any labelled round scores below it.
 */
'use strict';
var fs = require('fs'), path = require('path'), zlib = require('zlib');
var MugTracker = require('../../js/tracker.js');

var args = process.argv.slice(2), dirs = [], overrides = {}, minRight = null;
for (var i = 0; i < args.length; i++) {
  if (args[i] === '--param') { var kv = args[++i].split('='); overrides[kv[0]] = parseFloat(kv[1]); }
  else if (args[i] === '--min-right') minRight = parseFloat(args[++i]);
  else dirs.push(args[i]);
}
if (!dirs.length) {
  var base = path.join(__dirname, 'sessions');
  if (fs.existsSync(base)) dirs = fs.readdirSync(base).map(function (d) { return path.join(base, d); }).filter(function (d) { return fs.statSync(d).isDirectory(); });
}
if (!dirs.length) { console.log('No sessions given and tests/tracker/sessions/ is empty. Nothing to replay.'); process.exit(0); }

function load(dir) {
  var meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  var tel = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'telemetry.json.gz'))).toString('utf8'));
  var frames = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'frames.bin.gz')));
  var labels = fs.existsSync(path.join(dir, 'labels.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'labels.json'), 'utf8')) : {};
  return { meta: meta, tel: tel, frames: frames, labels: labels };
}
function pct(a, b) { return b ? (100 * a / b).toFixed(1) + '%' : '   –  '; }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + new Array(n - s.length + 1).join(' '); }
function hit(found, x, y, L) { return L.none ? !found : (found && Math.abs(x - L.x) < 0.06 && Math.abs(y - L.y) < 0.1); }

var failed = false, tot = { n: 0, kiosk: 0, now: 0, lab: 0, kRight: 0, nRight: 0 };
console.log(pad('round', 26) + pad('frames', 8) + pad('kiosk found', 13) + pad('now found', 13) + pad('labels', 8) + pad('kiosk right', 13) + pad('now right', 11));
dirs.forEach(function (dir) {
  var s;
  try { s = load(dir); } catch (e) { console.log(pad(path.basename(dir), 26) + 'unreadable: ' + e.message); failed = true; return; }
  var f = s.meta.frames, W = f.w, H = f.h, n = f.count, c = {};
  s.tel.cols.forEach(function (name, k) { c[name] = k; });
  var rowAt = {}; s.tel.rows.forEach(function (r) { rowAt[r[0]] = r; });
  var p = Object.assign({}, MugTracker.defaultParams, s.meta.paramsEnd || s.meta.paramsStart || {}, overrides); p.prevX = -1; p.prevY = -1;
  var rgba = new Uint8ClampedArray(W * H * 4), img = { data: rgba, width: W, height: H };
  var r = { n: n, kiosk: 0, now: 0, lab: 0, kRight: 0, nRight: 0 };
  for (var k = 0; k < n; k++) {
    var src = s.frames.subarray(k * W * H * 3, (k + 1) * W * H * 3);
    for (var a = 0, b = 0; a < W * H; a++, b += 4) { rgba[b] = src[a * 3]; rgba[b + 1] = src[a * 3 + 1]; rgba[b + 2] = src[a * 3 + 2]; rgba[b + 3] = 255; }
    var res = MugTracker.detect(img, p), t = f.t[k], row = rowAt[t], kf = !!(row && row[c.found]);
    p.prevX = res.found ? res.x : -1; p.prevY = res.found ? res.y : -1;   // like the kiosk: last position is the hint
    r.kiosk += kf ? 1 : 0; r.now += res.found ? 1 : 0;
    var L = s.labels[t];
    if (L) { r.lab++; r.kRight += hit(kf, row ? row[c.x] : 0, row ? row[c.y] : 0, L) ? 1 : 0; r.nRight += hit(res.found, res.x, res.y, L) ? 1 : 0; }
  }
  Object.keys(tot).forEach(function (key) { tot[key] += r[key]; });
  console.log(pad(path.basename(dir).slice(0, 24), 26) + pad(n, 8) + pad(pct(r.kiosk, n), 13) + pad(pct(r.now, n), 13) + pad(r.lab, 8) + pad(pct(r.kRight, r.lab), 13) + pad(pct(r.nRight, r.lab), 11));
  if (minRight !== null && r.lab && r.nRight / r.lab < minRight) failed = true;
});
console.log(pad('ALL', 26) + pad(tot.n, 8) + pad(pct(tot.kiosk, tot.n), 13) + pad(pct(tot.now, tot.n), 13) + pad(tot.lab, 8) + pad(pct(tot.kRight, tot.lab), 13) + pad(pct(tot.nRight, tot.lab), 11));
if (!tot.lab) console.log('No labelled frames: label some in the review page to measure accuracy, not only detection.');
process.exit(failed ? 1 : 0);
