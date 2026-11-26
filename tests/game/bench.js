#!/usr/bin/env node
/* Playwright benchmark for the real engine (js/sprites.js + js/game.js).
 *
 *   node tests/game/bench.js [--seconds 10] [--min-fps 55] [--reduced] [--headed]
 *
 * Serves the repo over a local static server, opens tests/game/bench.html in
 * Chromium at 1080x1920, drives the engine with a synthetic 30 Hz sine input and
 * prints average frame time, fps, p95/max frame time and dropped frames.
 * Exit code 1 when fps < --min-fps (default 55) or the page reports an error.
 *
 * Requires a globally installed `playwright` with Chromium already present.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const flag = name => args.includes('--' + name);
const SECONDS = +opt('seconds', 10);
const MIN_FPS = +opt('min-fps', 55);
const ROOT = path.join(__dirname, '..', '..');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.css': 'text/css' };

function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      const file = path.normalize(path.join(ROOT, url));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

(async () => {
  let playwright;
  try { playwright = require('playwright'); }
  catch (e) { console.error('playwright is not installed globally: ' + e.message); process.exit(2); }

  const { server, port } = await serve();
  const browser = await playwright.chromium.launch({ headless: !flag('headed') });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  let pageErrors = 0;
  page.on('pageerror', e => { if (pageErrors++ < 3) console.error('[page error]', e.message); });
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console.' + m.type() + ']', m.text()); });

  const url = `http://127.0.0.1:${port}/tests/game/bench.html?seconds=${SECONDS}${flag('reduced') ? '&reduced=1' : ''}`;
  await page.goto(url);
  const handle = await page.waitForFunction(() => window.__benchResult, null, { timeout: (SECONDS + 30) * 1000 });
  const result = await handle.jsonValue();

  await browser.close();
  server.close();

  if (result.error) { console.error('bench page error:', result.error); process.exit(1); }
  console.log(JSON.stringify(result, null, 2));
  const healthy = pageErrors === 0 && result.caught > 0;
  const ok = result.fps >= MIN_FPS && healthy;
  if (!healthy) console.error(`engine unhealthy: ${pageErrors} page error(s), ${result.caught} catches`);
  console.log(`\n${ok ? 'PASS' : 'FAIL'}: ${result.fps} fps (min ${MIN_FPS}), avg ${result.avgFrameMs} ms, p95 ${result.p95FrameMs} ms, dropped ${result.droppedFrames}/${result.frames}`);
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
