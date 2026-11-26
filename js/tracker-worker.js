/*
 * Web Worker for MugTracker: runs the pure detector off the main thread.
 *
 * Message in:  {type:'detect', buffer: ArrayBuffer (RGBA), width, height, params, ts}
 * Message out: {type:'result', result: {found,x,y,w,h,score,redArea,whiteRatio}, buffer, width, height, ts}
 *              {type:'error', message}
 * The pixel buffer is transferred in both directions so no copy is made.
 */
/* global importScripts, self, MugTracker */
importScripts('tracker.js');   // defines self.MugTracker (same file as the page uses)

var detect = self.MugTracker.detect;
var view = null;   // reused ImageData-like wrapper

self.onmessage = function (ev) {
  var m = ev.data;
  if (!m || m.type !== 'detect') return;
  try {
    var data = new Uint8ClampedArray(m.buffer);
    if (!view || view.width !== m.width || view.height !== m.height) view = { data: data, width: m.width, height: m.height };
    else view.data = data;
    var r = detect(view, m.params || MugTracker.defaultParams);
    self.postMessage({
      type: 'result', ts: m.ts, width: m.width, height: m.height, buffer: m.buffer,
      result: { found: r.found, x: r.x, y: r.y, w: r.w, h: r.h, score: r.score, redArea: r.redArea, whiteRatio: r.whiteRatio, candidates: r.candidates, sub: r.sub }
    }, [m.buffer]);
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e && e.message || e) });
  }
};
