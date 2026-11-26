#!/usr/bin/env node
/*
 * Detector test on photos of the REAL mug (tests/tracker/real-mug). Plain Node, no dependencies.
 *
 * Frames are made by real-mug/make-frames.py: each photo at several distances and both detector sizes.
 * Checked with the lock-on parameters the "show your mug" screen uses (MugTracker.acquireParams):
 *   - every frame that shows the logo must be found, and found ON the logo;
 *   - frames of the blank side and the top view must find nothing.
 * It also prints how the plain default parameters do, as a reminder of why lock-on mode exists.
 * Exit code 1 on failure.
 */
'use strict';
var fs = require('fs'), path = require('path'), zlib = require('zlib');
var T = require('../../js/tracker.js');
var DIR = path.join(__dirname, 'real-mug');

function png(file) {   // 8-bit RGBA, not interlaced (what make-frames.py writes)
  var b = fs.readFileSync(file), p = 8, w = 0, h = 0, idat = [];
  while (p < b.length) {
    var len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8);
    if (type === 'IHDR') { w = b.readUInt32BE(p + 8); h = b.readUInt32BE(p + 12); if (b[p + 16] !== 8 || b[p + 17] !== 6) throw new Error(file + ': expected 8-bit RGBA'); }
    if (type === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  var raw = zlib.inflateSync(Buffer.concat(idat)), st = w * 4, out = new Uint8ClampedArray(w * h * 4), prev = new Uint8Array(st);
  for (var y = 0; y < h; y++) {
    var f = raw[y * (st + 1)], line = raw.subarray(y * (st + 1) + 1, (y + 1) * (st + 1)), cur = new Uint8Array(st);
    for (var x = 0; x < st; x++) {
      var a = x >= 4 ? cur[x - 4] : 0, u = prev[x], c = x >= 4 ? prev[x - 4] : 0, v = line[x];
      if (f === 1) v += a; else if (f === 2) v += u; else if (f === 3) v += (a + u) >> 1;
      else if (f === 4) { var pp = a + u - c, pa = Math.abs(pp - a), pb = Math.abs(pp - u), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : (pb <= pc ? u : c); }
      cur[x] = v & 255;
    }
    out.set(cur, y * st); prev = cur;
  }
  return { data: out, width: w, height: h };
}

var frames = JSON.parse(fs.readFileSync(path.join(DIR, 'frames.json'), 'utf8')), names = Object.keys(frames).sort();
var THRESHOLD = 0.56;   // the game's default sensitivity (0.42)
var acquire = T.acquireParams(T.defaultParams); acquire.threshold = THRESHOLD;
var plain = Object.assign({}, T.defaultParams, { threshold: THRESHOLD });
var fails = [], stat = { pos: 0, neg: 0, plainFound: 0 };

function onLogo(r, box) { return r.found && r.x > box[0] - 0.02 && r.x < box[2] + 0.02 && r.y > box[1] - 0.03 && r.y < box[3] + 0.03; }
names.forEach(function (name) {
  var f = frames[name], img = png(path.join(DIR, 'frames', name));
  var r = T.detect(img, acquire), found = r.found, x = r.x, y = r.y, score = r.score;
  var hit = f.logo ? onLogo({ found: found, x: x, y: y }, f.logo) : false;
  var rp = T.detect(img, plain); if (f.logo && onLogo(rp, f.logo)) stat.plainFound++;
  if (f.logo) { stat.pos++; if (!hit) fails.push(name + ': logo ' + (found ? 'found in the WRONG place (' + x.toFixed(2) + ', ' + y.toFixed(2) + ')' : 'not found (best score ' + score.toFixed(2) + ')')); }
  else { stat.neg++; if (found) fails.push(name + ': no logo in this photo, but something was found at (' + x.toFixed(2) + ', ' + y.toFixed(2) + ') score ' + score.toFixed(2)); }
});

console.log('real mug: ' + stat.pos + ' frames with the logo, ' + stat.neg + ' without');
console.log('  lock-on parameters: ' + (stat.pos + stat.neg - fails.length) + ' of ' + (stat.pos + stat.neg) + ' correct');
console.log('  plain defaults (for comparison, not a pass/fail): logo found in ' + stat.plainFound + ' of ' + stat.pos);
if (fails.length) { fails.forEach(function (m) { console.log('  FAIL ' + m); }); process.exit(1); }
console.log('ALL PASSED');
