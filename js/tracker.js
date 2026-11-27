/*
 * MugTracker — webcam tracking of the white KitKat mug (red oval logo on a white body).
 *
 * Runs in three places with the same file:
 *   - the page (window.MugTracker): camera capture, downscale, smoothing, calibration, debug drawing
 *   - a Web Worker (self.MugTracker via importScripts in tracker-worker.js): the pure detector
 *   - Node (tests, via vm or require): the pure detector
 *
 * The detector is deliberately tiny and allocation-free after warm-up so that it fits the
 * kiosk (RK3566, 4x Cortex-A55). Per frame, on a 160x90 (or up to 320x180) RGBA image:
 *
 *   1. one pass over the pixels builds a RED mask (R > redMin, R - max(G,B) > redDelta,
 *      R > redRatio * max(G,B)) and labels its 8-connected components with union-find, and at the
 *      same time builds an integral image of the WHITE mask (min(R,G,B) > whiteMin and
 *      max-min < whiteSpread) so that any rectangle's white count is O(1) later;
 *   2. a second pass accumulates area + bounding box per component;
 *   3. the largest components become candidates; candidates whose boxes are within a small gap are
 *      merged (the logo splits when fingers cover part of it);
 *   4. each candidate with a plausible area is scored on: the fraction of WHITE pixels in a ring
 *      around its box (the mug body — this is the signal that separates the logo from red
 *      clothing or a red backdrop), its aspect ratio (the oval is wider than tall), its area, its
 *      fill ratio and its proximity to the previous position.
 *
 * Coordinates returned by detect() are normalised 0..1 in the frame's own (unmirrored) space.
 * The tracker mirrors x for the page so that moving right moves right on screen.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------------------------
  // Detector parameters. Areas are fractions of the frame (resolution independent); the detector
  // converts them to pixels for the frame it is given. Calibration overrides the colour thresholds
  // and sets refAreaFrac (the logo size seen during calibration).
  // ---------------------------------------------------------------------------------------------
  var defaultParams = {
    // red mask
    redMin: 90,         // R must exceed this (0..255)
    redDelta: 45,       // R - max(G,B) must exceed this
    redRatio: 2.2,      // R must exceed redRatio * max(G,B) (rejects skin, wood, orange, magenta)
    // white mask
    whiteMin: 140,      // min(R,G,B) must exceed this
    whiteSpread: 70,    // max(R,G,B) - min(R,G,B) must be below this
    whiteWarmMax: 22,   // R - G must be below this: ceramic white is neutral even under warm light, skin is not
                        // (a reddish nose or lips on a bright face otherwise reads as "red on white")
    // component size, as a fraction of frame pixels
    minAreaFrac: 0.0004,   // ~6 px at 160x90, ~23 px at 320x180
    maxAreaFrac: 0.06,     // ~430 px at 160x90: a logo 30x14 px, i.e. the player at arm's length
    maxBoxFrac: 0.4,      // bounding box width/height limit, as a fraction of frame WIDTH
    mergeGapFrac: 0.02,    // merge red components whose boxes are closer than this (x frame width)
    // white ring around the box: box grown by ringExpand (60% = 30% each side), at least ringMin px
    ringExpand: 0.6,
    ringMin: 2,
    whiteLo: 0.2,          // white ratio in the ring that scores 0 ...
    whiteHi: 0.6,          // ... and 1
    redRingPenalty: 3,     // red touching the box (a fragment of red clothing) lowers the white ratio
    // shape
    aspectMin: 1.0,
    aspectMax: 2.2,
    // size reference from calibration (0 = unknown)
    refAreaFrac: 0,
    // temporal proximity: distance (normalised) at which the previous-position bonus reaches 0
    temporalRange: 0.25,
    prevX: -1,             // previous raw position (unmirrored, normalised) or -1 for none
    prevY: -1,
    // decision
    threshold: 0.55
  };

  var MAXC = 48;      // candidates kept per frame (plus up to MAXC merged groups)

  // Reusable buffers (one set per frame size). Nothing is allocated per frame after warm-up.
  var B = null;
  function buffers(W, H) {
    if (B && B.W === W && B.H === H) return B;
    var n = W * H;
    var maxLabels = n + 2;   // never overflows: a noisy frame cannot create more labels than pixels
    B = {
      W: W, H: H, maxLabels: maxLabels,
      labels: new Int32Array(n),
      parent: new Int32Array(maxLabels),
      area: new Int32Array(maxLabels),
      minX: new Int32Array(maxLabels), minY: new Int32Array(maxLabels),
      maxX: new Int32Array(maxLabels), maxY: new Int32Array(maxLabels),
      integ: new Int32Array((W + 1) * (H + 1)),   // white integral image; row 0 / column 0 stay zero
      integR: new Int32Array((W + 1) * (H + 1)),  // red integral image
      cLab: new Int32Array(MAXC),
      cArea: new Int32Array(2 * MAXC),
      cMinX: new Int32Array(2 * MAXC), cMinY: new Int32Array(2 * MAXC),
      cMaxX: new Int32Array(2 * MAXC), cMaxY: new Int32Array(2 * MAXC),
      cAlive: new Uint8Array(2 * MAXC)
    };
    return B;
  }

  function find(parent, a) {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  }
  function union(parent, a, b) {
    a = find(parent, a); b = find(parent, b);
    if (a === b) return;
    if (a < b) parent[b] = a; else parent[a] = b;
  }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  // Count / fraction of set pixels (per the given integral image) in the inclusive rectangle
  // (x0,y0)-(x1,y1); the fraction is 0 when the rectangle is empty.
  function sumRect(integ, IW, x0, y0, x1, y1) {
    return integ[(y1 + 1) * IW + x1 + 1] - integ[y0 * IW + x1 + 1] - integ[(y1 + 1) * IW + x0] + integ[y0 * IW + x0];
  }
  function ratioRect(integ, IW, x0, y0, x1, y1) {
    if (x1 < x0 || y1 < y0) return 0;
    return sumRect(integ, IW, x0, y0, x1, y1) / ((x1 - x0 + 1) * (y1 - y0 + 1));
  }

  // The result object is reused between calls (copy it if you keep it).
  // sub = the winning candidate's part scores [white ring, aspect, area, fill, inner white, temporal] (for the debug recorder).
  var result = { found: false, x: 0, y: 0, w: 0, h: 0, score: 0, redArea: 0, whiteRatio: 0, candidates: 0, sub: [0, 0, 0, 0, 0, 0] };

  /**
   * Pure detector. img = {data: Uint8ClampedArray RGBA, width, height}; params as defaultParams.
   * Returns {found, x, y, w, h, score, redArea, whiteRatio, candidates}; x,y,w,h normalised 0..1
   * in frame coordinates (unmirrored), redArea in pixels of the given frame.
   */
  function detect(img, params) {
    var p = params || defaultParams;
    var W = img.width | 0, H = img.height | 0, data = img.data;
    var b = buffers(W, H);
    var n = W * H, IW = W + 1;
    var labels = b.labels, parent = b.parent;
    var area = b.area, minX = b.minX, minY = b.minY, maxX = b.maxX, maxY = b.maxY, integ = b.integ, integR = b.integR;

    var redMin = p.redMin, redDelta = p.redDelta, redRatio = p.redRatio;
    var whiteMin = p.whiteMin, whiteSpread = p.whiteSpread, whiteWarm = p.whiteWarmMax;

    // ---- pass 1: masks, white integral image, provisional labels -------------------------------
    var next = 1;
    var i = 0, d = 0, x, y, lab, u, r, g, bl, mx, mn, lo, hi, isW, ii, ia;
    for (y = 0; y < H; y++) {
      ii = (y + 1) * IW + 1;   // integral cell of (x, y)
      ia = y * IW + 1;         // cell above
      for (x = 0; x < W; x++, i++, d += 4) {
        r = data[d]; g = data[d + 1]; bl = data[d + 2];
        mx = g > bl ? g : bl; mn = g < bl ? g : bl;
        lo = r < mn ? r : mn; hi = r > mx ? r : mx;
        isW = (lo > whiteMin && (hi - lo) < whiteSpread && (r - g) < whiteWarm) ? 1 : 0;
        integ[ii + x] = isW + integ[ia + x] + integ[ii + x - 1] - integ[ia + x - 1];

        if (!(r > redMin && (r - mx) > redDelta && r > redRatio * mx)) {
          labels[i] = 0;
          integR[ii + x] = integR[ia + x] + integR[ii + x - 1] - integR[ia + x - 1];
          continue;
        }
        integR[ii + x] = 1 + integR[ia + x] + integR[ii + x - 1] - integR[ia + x - 1];

        lab = x > 0 ? labels[i - 1] : 0;
        if (y > 0) {
          u = labels[i - W];
          if (u) { if (lab) { if (u !== lab) union(parent, lab, u); } else lab = u; }
          if (x > 0) { u = labels[i - W - 1]; if (u) { if (lab) { if (u !== lab) union(parent, lab, u); } else lab = u; } }
          if (x < W - 1) { u = labels[i - W + 1]; if (u) { if (lab) { if (u !== lab) union(parent, lab, u); } else lab = u; } }
        }
        if (!lab) {
          lab = next++;
          parent[lab] = lab; area[lab] = 0;
          minX[lab] = x; maxX[lab] = x; minY[lab] = y; maxY[lab] = y;
        }
        labels[i] = lab;
      }
    }

    // ---- pass 2: per-root area and bounding box -----------------------------------------------
    if (next > 1) {
      i = 0;
      for (y = 0; y < H; y++) {
        for (x = 0; x < W; x++, i++) {
          lab = labels[i];
          if (!lab) continue;
          r = find(parent, lab);
          area[r]++;
          if (x < minX[r]) minX[r] = x; else if (x > maxX[r]) maxX[r] = x;
          if (y < minY[r]) minY[r] = y; else if (y > maxY[r]) maxY[r] = y;
        }
      }
    }

    // ---- candidates: the MAXC largest roots (fragments down to minArea/4 are kept for merging) --
    var minArea = Math.max(2, Math.round(p.minAreaFrac * n));
    var maxArea = Math.max(minArea + 1, Math.round(p.maxAreaFrac * n));
    var minKeep = Math.max(1, minArea >> 2);
    var cLab = b.cLab, cArea = b.cArea, cMinX = b.cMinX, cMinY = b.cMinY, cMaxX = b.cMaxX, cMaxY = b.cMaxY, cAlive = b.cAlive;
    var cN = 0, a, k, j;
    for (lab = 1; lab < next; lab++) {
      if (parent[lab] !== lab) continue;
      a = area[lab];
      if (a < minKeep) continue;
      if (cN === MAXC) {
        if (a <= area[cLab[MAXC - 1]]) continue;
        cN--;
      }
      k = cN;
      while (k > 0 && area[cLab[k - 1]] < a) { cLab[k] = cLab[k - 1]; k--; }
      cLab[k] = lab; cN++;
    }
    for (k = 0; k < cN; k++) {
      lab = cLab[k];
      cArea[k] = area[lab]; cMinX[k] = minX[lab]; cMinY[k] = minY[lab]; cMaxX[k] = maxX[lab]; cMaxY[k] = maxY[lab];
      cAlive[k] = 1;
    }

    // ---- merge split logos (boxes within `gap` px, neither huge, merged box still logo-sized) ---
    // Merging happens on a copy (slots cN..2cN-1) so that both the fragments and their union are
    // scored: a logo split by a finger wins as a union, a logo next to a red shirt wins on its own.
    var gap = Math.max(1, Math.round(p.mergeGapFrac * W));
    var maxBox = Math.max(3, Math.round(p.maxBoxFrac * W));
    for (k = 0; k < cN; k++) {
      j = cN + k;
      cArea[j] = cArea[k]; cMinX[j] = cMinX[k]; cMinY[j] = cMinY[k]; cMaxX[j] = cMaxX[k]; cMaxY[j] = cMaxY[k];
      cAlive[j] = 2;   // 2 = copy not merged yet (ignored by the scorer), 1 = merged group
    }
    var cTotal = 2 * cN, changed = true, passes = 0, dx, dy, nx0, ny0, nx1, ny1;
    while (changed && passes < 4) {
      changed = false; passes++;
      for (k = cN; k < cTotal; k++) {
        if (!cAlive[k] || cArea[k] > maxArea) continue;
        for (j = k + 1; j < cTotal; j++) {
          if (!cAlive[j] || cArea[j] > maxArea) continue;
          dx = (cMinX[k] > cMinX[j] ? cMinX[k] : cMinX[j]) - (cMaxX[k] < cMaxX[j] ? cMaxX[k] : cMaxX[j]) - 1;
          dy = (cMinY[k] > cMinY[j] ? cMinY[k] : cMinY[j]) - (cMaxY[k] < cMaxY[j] ? cMaxY[k] : cMaxY[j]) - 1;
          if (dx > gap || dy > gap) continue;
          nx0 = cMinX[k] < cMinX[j] ? cMinX[k] : cMinX[j]; nx1 = cMaxX[k] > cMaxX[j] ? cMaxX[k] : cMaxX[j];
          ny0 = cMinY[k] < cMinY[j] ? cMinY[k] : cMinY[j]; ny1 = cMaxY[k] > cMaxY[j] ? cMaxY[k] : cMaxY[j];
          if (nx1 - nx0 + 1 > maxBox || ny1 - ny0 + 1 > maxBox) continue;
          cMinX[k] = nx0; cMaxX[k] = nx1; cMinY[k] = ny0; cMaxY[k] = ny1;
          cArea[k] += cArea[j]; cAlive[j] = 0; cAlive[k] = 1; changed = true;
        }
      }
    }

    // ---- score ---------------------------------------------------------------------------------
    var ringExpand = p.ringExpand * 0.5, ringMin = p.ringMin;
    var whiteLo = p.whiteLo, whiteHi = p.whiteHi, aMin = p.aspectMin, aMax = p.aspectMax, redPen = p.redRingPenalty;
    var refArea = p.refAreaFrac > 0 ? p.refAreaFrac * n : 0;
    var prevX = p.prevX, prevY = p.prevY, tRange = p.temporalRange;
    var best = -1, bestScore = 0, bestWR = 0, evaluated = 0, sub = result.sub;
    sub[0] = sub[1] = sub[2] = sub[3] = sub[4] = sub[5] = 0;
    var w, h, ex, ey, x0, y0, x1, y1, bx0, by0, bx1, by1, rL, rR, rT, rB, redRing, wr, sWhite, aspect, sAspect, fill, sFill, inner, sInner, sArea, sTemp, cx, cy, dist, score;
    for (k = 0; k < cTotal; k++) {
      if (cAlive[k] !== 1) continue;
      a = cArea[k];
      if (a < minArea || a > maxArea) continue;
      w = cMaxX[k] - cMinX[k] + 1; h = cMaxY[k] - cMinY[k] + 1;
      if (w > maxBox || h > maxBox) continue;
      bx0 = cMinX[k]; by0 = cMinY[k]; bx1 = cMaxX[k]; by1 = cMaxY[k];
      // The box is tight on this component, so red in the 2 px border around it belongs to
      // something else: a bigger red thing this is a piece of (clothing, backdrop) or the other
      // half of a split logo (whose union is scored separately and wins). The mug body always
      // separates the logo from other red, so a red border rejects outright beyond 25%.
      x0 = bx0 - 2; if (x0 < 0) x0 = 0;
      y0 = by0 - 2; if (y0 < 0) y0 = 0;
      x1 = bx1 + 2; if (x1 >= W) x1 = W - 1;
      y1 = by1 + 2; if (y1 >= H) y1 = H - 1;
      redRing = ((x1 - x0 + 1) * (y1 - y0 + 1) - w * h);
      redRing = redRing > 0 ? (sumRect(integR, IW, x0, y0, x1, y1) - sumRect(integR, IW, bx0, by0, bx1, by1)) / redRing : 0;
      if (redRing > 0.25) continue;
      evaluated++;

      // white ring, measured per side (left/right columns span the full outer height, top/bottom
      // rows span the box width); the worst side is dropped so a hand or the "CHOCOLATE DRINK"
      // line on one side does not hide the mug body on the other three.
      ex = Math.max(ringMin, Math.round(ringExpand * w)); ey = Math.max(ringMin, Math.round(ringExpand * h));
      x0 = bx0 - ex; if (x0 < 0) x0 = 0;
      y0 = by0 - ey; if (y0 < 0) y0 = 0;
      x1 = bx1 + ex; if (x1 >= W) x1 = W - 1;
      y1 = by1 + ey; if (y1 >= H) y1 = H - 1;
      rL = ratioRect(integ, IW, x0, y0, bx0 - 1, y1);
      rR = ratioRect(integ, IW, bx1 + 1, y0, x1, y1);
      rT = ratioRect(integ, IW, bx0, y0, bx1, by0 - 1);
      rB = ratioRect(integ, IW, bx0, by1 + 1, bx1, y1);
      // a side cut off by the frame edge is unknown, counts as 0 and cannot be the dropped side
      // (otherwise a red torso entering from the bottom edge next to a white wall gets a free pass)
      wr = 2;
      if (bx0 > 0 && rL < wr) wr = rL;
      if (bx1 < W - 1 && rR < wr) wr = rR;
      if (by0 > 0 && rT < wr) wr = rT;
      if (by1 < H - 1 && rB < wr) wr = rB;
      wr = wr === 2 ? (rL + rR + rT + rB) * 0.25 : (rL + rR + rT + rB - wr) / 3;
      wr -= redPen * redRing; if (wr < 0) wr = 0;   // red touching the box: see above
      sWhite = clamp01((wr - whiteLo) / (whiteHi - whiteLo));

      // aspect: oval logo is wider than tall (1 inside [aMin,aMax], 0 at aMin/2 and 2*aMax);
      // slivers and bars are never a logo, even half-covered by a hand
      aspect = w / h;
      if (aspect < 0.45 || aspect > 4.5) continue;
      if (aspect < aMin) sAspect = clamp01(1 - (aMin - aspect) / (aMin * 0.5));
      else if (aspect > aMax) sAspect = clamp01(1 - (aspect - aMax) / aMax);
      else sAspect = 1;

      // fill: a ring + letters is neither empty nor solid (unjudgeable when the box is tiny)
      fill = a / (w * h);
      if (w * h < 40) sFill = 1;
      else if (fill < 0.25) sFill = clamp01((fill - 0.1) / 0.15);
      else if (fill > 0.78) sFill = clamp01(1 - (fill - 0.78) / 0.17);
      else sFill = 1;

      // inner white: the oval's interior shows the white mug between the letters; a solid red
      // object has none. Measured on the central half of the box (the corners of any box around
      // a round object are background) and only on boxes large enough to resolve the interior.
      if (w * h < 60) sInner = 1;
      else {
        inner = ratioRect(integ, IW, bx0 + (w >> 2), by0 + (h >> 2), bx1 - (w >> 2), by1 - (h >> 2));
        sInner = clamp01(inner / 0.12);
      }

      // area: near the calibrated size, or simply "not tiny"
      if (refArea > 0) sArea = 1 - clamp01(Math.abs(Math.log(a / refArea) / Math.LN2) / 2.5);
      else { sArea = a / (4 * minArea); if (sArea < 0.25) sArea = 0.25; else if (sArea > 1) sArea = 1; }

      // temporal continuity
      cx = (cMinX[k] + cMaxX[k] + 1) * 0.5 / W; cy = (cMinY[k] + cMaxY[k] + 1) * 0.5 / H;
      if (prevX >= 0) { dist = Math.sqrt((cx - prevX) * (cx - prevX) + (cy - prevY) * (cy - prevY)); sTemp = 1 - clamp01(dist / tRange); }
      else sTemp = 0.5;

      score = 0.55 * sWhite + 0.12 * sAspect + 0.08 * sArea + 0.08 * sFill + 0.08 * sInner + 0.09 * sTemp;
      if (score > bestScore) { bestScore = score; best = k; bestWR = wr; sub[0] = sWhite; sub[1] = sAspect; sub[2] = sArea; sub[3] = sFill; sub[4] = sInner; sub[5] = sTemp; }
    }

    result.candidates = evaluated;
    if (best >= 0 && bestScore >= p.threshold) {
      result.found = true;
      result.x = (cMinX[best] + cMaxX[best] + 1) * 0.5 / W;
      result.y = (cMinY[best] + cMaxY[best] + 1) * 0.5 / H;
      result.w = (cMaxX[best] - cMinX[best] + 1) / W;
      result.h = (cMaxY[best] - cMinY[best] + 1) / H;
      result.score = bestScore;
      result.redArea = cArea[best];
      result.whiteRatio = bestWR;
    } else {
      result.found = false; result.x = 0; result.y = 0; result.w = 0; result.h = 0;
      result.score = bestScore; result.redArea = 0; result.whiteRatio = bestWR;
    }
    return result;
  }

  // ---------------------------------------------------------------------------------------------
  // Page-side tracker (camera, loop, worker, smoothing, calibration, debug drawing).
  // ---------------------------------------------------------------------------------------------
  var STORAGE_KEY = 'kk_tracker_params';
  var hasDOM = typeof document !== 'undefined' && typeof navigator !== 'undefined';
  var scriptUrl = hasDOM && document.currentScript && document.currentScript.src ? document.currentScript.src : '';
  var defaultWorkerUrl = scriptUrl ? scriptUrl.replace(/tracker\.js(\?.*)?$/, 'tracker-worker.js') : 'js/tracker-worker.js';

  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function numberOr(v, fallback) { return typeof v === 'number' && isFinite(v) ? v : fallback; }
  function mergeParams(base, extra) {
    var out = {}, key;
    for (key in base) out[key] = base[key];
    if (extra) for (key in extra) if (Object.prototype.hasOwnProperty.call(defaultParams, key)) out[key] = numberOr(extra[key], out[key]);
    return out;
  }
  // Lock-on ("acquire") parameters: the colour masks are opened up so the mug is found before anything
  // is known about the venue's light. Measured on photos of the real mug (tests/tracker/real-mug): the
  // cream body in cool or dim light sits just under the default whiteMin and scores zero, while with
  // these values the logo is found down to a mug of about a tenth of the frame height. Used on the
  // "show your mug" screen and as the starting point of calibrate(); calibration then narrows them.
  function acquireParams(p) {
    var a = mergeParams(defaultParams, p);
    a.redMin = Math.min(a.redMin, 70); a.redDelta = Math.min(a.redDelta, 30); a.redRatio = Math.min(a.redRatio, 1.8);
    a.whiteMin = Math.min(a.whiteMin, 110); a.whiteSpread = Math.max(a.whiteSpread, 90);
    a.minAreaFrac = Math.min(a.minAreaFrac, 0.0003); a.maxAreaFrac = Math.max(a.maxAreaFrac, 0.08);
    a.refAreaFrac = 0;
    return a;
  }
  function loadParams() {
    try {
      var raw = root.localStorage && root.localStorage.getItem(STORAGE_KEY);
      return raw ? mergeParams(defaultParams, JSON.parse(raw)) : mergeParams(defaultParams, null);
    } catch (e) { return mergeParams(defaultParams, null); }
  }
  function saveParams(p) {
    try {
      var copy = mergeParams(defaultParams, p); copy.prevX = -1; copy.prevY = -1;
      root.localStorage && root.localStorage.setItem(STORAGE_KEY, JSON.stringify(copy));
    } catch (e) { /* storage unavailable: calibration still applies to this session */ }
  }
  function thresholdFor(sensitivity) { return 0.47 + 0.16 * (1 - clamp01(sensitivity)); }
  function cameraError(err) {
    var name = (err && err.name) || '', code = 'error';
    if (/NotFound|DevicesNotFound|OverconstrainedError|TypeError/.test(name)) code = 'no-camera';
    else if (/NotAllowed|PermissionDenied|Security/.test(name)) code = 'denied';
    else if (/NotReadable|TrackStart|Abort/.test(name)) code = 'in-use';
    var msg = { 'no-camera': 'No camera was found. Connect the USB webcam and reload.',
                'denied': 'Camera access was denied. Allow the camera for this site in Chrome.',
                'in-use': 'The camera is in use by another app or could not be started.',
                'error': 'The camera could not be started.' }[code];
    return { code: code, message: msg + (err && err.message ? ' (' + name + ': ' + err.message + ')' : ''), cause: err };
  }

  function listCameras() {
    if (!hasDOM || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return Promise.resolve([]);
    return navigator.mediaDevices.enumerateDevices().then(function (devs) {
      var out = [], i, nth = 0;
      for (i = 0; i < devs.length; i++) if (devs[i].kind === 'videoinput') {
        nth++;
        out.push({ deviceId: devs[i].deviceId, label: devs[i].label || ('Camera ' + nth) });
      }
      return out;
    });
  }

  function percentile(hist, total, q) {
    var target = total * q, acc = 0, v;
    for (v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
    return 255;
  }

  function create(opts) {
    opts = opts || {};
    if (!hasDOM) throw new Error('MugTracker.create needs a document (use MugTracker.detect in workers/Node)');
    var video = opts.video || document.createElement('video');
    var o = {
      width: numberOr(opts.width, 160) | 0,
      height: numberOr(opts.height, 90) | 0,
      mirror: opts.mirror !== false,
      useWorker: opts.useWorker !== false,
      smoothing: clamp01(numberOr(opts.smoothing, 0.35)),
      lostAfterMs: numberOr(opts.lostAfterMs, 600),
      sensitivity: clamp01(numberOr(opts.sensitivity, 0.5)),
      workerUrl: opts.workerUrl || defaultWorkerUrl
    };
    var params = loadParams();
    params.threshold = thresholdFor(o.sensitivity);

    var tracker = { onUpdate: null, onError: null, video: video };
    var stream = null, running = false, usingWorker = false, worker = null, busy = false;
    var canvas = null, ctx = null, rvfcId = 0, rafId = 0, lastRafMs = 0;
    var state = { found: false, x: 0.5, y: 0.5, rawX: 0.5, rawY: 0.5, frameX: 0.5, frameY: 0.5, w: 0, h: 0,
                  confidence: 0, fps: 0, lastSeenMs: -Infinity, ts: 0, redArea: 0, whiteRatio: 0 };
    var haveSmoothed = false, lastFrameMs = 0, fpsEma = 0, frames = 0, skipped = 0;
    var calib = null;  // active calibration session
    var acquiring = false, acq = null;  // lock-on mode: detect with acquireParams(params) instead of params

    function makeCanvas() {
      if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(o.width, o.height);
      else { canvas = document.createElement('canvas'); canvas.width = o.width; canvas.height = o.height; }
      ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false }) || canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      try { ctx.imageSmoothingQuality = 'medium'; } catch (e) { /* optional */ }
    }

    function startWorker() {
      if (!o.useWorker || typeof Worker === 'undefined') return false;
      try {
        worker = new Worker(o.workerUrl);
      } catch (e) { worker = null; return false; }
      worker.onmessage = function (ev) {
        var m = ev.data;
        busy = false;
        if (!m) return;
        if (m.type === 'result') applyResult(m.result, m.ts);
        else if (m.type === 'error') dropWorker();
      };
      worker.onerror = function () { dropWorker(); };
      return true;
    }
    function dropWorker() {
      if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } }
      worker = null; usingWorker = false; busy = false;
    }

    function schedule() {
      if (!running) return;
      if (typeof video.requestVideoFrameCallback === 'function') rvfcId = video.requestVideoFrameCallback(onVideoFrame);
      else rafId = requestAnimationFrame(onRaf);
    }
    function onVideoFrame() { rvfcId = 0; schedule(); processFrame(now()); }
    function onRaf(t) {
      rafId = 0; schedule();
      if (t - lastRafMs < 31) return;        // ~30 fps cap
      lastRafMs = t; processFrame(now());
    }

    function processFrame(ts) {
      if (!running || video.readyState < 2 || !video.videoWidth) return;
      if (busy) { skipped++; return; }
      var W = o.width, H = o.height;
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      ctx.drawImage(video, 0, 0, W, H);
      var img = ctx.getImageData(0, 0, W, H);
      if (calib) calibSample(img);
      if (typeof tracker.onFrame === 'function') { try { tracker.onFrame(img, ts); } catch (e) { /* debug hook must never break tracking */ } }
      var use = params;
      if (acquiring && acq) { acq.threshold = params.threshold; acq.prevX = params.prevX; acq.prevY = params.prevY; use = acq; }
      if (usingWorker && worker) {
        busy = true;
        worker.postMessage({ type: 'detect', buffer: img.data.buffer, width: W, height: H, params: use, ts: ts }, [img.data.buffer]);
      } else {
        applyResult(detect(img, use), ts);
      }
    }

    function applyResult(res, ts) {
      if (!running) return;   // a worker result that lands after stop()
      frames++;
      if (lastFrameMs) { var inst = 1000 / Math.max(1, ts - lastFrameMs); fpsEma = fpsEma ? fpsEma + 0.1 * (inst - fpsEma) : inst; }
      lastFrameMs = ts;

      if (res.found) {
        var fx = res.x, fy = res.y;
        var mxv = o.mirror ? 1 - fx : fx;
        state.frameX = fx; state.frameY = fy; state.rawX = mxv; state.rawY = fy;
        if (!haveSmoothed) { state.x = mxv; state.y = fy; haveSmoothed = true; }
        else { var alpha = 1 - o.smoothing; state.x += alpha * (mxv - state.x); state.y += alpha * (fy - state.y); }
        state.w = res.w; state.h = res.h; state.found = true;
        state.confidence = clamp01(res.score); state.lastSeenMs = ts;
        state.redArea = res.redArea; state.whiteRatio = res.whiteRatio;
        params.prevX = fx; params.prevY = fy;
      } else if (ts - state.lastSeenMs > o.lostAfterMs) {
        state.found = false; state.confidence = 0; params.prevX = -1; params.prevY = -1;
      } else {
        state.confidence = clamp01(res.score);   // coasting on the last position
      }
      state.fps = fpsEma; state.ts = ts;
      if (typeof tracker.onDetect === 'function') { try { tracker.onDetect(res, ts, state); } catch (e) { /* debug hook must never break tracking */ } }
      if (typeof tracker.onUpdate === 'function') {
        tracker.onUpdate({ found: state.found, x: state.x, y: state.y, rawX: state.rawX, rawY: state.rawY,
          frameX: state.frameX, frameY: state.frameY, w: state.w, h: state.h, confidence: state.confidence,
          fps: state.fps, lastSeenMs: state.lastSeenMs, ts: state.ts, redArea: state.redArea, whiteRatio: state.whiteRatio });
      }
    }

    // ---- calibration ---------------------------------------------------------------------------
    function calibSample(img) {
      var c = calib;
      c.frames++;
      var res = detect(img, c.loose);
      var W = img.width, H = img.height, data = img.data;
      if (res.found) {
        var cx = res.x, cy = res.y;
        var inside = cx >= c.roi.x && cx <= c.roi.x + c.roi.w && cy >= c.roi.y && cy <= c.roi.y + c.roi.h;
        if (inside) {
          c.loose.prevX = cx; c.loose.prevY = cy;
          var x0 = Math.round((res.x - res.w / 2) * W), x1 = Math.round((res.x + res.w / 2) * W) - 1;
          var y0 = Math.round((res.y - res.h / 2) * H), y1 = Math.round((res.y + res.h / 2) * H) - 1;
          var ex = Math.max(2, Math.round(0.3 * (x1 - x0 + 1))), ey = Math.max(2, Math.round(0.3 * (y1 - y0 + 1)));
          var X0 = Math.max(0, x0 - ex), X1 = Math.min(W - 1, x1 + ex), Y0 = Math.max(0, y0 - ey), Y1 = Math.min(H - 1, y1 + ey);
          var x, y, d, r, g, bl, mx, mn, lo, hi, inBox;
          for (y = Y0; y <= Y1; y++) for (x = X0; x <= X1; x++) {
            d = (y * W + x) * 4; r = data[d]; g = data[d + 1]; bl = data[d + 2];
            mx = g > bl ? g : bl; mn = g < bl ? g : bl; lo = r < mn ? r : mn; hi = r > mx ? r : mx;
            inBox = x >= x0 && x <= x1 && y >= y0 && y <= y1;
            if (inBox && r > c.loose.redMin && (r - mx) > c.loose.redDelta && r > c.loose.redRatio * mx) {
              c.hR[r]++; c.hDelta[r - mx]++; c.hRatio[Math.min(255, Math.round(10 * r / (mx + 1)))]++; c.nRed++;
            } else if (!inBox && lo > 100 && (hi - lo) < 75) {   // mug body only: skin has a spread of 80+
              c.hLo[lo]++; c.hSpread[hi - lo]++; c.nWhite++;
            }
          }
          c.areas.push(res.redArea / (W * H));
          c.samples++;
        }
      }
      if (c.samples >= c.want || c.frames >= c.maxFrames || now() - c.started > c.timeoutMs) finishCalib();
    }
    function finishCalib() {
      var c = calib; calib = null;
      if (c.timer) clearTimeout(c.timer);
      if (c.samples < 5 || c.nRed < 20 || c.nWhite < 20) {
        c.resolve({ ok: false, samples: c.samples, params: mergeParams(defaultParams, params),
                    reason: c.frames === 0 ? 'no-frames' : 'logo-not-found' });
        return;
      }
      var np = mergeParams(defaultParams, params);
      // Thresholds sit well below the logo's own percentiles so that auto-exposure drift and the
      // player moving around keep the logo inside the masks; the white ring does the discriminating.
      np.redMin = Math.min(200, Math.max(60, Math.round(percentile(c.hR, c.nRed, 0.15) * 0.7)));
      np.redDelta = Math.min(120, Math.max(25, Math.round(percentile(c.hDelta, c.nRed, 0.15) * 0.5)));
      np.redRatio = Math.min(4, Math.max(1.8, Math.round(percentile(c.hRatio, c.nRed, 0.15) * 0.6) / 10));
      np.whiteMin = Math.min(220, Math.max(90, Math.round(percentile(c.hLo, c.nWhite, 0.15) * 0.85)));
      np.whiteSpread = Math.min(90, Math.max(40, Math.round(percentile(c.hSpread, c.nWhite, 0.85) * 1.3 + 12)));
      c.areas.sort(function (p, q) { return p - q; });
      var ref = c.areas[c.areas.length >> 1];
      np.refAreaFrac = ref;
      np.minAreaFrac = Math.max(0.00025, ref * 0.2);
      np.maxAreaFrac = Math.min(0.12, Math.max(ref * 6, 0.01));
      np.threshold = thresholdFor(o.sensitivity);
      np.prevX = params.prevX; np.prevY = params.prevY;
      params = np;
      saveParams(params);
      c.resolve({ ok: true, samples: c.samples, params: mergeParams(defaultParams, params) });
    }

    tracker.calibrate = function (roi) {
      roi = roi || {};
      var rx = numberOr(roi.x, 0.3), ry = numberOr(roi.y, 0.2), rw = numberOr(roi.w, 0.4), rh = numberOr(roi.h, 0.6);
      if (o.mirror) rx = 1 - rx - rw;   // ROI is given in screen (mirrored) space, like onUpdate x
      return new Promise(function (resolve, reject) {
        if (!running) { reject({ code: 'not-started', message: 'Start the tracker before calibrating.' }); return; }
        if (calib) { reject({ code: 'busy', message: 'A calibration is already running.' }); return; }
        var loose = acquireParams(params);
        loose.threshold = 0.35;
        loose.prevX = rx + rw / 2; loose.prevY = ry + rh / 2;
        calib = { roi: { x: rx, y: ry, w: rw, h: rh }, loose: loose, want: 15, maxFrames: 90, timeoutMs: 5000, started: now(),
                  frames: 0, samples: 0, nRed: 0, nWhite: 0, areas: [],
                  hR: new Uint32Array(256), hDelta: new Uint32Array(256), hRatio: new Uint32Array(256), hLo: new Uint32Array(256), hSpread: new Uint32Array(256),
                  resolve: resolve, timer: 0 };
        calib.timer = setTimeout(function () { if (calib) finishCalib(); }, 5500);
      });
    };

    // ---- public API ----------------------------------------------------------------------------
    tracker.start = function (startOpts) {
      startOpts = startOpts || {};
      if (running) tracker.stop();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return Promise.reject({ code: 'no-camera', message: 'getUserMedia is not available (needs https or localhost).' });
      }
      var vc = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30 } };
      if (startOpts.deviceId) vc.deviceId = { exact: startOpts.deviceId };
      else vc.facingMode = { ideal: startOpts.facingMode || 'user' };
      var fallback = { video: startOpts.deviceId ? { deviceId: { exact: startOpts.deviceId } } : true, audio: false };
      // Debug replay: a recorded round is played as the camera (set by js/recorder.js from ?replay=<session>).
      var replayUrl = startOpts.replayUrl || tracker.replayUrl || '';
      var source = replayUrl ? Promise.resolve(null) : navigator.mediaDevices.getUserMedia({ video: vc, audio: false })
        .catch(function (err) {
          if (err && /NotAllowed|PermissionDenied|Security/.test(err.name)) throw err;
          return navigator.mediaDevices.getUserMedia(fallback);
        })
        .catch(function (err) { throw cameraError(err); });
      return source
        .then(function (s) {
          stream = s;
          video.muted = true; video.playsInline = true; video.setAttribute('playsinline', ''); video.autoplay = true;
          if (replayUrl) { video.loop = true; video.src = replayUrl; } else video.srcObject = s;
          return video.play().catch(function () { /* autoplay nag: frames still arrive once playing */ });
        })
        .then(function () {
          if (!canvas) makeCanvas();
          usingWorker = startWorker();
          running = true; busy = false; haveSmoothed = false; lastFrameMs = 0; fpsEma = 0;
          state.found = false; state.lastSeenMs = -Infinity; params.prevX = -1; params.prevY = -1;
          var track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
          var st = track && track.getSettings ? track.getSettings() : {};
          console.log('MugTracker ready ' + (st.width || '?') + 'x' + (st.height || '?') + '@' + (st.frameRate ? Math.round(st.frameRate) : '?') +
                      ' -> ' + o.width + 'x' + o.height + (usingWorker ? ' (worker)' : ' (inline)'));
          schedule();
          return tracker;
        });
    };

    tracker.stop = function () {
      running = false;
      if (rvfcId && video.cancelVideoFrameCallback) { video.cancelVideoFrameCallback(rvfcId); rvfcId = 0; }
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      dropWorker();
      if (calib) finishCalib();
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      try { video.srcObject = null; if (video.getAttribute('src')) { video.removeAttribute('src'); video.load(); } } catch (e) { /* ignore */ }
      state.found = false;
    };

    tracker.setOptions = function (n) {
      n = n || {};
      if (n.sensitivity !== undefined) { o.sensitivity = clamp01(numberOr(n.sensitivity, o.sensitivity)); params.threshold = thresholdFor(o.sensitivity); }
      if (n.mirror !== undefined) o.mirror = !!n.mirror;
      if (n.smoothing !== undefined) o.smoothing = clamp01(numberOr(n.smoothing, o.smoothing));
      if (n.lostAfterMs !== undefined) o.lostAfterMs = numberOr(n.lostAfterMs, o.lostAfterMs);
      if (n.width !== undefined) o.width = Math.max(32, Math.min(320, numberOr(n.width, o.width) | 0));
      if (n.height !== undefined) o.height = Math.max(18, Math.min(180, numberOr(n.height, o.height) | 0));
      return tracker.getOptions();
    };
    tracker.getOptions = function () {
      return { width: o.width, height: o.height, mirror: o.mirror, useWorker: o.useWorker, usingWorker: usingWorker,
               smoothing: o.smoothing, lostAfterMs: o.lostAfterMs, sensitivity: o.sensitivity, running: running, acquiring: acquiring,
               frames: frames, skipped: skipped };
    };
    tracker.getParams = function () { return mergeParams(defaultParams, params); };
    tracker.setParams = function (extra) { params = mergeParams(params, extra); params.threshold = thresholdFor(o.sensitivity); saveParams(params); return tracker.getParams(); };
    tracker.resetParams = function () { params = mergeParams(defaultParams, null); params.threshold = thresholdFor(o.sensitivity); try { root.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ } return tracker.getParams(); };
    /** Lock-on mode for the "show your mug" screen: on = find the mug with the opened-up colour masks. */
    tracker.setAcquire = function (on) { acquiring = !!on; acq = acquiring ? acquireParams(params) : null; return acquiring; };
    tracker.getState = function () { return state; };
    tracker.getStream = function () { return stream; };

    /** Draws the (mirrored) camera frame, the detection box and the score into a 2D context. */
    tracker.debugDraw = function (c2d, w, h) {
      c2d.save();
      c2d.fillStyle = '#000'; c2d.fillRect(0, 0, w, h);
      if (video.readyState >= 2 && video.videoWidth) {
        if (o.mirror) { c2d.translate(w, 0); c2d.scale(-1, 1); }
        c2d.drawImage(video, 0, 0, w, h);
      }
      c2d.restore();
      var alive = state.lastSeenMs > -Infinity && (state.ts - state.lastSeenMs) <= o.lostAfterMs;
      if (alive) {
        var bw = state.w * w, bh = state.h * h;
        var bx = state.rawX * w - bw / 2, by = state.rawY * h - bh / 2;
        var pad = Math.max(4, bw * 0.3);
        c2d.lineWidth = 3; c2d.strokeStyle = state.found ? '#2ecc40' : '#ffdc00';
        c2d.strokeRect(bx - pad, by - pad, bw + 2 * pad, bh + 2 * pad);
        c2d.beginPath(); c2d.moveTo(state.x * w, 0); c2d.lineTo(state.x * w, h);
        c2d.lineWidth = 1; c2d.strokeStyle = 'rgba(46,204,64,.8)'; c2d.stroke();
      }
      var label = (state.found ? 'MUG DETECTED  ' : (alive ? 'coasting  ' : 'searching  ')) +
                  'score ' + state.confidence.toFixed(2) + '  fps ' + Math.round(state.fps) +
                  (usingWorker ? '  worker' : '  inline') + '  ' + o.width + 'x' + o.height;
      c2d.font = 'bold ' + Math.max(12, Math.round(h / 22)) + 'px sans-serif';
      c2d.textBaseline = 'top';
      c2d.fillStyle = 'rgba(0,0,0,.55)'; c2d.fillRect(0, 0, c2d.measureText(label).width + 16, Math.max(12, Math.round(h / 22)) + 10);
      c2d.fillStyle = state.found ? '#2ecc40' : '#fff'; c2d.fillText(label, 8, 5);
    };

    return tracker;
  }

  var MugTracker = { detect: detect, acquireParams: acquireParams, create: create, listCameras: listCameras, defaultParams: defaultParams, STORAGE_KEY: STORAGE_KEY };
  root.MugTracker = MugTracker;
  if (typeof module !== 'undefined' && module.exports) module.exports = MugTracker;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
