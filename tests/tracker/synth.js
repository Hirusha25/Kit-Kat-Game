/*
 * Synthetic RGBA frames for the MugTracker tests (Node, no dependencies).
 *
 *   renderMugFrame(opts)      -> frame with a white mug + red oval logo at a known position
 *   renderNegativeFrame(opts) -> frame with red "clothing" blobs, skin and no white mug
 *
 * A frame is {data: Uint8ClampedArray, width, height, truth} — the same shape as ImageData.
 * All randomness goes through a seeded PRNG so runs are reproducible.
 */
'use strict';

function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function Frame(width, height) {
  this.width = width; this.height = height;
  this.data = new Uint8ClampedArray(width * height * 4);
  this.truth = null;
}
Frame.prototype.fill = function (c) {
  var d = this.data;
  for (var i = 0; i < d.length; i += 4) { d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; }
};
Frame.prototype.set = function (x, y, c) {
  if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
  var i = (y * this.width + x) * 4, d = this.data;
  d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
};
// Fill every pixel centre inside the ellipse (cx,cy,rx,ry) with colour c.
Frame.prototype.ellipse = function (cx, cy, rx, ry, c) {
  var x0 = Math.max(0, Math.floor(cx - rx - 1)), x1 = Math.min(this.width - 1, Math.ceil(cx + rx + 1));
  var y0 = Math.max(0, Math.floor(cy - ry - 1)), y1 = Math.min(this.height - 1, Math.ceil(cy + ry + 1));
  for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
    var u = (x + 0.5 - cx) / rx, v = (y + 0.5 - cy) / ry;
    if (u * u + v * v <= 1) this.set(x, y, c);
  }
};
// Rounded rectangle (x,y,w,h with corner radius r).
Frame.prototype.roundRect = function (x, y, w, h, r, c) {
  var x0 = Math.max(0, Math.floor(x)), x1 = Math.min(this.width - 1, Math.ceil(x + w));
  var y0 = Math.max(0, Math.floor(y)), y1 = Math.min(this.height - 1, Math.ceil(y + h));
  for (var yy = y0; yy <= y1; yy++) for (var xx = x0; xx <= x1; xx++) {
    var px = xx + 0.5, py = yy + 0.5;
    if (px < x || px > x + w || py < y || py > y + h) continue;
    var dx = px < x + r ? x + r - px : (px > x + w - r ? px - (x + w - r) : 0);
    var dy = py < y + r ? y + r - py : (py > y + h - r ? py - (y + h - r) : 0);
    if (dx * dx + dy * dy <= r * r) this.set(xx, yy, c);
  }
};
Frame.prototype.rect = function (x, y, w, h, c) { this.roundRect(x, y, w, h, 0, c); };
// Thick line segment.
Frame.prototype.line = function (x0, y0, x1, y1, t, c) {
  var steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
  for (var s = 0; s <= steps; s++) {
    var f = s / steps;
    this.ellipse(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, t / 2, t / 2, c);
  }
};
Frame.prototype.noise = function (rand, amp) {
  var d = this.data;
  for (var i = 0; i < d.length; i += 4) {
    var n = (rand() * 2 - 1) * amp;
    d[i] += n; d[i + 1] += n * (0.6 + rand() * 0.8); d[i + 2] += n * (0.6 + rand() * 0.8);
  }
};

function pick(rand, arr) { return arr[Math.floor(rand() * arr.length)]; }
function jitter(rand, c, amt) { return [c[0] + (rand() - 0.5) * amt, c[1] + (rand() - 0.5) * amt, c[2] + (rand() - 0.5) * amt]; }

// Backgrounds: dark venue, mid grey wall, warm wood, REDDISH backdrop, WHITISH wall, bluish.
function randomBackground(rand) {
  var kind = rand();
  if (kind < 0.25) return jitter(rand, [45, 35, 35], 40);        // dark venue
  if (kind < 0.40) return jitter(rand, [120, 115, 110], 40);     // grey wall
  if (kind < 0.55) return jitter(rand, [150, 95, 55], 40);       // wood / warm
  if (kind < 0.75) return jitter(rand, [165, 35, 40], 50);       // reddish backdrop (KitKat venue)
  if (kind < 0.90) return jitter(rand, [225, 222, 215], 30);     // whitish wall
  return jitter(rand, [60, 80, 130], 50);                        // bluish
}
var SKIN = [[224, 172, 140], [198, 134, 100], [141, 85, 60], [240, 200, 175]];
var SHIRTS = [[40, 50, 90], [30, 30, 30], [90, 140, 90], [230, 230, 230], [190, 30, 35], [120, 60, 140]];
var DARK_SHIRTS = [[40, 50, 90], [30, 30, 30], [90, 140, 90], [120, 60, 140], [60, 40, 30]];   // negatives: red prints on a white shirt would be a mug by definition
var RED = [186, 0, 24];

/**
 * Mug frame. opts: {width, height, seed, mugX (0..1 centre of the LOGO), mugY, mugW (fraction of
 * width, default random 0.06..0.16), occlude (bool|undefined random), noise (amp, default 8),
 * light (0.6..1.2 brightness multiplier, default random)}.
 * truth = {x, y, w, h} normalised box of the red logo.
 */
function renderMugFrame(opts) {
  opts = opts || {};
  var W = opts.width || 160, H = opts.height || 90;
  var rand = mulberry32(opts.seed === undefined ? 1 : opts.seed);
  var f = new Frame(W, H);
  var light = opts.light !== undefined ? opts.light : 0.65 + rand() * 0.55;
  var bg = randomBackground(rand);
  f.fill(bg);

  // a torso + head behind the mug, sometimes in red or white clothing
  var shirt = pick(rand, SHIRTS), skin = pick(rand, SKIN);
  var mugXf = opts.mugX !== undefined ? opts.mugX : 0.15 + rand() * 0.7;
  var mugYf = opts.mugY !== undefined ? opts.mugY : 0.35 + rand() * 0.35;
  var torsoX = mugXf * W + (rand() - 0.5) * 0.2 * W;
  f.ellipse(torsoX, H * 1.05, W * 0.22, H * 0.55, shirt);
  f.ellipse(torsoX, H * 0.22, W * 0.07, H * 0.17, skin);

  // mug body: white rounded rectangle, logo centred horizontally, slightly above the middle
  var mugW = (opts.mugW || (0.06 + rand() * 0.10)) * W;
  var mugH = mugW * 1.15;
  var logoW = mugW * 0.55, logoH = logoW * 0.62;
  var lx = mugXf * W, ly = mugYf * H;                 // logo centre
  var mx = lx - mugW / 2, my = ly - mugH * 0.45;      // mug top-left
  var white = [250 * light, 248 * light, 244 * light].map(function (v) { return Math.min(255, v); });
  var shade = white.map(function (v) { return v * 0.82; });
  f.roundRect(mx, my, mugW, mugH, mugW * 0.12, white);
  f.rect(mx + mugW * 0.85, my, mugW * 0.15, mugH, shade);     // shaded side
  // handle
  f.ellipse(mx + mugW + mugW * 0.08, my + mugH * 0.5, mugW * 0.22, mugH * 0.3, white);
  f.ellipse(mx + mugW + mugW * 0.08, my + mugH * 0.5, mugW * 0.10, mugH * 0.17, bg);

  // logo: red oval ring + letter-like strokes + tiny "chocolate drink" line below
  var red = jitter(rand, [RED[0] * light, RED[1] + 10, RED[2] * light], 20);
  var ringT = Math.max(1, logoW * 0.12);
  f.ellipse(lx, ly, logoW / 2, logoH / 2, red);
  f.ellipse(lx, ly, logoW / 2 - ringT, logoH / 2 - ringT, white);
  var st = Math.max(1, logoW * 0.09);
  if (logoW >= 6) {
    f.line(lx - logoW * 0.25, ly - logoH * 0.25, lx - logoW * 0.25, ly + logoH * 0.25, st, red);   // K
    f.line(lx - logoW * 0.25, ly, lx - logoW * 0.12, ly - logoH * 0.25, st, red);
    f.line(lx - logoW * 0.25, ly, lx - logoW * 0.12, ly + logoH * 0.25, st, red);
    f.line(lx, ly - logoH * 0.25, lx, ly + logoH * 0.25, st, red);                                 // t
    f.line(lx + logoW * 0.15, ly - logoH * 0.25, lx + logoW * 0.15, ly + logoH * 0.25, st, red);   // K
    f.line(lx + logoW * 0.15, ly, lx + logoW * 0.28, ly + logoH * 0.25, st, red);
  }
  if (logoW >= 10) f.rect(lx - logoW * 0.3, ly + logoH * 0.5 + logoH * 0.18, logoW * 0.6, Math.max(1, logoH * 0.1), [230 * light, 150 * light, 150 * light]);

  // hand holding the mug (skin), sometimes with fingers over part of the logo
  var side = rand() < 0.5 ? -1 : 1;
  f.ellipse(mx + (side < 0 ? 0 : mugW), my + mugH * 0.75, mugW * 0.3, mugH * 0.28, skin);
  var occlude = opts.occlude !== undefined ? opts.occlude : rand() < 0.4;
  if (occlude) {
    var cover = 0.15 + rand() * 0.2;    // fraction of the logo width covered
    var fx = side < 0 ? lx - logoW / 2 : lx + logoW / 2;
    f.ellipse(fx, ly + logoH * 0.1, logoW * cover, logoH * 0.75, skin);
  }

  f.noise(rand, opts.noise !== undefined ? opts.noise : 8);
  f.truth = { x: lx / W, y: ly / H, w: logoW / W, h: logoH / H, mugW: mugW / W, occluded: !!occlude, bg: bg };
  return f;
}

/**
 * Negative frame: no white mug. Red/white clothing, skin, red accents on the clothing,
 * sometimes a reddish or whitish background.
 */
function renderNegativeFrame(opts) {
  opts = opts || {};
  var W = opts.width || 160, H = opts.height || 90;
  var rand = mulberry32(opts.seed === undefined ? 1 : opts.seed);
  var f = new Frame(W, H);
  var light = 0.65 + rand() * 0.55;
  var bg = randomBackground(rand);
  f.fill(bg);
  var skin = pick(rand, SKIN);
  var n = 1 + Math.floor(rand() * 3);
  for (var k = 0; k < n; k++) {
    var cx = rand() * W, cy = H * (0.6 + rand() * 0.6);
    var redShirt = rand() < 0.75;
    var col = redShirt ? jitter(rand, [RED[0] * light, 15, 25], 40) : pick(rand, DARK_SHIRTS);
    f.ellipse(cx, cy, W * (0.12 + rand() * 0.2), H * (0.3 + rand() * 0.4), col);      // torso
    f.ellipse(cx + (rand() - 0.5) * W * 0.1, cy - H * 0.55, W * 0.06, H * 0.15, skin); // head
    f.ellipse(cx + W * 0.2, cy, W * 0.05, H * 0.25, skin);                               // arm
    // small accents on the clothing: a badge, a stripe, a logo print
    if (rand() < 0.7) f.ellipse(cx + (rand() - 0.5) * W * 0.1, cy - H * 0.1, W * 0.02 + rand() * W * 0.03, H * 0.03 + rand() * H * 0.03, redShirt ? [240, 240, 240] : jitter(rand, RED, 30));
    if (rand() < 0.5) f.rect(cx - W * 0.1, cy + H * 0.05, W * 0.2, Math.max(1, H * 0.02), redShirt ? [250, 250, 250] : jitter(rand, RED, 30));
    if (rand() < 0.5) f.ellipse(cx + W * 0.05, cy - H * 0.2, Math.max(1, W * 0.015), Math.max(1, H * 0.02), jitter(rand, [200, 40, 30], 30));
  }
  // loose red items on the background (a cap, a cup of coke, a red bag). Not on a whitish wall:
  // a logo-sized solid red object on white IS "a red blob surrounded by white" and is excluded
  // from the negatives by definition (see README, limitations).
  if (rand() < 0.5 && !(bg[0] > 200 && bg[1] > 200 && bg[2] > 200)) f.ellipse(rand() * W, rand() * H * 0.4, W * 0.04, H * 0.06, jitter(rand, RED, 40));
  f.noise(rand, 8);
  f.truth = null;
  return f;
}

module.exports = { renderMugFrame: renderMugFrame, renderNegativeFrame: renderNegativeFrame, mulberry32: mulberry32, Frame: Frame };
