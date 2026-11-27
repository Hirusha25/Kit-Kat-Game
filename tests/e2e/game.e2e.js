// End-to-end: the real game page driven by Chrome's fake camera playing tests/tracker/fake-mug.y4m.
// Run: node tests/e2e/game.e2e.js   (generates the fake video if missing; exit 1 on failure)
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path'); const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const Y4M = path.join(ROOT, 'tests', 'tracker', 'fake-mug.y4m');
const OUT = process.env.OUT || path.join(ROOT, 'tests', 'e2e', 'out'); fs.mkdirSync(OUT, { recursive: true });
const DURATION = 12;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm' };
function serve() {
  return new Promise(res => {
    const srv = http.createServer((req, rs) => {
      const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
      fs.readFile(p, (e, d) => { if (e) { rs.writeHead(404); rs.end(); return; } rs.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); rs.end(d); });
    }).listen(0, '127.0.0.1', () => res(srv));
  });
}
function fail(msg) { console.error('FAIL: ' + msg); process.exitCode = 1; }

(async () => {
  if (!fs.existsSync(Y4M)) execSync('python3 tests/tracker/make-fake-video.py', { cwd: ROOT, stdio: 'inherit' });
  const srv = await serve(); const port = srv.address().port;
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${Y4M}`, '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 }, permissions: ['camera'] });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(() => { sessionStorage.setItem('kk_current', JSON.stringify({ name: 'Test Player', code: 'TEST' })); });

  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/game.html?duration=${DURATION}&debug=1`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  // First boot shows the camera-check screen; confirm the (fake) camera to reach "Show your mug".
  const camShown = await page.evaluate(() => { const el = document.getElementById('ov-cam'); return !!(el && el.classList.contains('show')); });
  if (camShown) { await page.click('#cam-ok', { force: true }); await page.waitForTimeout(800); }
  console.log('camera check shown:', camShown);
  await page.screenshot({ path: path.join(OUT, '1-calibration.png') });

  // Calibration should lock within ~6 s of the mug being visible
  const locked = await page.waitForFunction(() => window.__kk && (window.__kk.phase === 'how' || window.__kk.phase === 'countdown' || window.__kk.phase === 'playing'), null, { timeout: 15000 }).then(() => true).catch(() => false);
  if (!locked) fail('calibration never locked on the mug');
  console.log(`calibration locked after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await page.screenshot({ path: path.join(OUT, '2-countdown.png') });

  await page.waitForFunction(() => window.__kk.phase === 'playing', null, { timeout: 20000 }); // how-to-play (6 s) + countdown
  // Sample tracking + mug position for 4 s
  const samples = [];
  for (let i = 0; i < 40; i++) {
    samples.push(await page.evaluate(() => ({ tx: window.__kk.track.x, found: window.__kk.track.found, mug: window.__kk.game.getState().mugX01, score: window.__kk.game.getState().score })));
    await page.waitForTimeout(100);
    if (i === 25) await page.screenshot({ path: path.join(OUT, '3-playing.png') });
  }
  const foundRate = samples.filter(s => s.found).length / samples.length;
  const span = Math.max(...samples.map(s => s.mug)) - Math.min(...samples.map(s => s.mug));
  // correlation between tracker x and engine mug x (engine lags via spring, so compare with a 1-sample lag)
  const a = samples.slice(0, -1).map(s => s.tx), b = samples.slice(1).map(s => s.mug);
  const ma = a.reduce((p, c) => p + c, 0) / a.length, mb = b.reduce((p, c) => p + c, 0) / b.length;
  const cov = a.reduce((p, c, i) => p + (c - ma) * (b[i] - mb), 0), va = a.reduce((p, c) => p + (c - ma) ** 2, 0), vb = b.reduce((p, c) => p + (c - mb) ** 2, 0);
  const corr = cov / Math.sqrt(va * vb || 1);
  console.log(`tracking: found ${(foundRate * 100).toFixed(0)}%  mug span ${span.toFixed(2)}  tracker→mug correlation ${corr.toFixed(3)}`);
  if (foundRate < 0.9) fail('mug found rate below 90% during play');
  if (span < 0.3) fail('mug barely moved; tracking is not driving the engine');
  if (corr < 0.85) fail('engine mug does not follow the tracker');

  // Round end -> results
  const ended = await page.waitForFunction(() => window.__kk.phase === 'ended', null, { timeout: (DURATION + 10) * 1000 }).then(() => true).catch(() => false);
  if (!ended) fail('round did not end');
  await page.waitForTimeout(1500);
  const result = await page.evaluate(() => window.__kk.result);
  const hud = await page.evaluate(() => ({ time: document.getElementById('hud-time').textContent, score: document.getElementById('hud-score').textContent, rank: document.getElementById('hud-rank').textContent }));
  const endVisible = await page.evaluate(() => document.getElementById('ov-end').classList.contains('show'));
  await page.screenshot({ path: path.join(OUT, '4-results.png') });
  console.log('result:', JSON.stringify(result), 'hud:', JSON.stringify(hud), 'results overlay:', endVisible);
  if (!endVisible) fail('results overlay not shown');
  if (hud.time !== '00:00') fail('HUD timer did not reach 00:00');
  const board = await page.evaluate(() => JSON.parse(localStorage.getItem('kk_leaderboard') || '{}'));
  if (!board.rows || !board.rows.length) fail('score not recorded on the leaderboard');

  if (errors.length) { console.error('page errors:', errors); process.exitCode = 1; }
  console.log(process.exitCode ? 'E2E FAILED' : 'E2E PASSED');
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
