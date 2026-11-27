/*
 * Hand backup for the mug tracker (window.KKHand).
 *
 * The mug tracker follows the red KitKat logo. When the logo cannot be seen (glare, washed-out light, the logo
 * turned away or covered) the game used to lose the mug. This module finds the HAND that holds the mug with
 * MediaPipe Hand Landmarker (21 points, all five fingers) so the game can follow the hand until the logo is back.
 *
 * Measured on a round recorded on the venue kiosk (27 Nov): the hand holding the mug was found in about 80% of
 * the frames, always the same distance to the handle side of the logo (0.17 of the picture width, +-0.04). The
 * logo is found more often and more exactly, so the logo leads and the hand is the backup. See flow.js withHand().
 *
 * The detector runs in a Web Worker (js/hand-worker.js). The page only draws a small upright picture and hands
 * it over, and never sends a new picture before the last one has come back. While the logo is tracked the
 * hand is checked a few times a second (to learn where it sits beside the logo); while the logo is missing it
 * runs as fast as the device allows. Nothing leaves the device.
 *
 *   var hand = KKHand.create({ draw: function (ctx, w, h) { ...draw the upright, unmirrored camera picture... } });
 *   hand.start(); hand.setFast(true|false); hand.latest() -> { at, hands:[{x,y,w,h}] } | null; hand.stats(); hand.stop();
 */
(function (root) {
  'use strict';
  var BASE = 'vendor/mediapipe-0.10.14/', WORKER = 'js/hand-worker.js?v=20261127q';

  function supported() { return typeof Worker !== 'undefined' && typeof createImageBitmap === 'function' && typeof WebAssembly !== 'undefined'; }

  function create(opts) {
    var W = opts.width || 384, H = opts.height || 216;
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H; var cx = cv.getContext('2d');
    var worker = null, ready = false, busy = false, running = false, fast = false, timer = 0, sentAt = 0;
    var last = null, st = { state: 'off', delegate: '', ms: 0, n: 0, perSec: 0, error: '', softErrors: 0 }, rateT = 0, rateN = 0;

    function schedule(ms) { clearTimeout(timer); if (running) timer = setTimeout(pump, ms); }
    function gap() { return fast ? Math.max(60, st.ms * 1.15) : Math.max(280, st.ms * 3); }   // slow = learning mode: about 3 a second at most
    function pump() {
      if (!running) return;
      if (!ready || busy || document.hidden) { schedule(120); return; }
      var now = performance.now();
      try { cx.clearRect(0, 0, W, H); opts.draw(cx, W, H); } catch (e) { schedule(300); return; }
      busy = true; sentAt = now;
      createImageBitmap(cv).then(function (bmp) {
        if (!running || !worker) { bmp.close && bmp.close(); busy = false; return; }
        worker.postMessage({ type: 'frame', bitmap: bmp, ts: now }, [bmp]);
      }).catch(function () { busy = false; schedule(300); });
    }
    function onMsg(e) {
      var m = e.data || {};
      if (m.type === 'ready') { ready = true; st.state = 'on'; st.delegate = m.delegate; schedule(0); return; }
      if (m.type === 'error') { if (m.soft) { st.softErrors++; return; } st.state = 'failed'; st.error = String(m.error).slice(0, 160); stop(true); return; }
      if (m.type === 'hands') {
        busy = false; var now = performance.now();
        st.ms = st.ms ? st.ms + 0.2 * (m.ms - st.ms) : m.ms; st.n++;
        rateN++; if (now - rateT > 2000) { st.perSec = rateN * 1000 / (now - rateT); rateT = now; rateN = 0; }
        last = { at: now, shotAt: m.ts, hands: m.hands };
        schedule(Math.max(0, gap() - (now - sentAt)));
      }
    }
    function start() {
      if (running || !supported()) { if (!supported()) st.state = 'unsupported'; return; }
      running = true; st.state = 'loading'; st.error = ''; rateT = performance.now(); rateN = 0;
      try {
        worker = new Worker(opts.workerUrl || WORKER);
        worker.onmessage = onMsg;
        worker.onerror = function (e) { st.state = 'failed'; st.error = String(e && e.message || 'worker error').slice(0, 160); stop(true); };
        worker.postMessage({ type: 'init', base: new URL(opts.base || BASE, location.href).href, delegate: opts.delegate || '' });
      } catch (e) { st.state = 'failed'; st.error = String(e).slice(0, 160); running = false; }
    }
    function stop(keepState) {
      running = false; ready = false; busy = false; clearTimeout(timer); last = null;
      if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } worker = null; }
      if (!keepState) st.state = 'off';
    }
    return {
      start: start, stop: function () { stop(false); },
      setFast: function (on) { on = !!on; if (on !== fast) { fast = on; if (on && ready && !busy) schedule(0); } },
      latest: function () { return last; },
      stats: function () { return { state: st.state, delegate: st.delegate, ms: Math.round(st.ms), perSec: +st.perSec.toFixed(1), frames: st.n, error: st.error, fast: fast }; }
    };
  }
  root.KKHand = { create: create, supported: supported };
})(window);
