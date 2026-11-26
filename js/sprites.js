/* DunkSprites — sprite loader / pre-renderer for "KitKat Dunk the Break".
 *
 * Everything the game blits is pre-rendered ONCE into an offscreen canvas at its
 * final on-stage pixel size, so per-frame work is plain 1:1 drawImage calls
 * (no scaling of 2x PNGs, no filters, no shadowBlur). Rotated variants are
 * rasterised on demand, quantised to 15 degree steps and cached, so a tumbling
 * item costs the same as a static one.
 *
 * Usage
 *   const sprites = await DunkSprites.load(manifest, { scale: 1, basePath: '' });
 *   sprites.wafer.canvas          // HTMLCanvasElement, w x h logical px (times scale)
 *   sprites.wafer.rotated(0.4)    // { canvas, ox, oy, w, h } rotated about the anchor
 *   sprites.wafer.draw(ctx, x, y, angle)
 *
 * `manifest` is either the parsed assets/img/game/manifest.json ({ sprites: {...} })
 * or a flat map  name -> url  /  name -> { src, w, h, anchor:{x,y} }.
 * When a size is not given the image's natural size / 2 is used (2x asset rule).
 * If an image fails to load (or times out) the sprite is drawn by a vector
 * fallback so the game always runs; `sprite.fromImage` tells which happened.
 *
 * Only `window.DunkSprites` is exported.
 */
(function (root) {
  'use strict';

  var ROT_STEPS = 24;                       // 360 / 15 degrees
  var ROT_STEP = (Math.PI * 2) / ROT_STEPS;
  var TWO_PI = Math.PI * 2;

  function createCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function quantizeAngle(angle) {
    var q = Math.round(angle / ROT_STEP) % ROT_STEPS;
    if (q < 0) q += ROT_STEPS;
    return q;
  }

  /* ------------------------------------------------------------------ */
  /* Vector fallbacks. Each draws into a (0,0)-(w,h) box in logical px.  */
  /* They are deliberately simple: they only exist so the game is        */
  /* playable when a PNG is missing, and as a visual hint of what to     */
  /* replace them with.                                                   */
  /* ------------------------------------------------------------------ */

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  var FALLBACKS = {
    wafer: function (ctx, w, h) {
      var side = w * 0.12, end = h * 0.07;
      // side + end faces
      ctx.fillStyle = '#52260c';
      roundRect(ctx, side, end * 0.5, w - side, h - end * 0.5, w * 0.1); ctx.fill();
      ctx.fillStyle = '#3c1a08';
      roundRect(ctx, 0, h - end * 1.4, w, end * 1.4, w * 0.06); ctx.fill();
      for (var i = 0; i < 4; i++) {
        ctx.fillStyle = i % 2 ? '#966a24' : '#deb06e';
        ctx.fillRect(w * 0.08, h - end * 1.3 + i * end * 0.3, w * 0.8, end * 0.18);
      }
      // front face
      var g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#b0622a'); g.addColorStop(1, '#804018');
      ctx.fillStyle = g;
      roundRect(ctx, 0, 0, w - side, h - end, w * 0.1); ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(205,128,62,.9)'; ctx.stroke();
      // embossed oval
      ctx.save();
      ctx.translate((w - side) / 2, (h - end) / 2);
      ctx.scale(1, 2.2);
      ctx.beginPath(); ctx.arc(0, 0, (w - side) * 0.3, 0, TWO_PI);
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(60,26,8,.8)'; ctx.stroke();
      ctx.restore();
    },
    'wafer-piece': function (ctx, w, h) {
      ctx.fillStyle = '#804018';
      ctx.beginPath();
      ctx.moveTo(w * 0.17, h * 0.12); ctx.lineTo(w * 0.78, h * 0.08); ctx.lineTo(w * 0.9, h * 0.5);
      ctx.lineTo(w * 0.72, h * 0.9); ctx.lineTo(w * 0.25, h * 0.82); ctx.lineTo(w * 0.1, h * 0.45);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#deb06e'; ctx.fillRect(w * 0.5, h * 0.45, w * 0.3, h * 0.08);
      ctx.fillStyle = '#966a24'; ctx.fillRect(w * 0.5, h * 0.58, w * 0.3, h * 0.08);
    },
    alarm: function (ctx, w, h) {
      var cx = w / 2, cy = h * 0.56, r = w * 0.35;
      ctx.fillStyle = '#ba0018';
      // bells
      ctx.beginPath(); ctx.arc(cx - r * 0.7, cy - r * 0.92, r * 0.42, Math.PI, 0); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + r * 0.7, cy - r * 0.92, r * 0.42, Math.PI, 0); ctx.fill();
      // legs
      ctx.strokeStyle = '#780010'; ctx.lineWidth = w * 0.045;
      ctx.beginPath(); ctx.moveTo(cx - r * 0.55, cy + r * 0.8); ctx.lineTo(cx - r * 0.85, cy + r * 1.2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + r * 0.55, cy + r * 0.8); ctx.lineTo(cx + r * 0.85, cy + r * 1.2); ctx.stroke();
      // body
      var g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.2, cx, cy, r);
      g.addColorStop(0, '#e6203a'); g.addColorStop(1, '#8a0012');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, TWO_PI); ctx.fill();
      ctx.fillStyle = '#faf4e8'; ctx.beginPath(); ctx.arc(cx, cy, r * 0.78, 0, TWO_PI); ctx.fill();
      ctx.strokeStyle = '#2a1414'; ctx.lineWidth = w * 0.025; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - r * 0.55); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + r * 0.45, cy + r * 0.2); ctx.stroke();
    },
    deadline: function (ctx, w, h) {
      var x = w * 0.1, y = h * 0.17, pw = w * 0.8, ph = h * 0.73;
      ctx.fillStyle = '#fcf8f2'; roundRect(ctx, x, y, pw, ph, w * 0.07); ctx.fill();
      ctx.fillStyle = '#ba0018'; roundRect(ctx, x, y, pw, ph * 0.4, w * 0.07); ctx.fill();
      ctx.fillRect(x, y + ph * 0.25, pw, ph * 0.15);
      ctx.fillStyle = '#eee'; ctx.fillRect(x + pw * 0.22, y - h * 0.08, w * 0.06, h * 0.18);
      ctx.fillRect(x + pw * 0.72, y - h * 0.08, w * 0.06, h * 0.18);
      ctx.fillStyle = '#fff';
      ctx.font = 'italic 900 ' + Math.round(w * 0.15) + 'px "Arial Black", Arial, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('DEADLINE', w / 2, y + ph * 0.22);
      ctx.fillStyle = '#e6ded6';
      var cell = pw * 0.14, gap = pw * 0.035, gx = x + (pw - (5 * cell + 4 * gap)) / 2;
      for (var r = 0; r < 3; r++) for (var c = 0; c < 5; c++) {
        ctx.fillStyle = (r === 2 && c === 4) ? '#ba0018' : '#e6ded6';
        ctx.fillRect(gx + c * (cell + gap), y + ph * 0.48 + r * (cell + gap), cell, cell);
      }
    },
    mug: function (ctx, w, h, def) {
      var ax = def.anchorX * w, ay = def.anchorY * h;   // rim centre
      var rx = w * 0.315, ry = h * 0.078, bottom = h * 0.955, brx = w * 0.24;
      // handle
      ctx.strokeStyle = '#e8e4de'; ctx.lineWidth = w * 0.075;
      ctx.beginPath(); ctx.ellipse(ax - rx - w * 0.02, ay + h * 0.31, w * 0.11, h * 0.17, 0, 0, TWO_PI); ctx.stroke();
      // body
      var g = ctx.createLinearGradient(ax - rx, 0, ax + rx, 0);
      g.addColorStop(0, '#cdc6bc'); g.addColorStop(0.5, '#ffffff'); g.addColorStop(1, '#d8d2c8');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(ax - rx, ay); ctx.lineTo(ax + rx, ay); ctx.lineTo(ax + brx, bottom - h * 0.04);
      ctx.quadraticCurveTo(ax, bottom + h * 0.03, ax - brx, bottom - h * 0.04);
      ctx.closePath(); ctx.fill();
      // rim + cocoa
      ctx.fillStyle = '#f2eee8'; ctx.beginPath(); ctx.ellipse(ax, ay, rx, ry, 0, 0, TWO_PI); ctx.fill();
      ctx.fillStyle = '#5a2a10'; ctx.beginPath(); ctx.ellipse(ax, ay, rx * 0.92, ry * 0.82, 0, 0, TWO_PI); ctx.fill();
      // red oval
      ctx.fillStyle = '#ba0018'; ctx.beginPath(); ctx.ellipse(ax, ay + h * 0.33, w * 0.18, h * 0.1, 0, 0, TWO_PI); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.stroke();
    },
    'splash-drop': function (ctx, w, h) {
      ctx.fillStyle = '#804018';
      ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w * 0.86, h * 0.56); ctx.lineTo(w * 0.14, h * 0.56); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.arc(w / 2, h * 0.65, w * 0.4, 0, TWO_PI); ctx.fill();
      ctx.fillStyle = 'rgba(255,225,200,.6)'; ctx.beginPath(); ctx.arc(w * 0.38, h * 0.6, w * 0.1, 0, TWO_PI); ctx.fill();
    },
    'default': function (ctx, w, h) {
      ctx.fillStyle = 'rgba(255,0,255,.6)'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, w - 2, h - 2);
    }
  };

  /* ------------------------------------------------------------------ */

  function normalizeDef(name, raw, basePath) {
    var def = (typeof raw === 'string') ? { src: raw } : Object.assign({}, raw);
    if (def.src && basePath && !/^(https?:|data:|blob:|\/)/.test(def.src)) def.src = basePath + def.src;
    def.name = name;
    def.anchorX = def.anchor && typeof def.anchor.x === 'number' ? def.anchor.x : 0.5;
    def.anchorY = def.anchor && typeof def.anchor.y === 'number' ? def.anchor.y : 0.5;
    return def;
  }

  function loadImage(src, timeoutMs) {
    return new Promise(function (resolve) {
      if (!src) return resolve(null);
      var img = new Image();
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve(null); } }, timeoutMs);
      img.onload = function () {
        if (done) return;
        done = true; clearTimeout(timer);
        // decode() avoids a synchronous decode hitch on the first drawImage.
        if (img.decode) img.decode().then(function () { resolve(img); }, function () { resolve(img); });
        else resolve(img);
      };
      img.onerror = function () { if (!done) { done = true; clearTimeout(timer); resolve(null); } };
      img.src = src;
    });
  }

  /**
   * Build a sprite object from a definition and an (optional) loaded image.
   * Logical size (w,h) is in stage px; pixel size is logical * scale.
   */
  function createSprite(def, img, scale) {
    var w = def.w, h = def.h;
    if (!(w > 0) || !(h > 0)) {
      // 2x asset convention when the manifest gives no size.
      w = img ? img.naturalWidth / 2 : 64;
      h = img ? img.naturalHeight / 2 : 64;
    }
    var pw = Math.round(w * scale), ph = Math.round(h * scale);
    var canvas = createCanvas(pw, ph);
    var ctx = canvas.getContext('2d');
    var fromImage = false;
    if (img) {
      ctx.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, pw, ph);
      fromImage = true;
    } else {
      ctx.save();
      ctx.scale(scale, scale);
      (FALLBACKS[def.name] || FALLBACKS['default'])(ctx, w, h, def);
      ctx.restore();
    }

    var ax = def.anchorX * w, ay = def.anchorY * h;     // anchor in logical px from top-left
    var base = { canvas: canvas, ox: ax, oy: ay, w: w, h: h, angle: 0 };
    var rotCache = new Array(ROT_STEPS);
    rotCache[0] = base;
    var scaleCache = {};

    var sprite = {
      name: def.name,
      w: w, h: h,            // logical draw size
      pw: pw, ph: ph,        // backing-store pixel size
      scale: scale,
      ax: ax, ay: ay,        // anchor offset, logical px
      canvas: canvas,
      fromImage: fromImage,
      src: def.src || null,

      /**
       * Rotated variant about the anchor, quantised to 15 degrees and cached.
       * Returns { canvas, ox, oy, w, h, angle } — draw with
       *   ctx.drawImage(v.canvas, x - v.ox, y - v.oy, v.w, v.h)
       */
      rotated: function (angle) {
        var q = quantizeAngle(angle);
        var v = rotCache[q];
        if (v) return v;
        var a = q * ROT_STEP, cos = Math.cos(a), sin = Math.sin(a);
        // Bounding box of the four corners, relative to the anchor.
        var xs = [-ax, w - ax, w - ax, -ax], ys = [-ay, -ay, h - ay, h - ay];
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (var i = 0; i < 4; i++) {
          var rx = xs[i] * cos - ys[i] * sin, ry = xs[i] * sin + ys[i] * cos;
          if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
          if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
        }
        var bw = Math.ceil(maxX - minX) + 2, bh = Math.ceil(maxY - minY) + 2;
        var ox = -minX + 1, oy = -minY + 1;
        var rc = createCanvas(bw * scale, bh * scale);
        var rctx = rc.getContext('2d');
        rctx.scale(scale, scale);
        rctx.translate(ox, oy);
        rctx.rotate(a);
        rctx.drawImage(canvas, -ax, -ay, w, h);
        v = { canvas: rc, ox: ox, oy: oy, w: bw, h: bh, angle: a };
        rotCache[q] = v;
        return v;
      },

      /** Uniformly scaled variant (cached per 2-decimal factor); anchor preserved. */
      scaled: function (factor) {
        var key = Math.round(factor * 100);
        var v = scaleCache[key];
        if (v) return v;
        var f = key / 100, sw = w * f, sh = h * f;
        var sc = createCanvas(Math.max(1, sw * scale), Math.max(1, sh * scale));
        var sctx = sc.getContext('2d');
        sctx.imageSmoothingEnabled = true;
        sctx.drawImage(canvas, 0, 0, sc.width, sc.height);
        v = { canvas: sc, ox: ax * f, oy: ay * f, w: sw, h: sh, angle: 0 };
        scaleCache[key] = v;
        return v;
      },

      /** Rasterise all 24 rotations now (call during load, never mid-game). */
      prewarm: function () {
        for (var q = 0; q < ROT_STEPS; q++) sprite.rotated(q * ROT_STEP);
        return sprite;
      },

      /** Convenience blit at logical (x,y) = anchor position. */
      draw: function (ctx, x, y, angle) {
        var v = angle ? sprite.rotated(angle) : base;
        ctx.drawImage(v.canvas, x - v.ox, y - v.oy, v.w, v.h);
      }
    };
    return sprite;
  }

  /**
   * load(manifest, options) -> Promise<sprites>
   *   options.scale    backing-store pixels per logical px (default 1; use
   *                    canvas.width / 1080 if the page sizes the canvas to DPR)
   *   options.basePath prefix for relative src paths (default '')
   *   options.timeout  per-image timeout in ms before falling back (default 8000)
   *   options.prewarm  names (or true for all) to rasterise rotations for now
   */
  function load(manifest, options) {
    options = options || {};
    var scale = options.scale > 0 ? options.scale : 1;
    var timeout = options.timeout > 0 ? options.timeout : 8000;
    var basePath = options.basePath || '';
    var table = (manifest && manifest.sprites) ? manifest.sprites : (manifest || {});
    var names = Object.keys(table).filter(function (k) { return k.charAt(0) !== '_'; });

    var fontsReady = (typeof document !== 'undefined' && document.fonts && document.fonts.ready)
      ? Promise.race([document.fonts.ready, new Promise(function (r) { setTimeout(r, 1500); })])
      : Promise.resolve();

    return fontsReady.then(function () {
      return Promise.all(names.map(function (name) {
        var def = normalizeDef(name, table[name], basePath);
        return loadImage(def.src, timeout).then(function (img) {
          return createSprite(def, img, scale);
        });
      }));
    }).then(function (list) {
      var sprites = {};
      var missing = [];
      list.forEach(function (s) { sprites[s.name] = s; if (!s.fromImage) missing.push(s.name); });
      Object.defineProperty(sprites, '$scale', { value: scale, enumerable: false });
      Object.defineProperty(sprites, '$missing', { value: missing, enumerable: false });
      var pre = options.prewarm;
      if (pre === true) pre = names;
      if (Array.isArray(pre)) pre.forEach(function (n) { if (sprites[n]) sprites[n].prewarm(); });
      if (missing.length && typeof console !== 'undefined') {
        console.warn('[DunkSprites] using vector fallback for: ' + missing.join(', '));
      }
      return sprites;
    });
  }

  root.DunkSprites = {
    load: load,
    createSprite: function (name, def, img, scale) { return createSprite(normalizeDef(name, Object.assign({}, def)), img || null, scale || 1); },
    fallbacks: FALLBACKS,
    quantizeAngle: quantizeAngle,
    ROT_STEPS: ROT_STEPS,
    ROT_STEP: ROT_STEP
  };
})(typeof window !== 'undefined' ? window : this);
