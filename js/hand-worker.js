/*
 * Hand detector worker (the backup for the mug tracker, see js/hand.js).
 * Runs MediaPipe Hand Landmarker off the main thread, so the game never waits for it.
 *   in : { type:'init', base }                    base = URL of vendor/mediapipe-0.10.14/
 *        { type:'frame', bitmap, ts }             an upright camera picture (ImageBitmap, transferred)
 *   out: { type:'ready', delegate } | { type:'error', error }
 *        { type:'hands', ts, ms, hands:[{x,y,w,h,side}] }   x,y = palm centre, w,h = box of the whole hand, all 0..1 of the picture
 */
/* global MPVision, importScripts */
var landmarker = null, delegate = '';
var PALM = [0, 5, 9, 13, 17];   // wrist and the four finger bases: steadier than the fingertips

function make(base, d) {
  return MPVision.HandLandmarker.createFromOptions(
    { wasmLoaderPath: base + 'vision_wasm_internal.js', wasmBinaryPath: base + 'vision_wasm_internal.wasm' },
    { baseOptions: { modelAssetPath: base + 'hand_landmarker.task', delegate: d }, runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: 0.3, minHandPresenceConfidence: 0.3, minTrackingConfidence: 0.3 });
}

self.onmessage = function (e) {
  var m = e.data || {};
  if (m.type === 'init') {
    try { importScripts(m.base + 'vision_bundle.js'); } catch (err) { self.postMessage({ type: 'error', error: 'load: ' + err }); return; }
    var want = m.delegate === 'CPU' ? ['CPU'] : ['GPU', 'CPU'];
    (function next(i) {
      make(m.base, want[i]).then(function (h) { landmarker = h; delegate = want[i]; self.postMessage({ type: 'ready', delegate: delegate }); })
        .catch(function (err) { if (i + 1 < want.length) next(i + 1); else self.postMessage({ type: 'error', error: 'init: ' + err }); });
    })(0);
    return;
  }
  if (m.type === 'frame') {
    var out = [], t0 = performance.now();
    try {
      if (landmarker) {
        var r = landmarker.detectForVideo(m.bitmap, Math.round(m.ts));
        var L = r.landmarks || [], Hd = r.handednesses || r.handedness || [];
        for (var i = 0; i < L.length; i++) {
          var lm = L[i], x0 = 1, y0 = 1, x1 = 0, y1 = 0, px = 0, py = 0;
          for (var k = 0; k < lm.length; k++) { x0 = Math.min(x0, lm[k].x); y0 = Math.min(y0, lm[k].y); x1 = Math.max(x1, lm[k].x); y1 = Math.max(y1, lm[k].y); }
          for (k = 0; k < PALM.length; k++) { px += lm[PALM[k]].x; py += lm[PALM[k]].y; }
          out.push({ x: px / PALM.length, y: py / PALM.length, w: x1 - x0, h: y1 - y0, side: Hd[i] && Hd[i][0] ? Hd[i][0].categoryName : '' });
        }
      }
    } catch (err) { self.postMessage({ type: 'error', error: 'detect: ' + err, soft: true }); }
    try { m.bitmap && m.bitmap.close && m.bitmap.close(); } catch (err2) { /* ignore */ }
    self.postMessage({ type: 'hands', ts: m.ts, ms: performance.now() - t0, hands: out });
  }
};
