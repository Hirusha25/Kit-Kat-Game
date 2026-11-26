#!/usr/bin/env node
/*
 * End-to-end test: real Chromium (Playwright) + fake camera fed with tests/tracker/fake-mug.y4m.
 *   node tests/tracker/e2e.js [--headed] [--keep]
 * Serves the repo on a free port, opens tests/tracker/harness.html, samples 4 s of tracker output
 * (worker and inline modes), and checks that the tracked x follows the sine the clip was rendered
 * with, that the found rate is high, that mirroring is applied, and that calibrate() succeeds.
 * Exit code 1 on failure. Regenerates the clip with make-fake-video.py when it is missing.
 */
'use strict';
var fs = require('fs'), path = require('path'), http = require('http'), cp = require('child_process');
var playwright = require('playwright');

var ROOT = path.join(__dirname, '..', '..');
var CLIP = path.join(__dirname, 'fake-mug.y4m');
var META = path.join(__dirname, 'fake-mug.json');
var HEADED = process.argv.indexOf('--headed') >= 0;
var failures = [];
function check(cond, msg) { if (!cond) failures.push(msg); console.log((cond ? '  ok   ' : '  FAIL ') + msg); }

var MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json',
             '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.y4m': 'application/octet-stream' };
function serve() {
  return new Promise(function (resolve) {
    var server = http.createServer(function (req, res) {
      var p = decodeURIComponent(req.url.split('?')[0]);
      var file = path.normalize(path.join(ROOT, p === '/' ? 'index.html' : p));
      if (file.indexOf(ROOT) !== 0 || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', function () { resolve({ server: server, port: server.address().port }); });
  });
}

function pearson(a, b) {
  var n = a.length, ma = 0, mb = 0, i;
  for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  var sab = 0, saa = 0, sbb = 0;
  for (i = 0; i < n; i++) { var da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}
// Best correlation between x(t) and a sine of the known period over all phases (the clip's start
// time relative to the page is unknown, so the phase is fitted; the frequency is not).
function sineFit(ts, xs, periodS) {
  var w = 2 * Math.PI / (periodS * 1000), best = -1, bestPhase = 0, e = new Array(ts.length);
  for (var deg = 0; deg < 360; deg += 2) {
    var ph = deg * Math.PI / 180;
    for (var i = 0; i < ts.length; i++) e[i] = Math.sin(w * ts[i] + ph);
    var c = pearson(xs, e);
    if (c > best) { best = c; bestPhase = deg; }
  }
  return { corr: best, phaseDeg: bestPhase };
}
function quantile(arr, q) { var s = arr.slice().sort(function (a, b) { return a - b; }); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]; }

function analyse(samples, meta, label) {
  var found = samples.filter(function (s) { return s.found; });
  var rate = samples.length ? found.length / samples.length : 0;
  var ts = found.map(function (s) { return s.ts; }), xs = found.map(function (s) { return s.x; });
  var fit = found.length > 10 ? sineFit(ts, xs, meta.motion.period) : { corr: 0, phaseDeg: 0 };
  var span = found.length ? quantile(xs, 0.95) - quantile(xs, 0.05) : 0;
  var mirrorOk = found.every(function (s) { return Math.abs(s.rawX - (1 - s.frameX)) < 1e-6; });
  var fps = samples.length ? samples[samples.length - 1].fps : 0;
  var dur = samples.length ? (samples[samples.length - 1].ts - samples[0].ts) / 1000 : 0;
  var conf = found.length ? found.reduce(function (a, s) { return a + s.confidence; }, 0) / found.length : 0;
  console.log('  ' + label + ': ' + samples.length + ' frames in ' + dur.toFixed(1) + ' s (' + (samples.length / Math.max(0.1, dur)).toFixed(1) + ' fps, tracker fps ' + fps.toFixed(1) + ')' +
              '  found ' + (rate * 100).toFixed(1) + '%  sine corr ' + fit.corr.toFixed(3) + ' (phase ' + fit.phaseDeg + ' deg)' +
              '  x p5..p95 span ' + span.toFixed(3) + ' (expected ~' + (2 * meta.motion.amp * 0.95).toFixed(2) + ')  mean conf ' + conf.toFixed(2));
  return { rate: rate, corr: fit.corr, span: span, mirrorOk: mirrorOk, n: samples.length, fps: fps };
}

function run() {
  if (!fs.existsSync(CLIP) || !fs.existsSync(META)) {
    console.log('Rendering fake camera clip...');
    cp.execFileSync('python3', [path.join(__dirname, 'make-fake-video.py'), CLIP], { stdio: 'inherit' });
  }
  var meta = JSON.parse(fs.readFileSync(META, 'utf8'));
  var srv, browser;
  return serve().then(function (s) {
    srv = s;
    return playwright.chromium.launch({
      headless: !HEADED,
      args: ['--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + CLIP, '--use-fake-ui-for-media-stream',
             '--autoplay-policy=no-user-gesture-required', '--no-sandbox']
    });
  }).then(function (b) {
    browser = b;
    var modes = [{ worker: 1, label: 'worker 160x90' }, { worker: 0, label: 'inline 160x90' }, { worker: 1, w: 320, h: 180, label: 'worker 320x180' }];
    var results = {};
    return modes.reduce(function (chain, mode) {
      return chain.then(function () { return runMode(browser, srv.port, mode, meta).then(function (r) { results[mode.label] = r; }); });
    }, Promise.resolve()).then(function () { return results; });
  }).then(function (results) {
    console.log('\nChecks');
    Object.keys(results).forEach(function (label) {
      var r = results[label];
      check(r.n >= 60, label + ': at least 60 frames processed in 4 s (' + r.n + ')');
      check(r.rate > 0.9, label + ': found rate > 90% (' + (r.rate * 100).toFixed(1) + '%)');
      check(r.corr > 0.9, label + ': tracked x follows the sine, corr > 0.9 (' + r.corr.toFixed(3) + ')');
      check(r.span > 0.35 && r.span < 0.75, label + ': x amplitude plausible (' + r.span.toFixed(3) + ')');
      check(r.mirrorOk, label + ': rawX is the mirrored frame x');
      check(!r.consoleErrors.length, label + ': no console errors' + (r.consoleErrors.length ? ' (' + r.consoleErrors.join(' | ') + ')' : ''));
      check(r.consoleLines <= 1, label + ': at most one console line from the tracker (' + r.consoleLines + ')');
      if (label.indexOf('worker') === 0) check(r.usingWorker === true, label + ': worker path active');
      if (r.restart) check(r.restart.stopped && r.restart.resumed && r.restart.running, label + ': stop() halts updates and start() resumes them (' + JSON.stringify(r.restart) + ')');
      if (r.calib) {
        check(r.calib.ok === true && r.calib.samples >= 15, label + ': calibrate() ok with ' + r.calib.samples + ' samples (' + JSON.stringify(r.calib.params ? { redMin: r.calib.params.redMin, redDelta: r.calib.params.redDelta, redRatio: r.calib.params.redRatio, whiteMin: r.calib.params.whiteMin, whiteSpread: r.calib.params.whiteSpread, refAreaFrac: +r.calib.params.refAreaFrac.toFixed(5) } : null) + ')');
        check(r.afterCalibRate > 0.9, label + ': found rate after calibration > 90% (' + (r.afterCalibRate * 100).toFixed(1) + '%)');
        check(r.stored === true, label + ': params persisted to localStorage');
      }
    });
  }).then(function () { return cleanup(browser, srv); }, function (err) { console.error(err); failures.push(String(err)); return cleanup(browser, srv); })
  .then(function () {
    console.log('\n' + (failures.length ? failures.length + ' FAILED:\n  ' + failures.join('\n  ') : 'ALL PASSED'));
    process.exit(failures.length ? 1 : 0);
  });
}

function cleanup(browser, srv) {
  return Promise.resolve().then(function () { return browser && browser.close(); }).catch(function () {}).then(function () { srv && srv.server.close(); });
}

function runMode(browser, port, mode, meta) {
  var consoleErrors = [], consoleLines = 0;
  var ctx, page;
  return browser.newContext({ permissions: ['camera'] }).then(function (c) {
    ctx = c;
    return ctx.newPage();
  }).then(function (p) {
    page = p;
    page.on('console', function (m) { if (m.type() === 'error') consoleErrors.push(m.text()); else if (/MugTracker/.test(m.text())) consoleLines++; });
    page.on('pageerror', function (e) { consoleErrors.push('pageerror: ' + e.message); });
    var url = 'http://127.0.0.1:' + port + '/tests/tracker/harness.html?worker=' + mode.worker + (mode.w ? '&w=' + mode.w + '&h=' + mode.h : '');
    return page.goto(url);
  }).then(function () {
    return page.waitForFunction(function () { return window.__status !== 'starting'; }, null, { timeout: 20000 });
  }).then(function () {
    return page.evaluate(function () { return window.__status; });
  }).then(function (status) {
    if (status !== 'running') throw new Error(mode.label + ': tracker did not start: ' + JSON.stringify(status));
    return page.waitForFunction(function () { return window.__track.length > 5; }, null, { timeout: 10000 });
  }).then(function () {
    return page.waitForTimeout(1500);                                   // warm-up (camera ramp, JIT)
  }).then(function () {
    return page.evaluate(function () { window.__track.length = 0; });
  }).then(function () {
    return page.waitForTimeout(4000);
  }).then(function () {
    return page.evaluate(function () { return { samples: window.__track.slice(), opts: window.__tracker.getOptions() }; });
  }).then(function (data) {
    var r = analyse(data.samples, meta, mode.label);
    r.usingWorker = data.opts.usingWorker; r.consoleErrors = consoleErrors; r.consoleLines = consoleLines;
    if (mode.worker === 0) {
      // stop(): no more updates; start() again: updates resume
      return page.evaluate(function () {
        var t = window.__tracker; t.stop();
        return new Promise(function (resolve) { setTimeout(function () {
          var n0 = window.__track.length;
          setTimeout(function () {
            var stopped = window.__track.length === n0 && t.getOptions().running === false;
            t.start().then(function () { setTimeout(function () { resolve({ stopped: stopped, resumed: window.__track.length > n0 + 10, running: t.getOptions().running }); }, 1000); },
                           function (e) { resolve({ stopped: stopped, resumed: false, error: e }); });
          }, 400);
        }, 100); });
      }).then(function (sr) { r.restart = sr; return r; });
    }
    if (mode.worker !== 1 || mode.w) return r;
    // calibration on the default (worker) mode: the mug sweeps through the centre ROI
    return page.evaluate(function () {
      try { localStorage.removeItem('kk_tracker_params'); } catch (e) {}
      return window.__tracker.calibrate({ x: 0.2, y: 0.1, w: 0.6, h: 0.8 }).then(function (res) {
        window.__track.length = 0;
        return new Promise(function (resolve) { setTimeout(function () {
          var t = window.__track.slice(); var f = t.filter(function (s) { return s.found; }).length;
          var stored = false; try { stored = !!localStorage.getItem('kk_tracker_params'); } catch (e) {}
          resolve({ calib: res, afterCalibRate: t.length ? f / t.length : 0, stored: stored });
        }, 2000); });
      });
    }).then(function (c) { r.calib = c.calib; r.afterCalibRate = c.afterCalibRate; r.stored = c.stored; return r; });
  }).then(function (r) {
    return ctx.close().then(function () { return r; });
  });
}

run();
