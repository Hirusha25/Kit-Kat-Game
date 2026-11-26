// Captures every kiosk screen into tests/e2e/screens/ and one numbered contact sheet.
// Run: node tests/e2e/screens.js   (uses Chrome's fake camera with tests/tracker/fake-mug.y4m)
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path'); const { execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const Y4M = path.join(ROOT, 'tests', 'tracker', 'fake-mug.y4m');
const OUT = path.join(ROOT, 'tests', 'e2e', 'screens'); fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp' };
function serve() { return new Promise(res => { const srv = http.createServer((req, rs) => { const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0])); fs.readFile(p, (e, d) => { if (e) { rs.writeHead(404); rs.end(); return; } rs.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); rs.end(d); }); }).listen(0, '127.0.0.1', () => res(srv)); }); }

(async () => {
  if (!fs.existsSync(Y4M)) execSync('python3 tests/tracker/make-fake-video.py', { cwd: ROOT, stdio: 'inherit' });
  const srv = await serve(); const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${Y4M}`, '--use-fake-ui-for-media-stream'] });
  const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 }, permissions: ['camera'] });
  const page = await ctx.newPage();
  await page.addInitScript(() => { sessionStorage.setItem('kk_current', JSON.stringify({ name: 'Amaya Perera', mobile: '0771234567', code: 'TEST' })); localStorage.removeItem('kk_settings'); });
  const shots = [];
  async function shot(n, name) { const f = path.join(OUT, `${String(n).padStart(2, '0')}-${name}.png`); await page.screenshot({ path: f }); shots.push({ n, name, f }); console.log('captured', n, name); }

  await page.goto(base + 'index.html', { waitUntil: 'networkidle' }); await page.waitForTimeout(1800); await shot(1, 'cover');
  await page.goto(base + 'register.html', { waitUntil: 'networkidle' }); await page.waitForTimeout(900); await shot(2, 'register-empty');
  await page.click('#name'); for (const k of ['a', 'm', 'a', 'y', 'a', 'space', 'p', 'e', 'r', 'e', 'r', 'a', 'done']) await page.click(`.key[data-k="${k}"]`);
  await page.click('#dob'); for (const k of ['1', '2', '0', '5', '1', '9', '9', '8', 'done']) await page.click(`.key[data-k="${k}"]`);
  await page.click('#mobile'); await page.waitForTimeout(300); await shot(3, 'register-keyboard');
  for (const k of ['0', '7', '7', '1', '2', '3', '4', '5', '6', '7', 'done']) await page.click(`.key[data-k="${k}"]`);
  await page.click('#consent'); await page.waitForTimeout(300); await shot(4, 'register-filled');

  await page.goto(base + 'game.html?duration=6', { waitUntil: 'networkidle' }); await page.waitForTimeout(1500); await shot(5, 'show-your-mug');
  await page.waitForFunction(() => window.__kk.phase === 'countdown', null, { timeout: 20000 }); await page.waitForTimeout(300); await shot(6, 'countdown');
  await page.waitForFunction(() => window.__kk.phase === 'playing', null, { timeout: 10000 }); await page.waitForTimeout(2500); await shot(7, 'gameplay');
  await page.evaluate(() => window.__kk.show('lost')); await page.waitForTimeout(200); await shot(8, 'show-the-mug-paused'); await page.evaluate(() => window.__kk.show(null));
  await page.waitForFunction(() => window.__kk.phase === 'ended', null, { timeout: 20000 }); await page.waitForTimeout(2800);
  await page.evaluate(() => { window.__kk.setScore(30); document.getElementById('end-title').textContent = 'Legend!'; document.getElementById('end-rank').textContent = '#1'; document.getElementById('end-caught').textContent = '2'; document.getElementById('end-streak').textContent = '1'; document.getElementById('prize').classList.remove('none'); document.getElementById('prize-name').textContent = 'You won a KitKat T-shirt!'; document.getElementById('prize-msg').textContent = 'Show this code at the counter to collect your prize.'; document.getElementById('prize-code').style.display = ''; document.getElementById('prize-code').textContent = 'TEE-P7RT'; document.getElementById('prize-pic').src = 'assets/img/game/prize-tee.png'; });
  await shot(9, 'results-prize');
  // results with no prize: force a zero score view
  await page.evaluate(() => { window.__kk.setScore(4); document.getElementById('prize').classList.add('none'); document.getElementById('prize-name').textContent = 'So Close!'; document.getElementById('prize-msg').textContent = 'Score 12 for a cap, 25 for a T-shirt.'; document.getElementById('prize-code').style.display = 'none'; document.getElementById('end-title').textContent = "Time's Up!"; });
  await shot(10, 'results-no-prize');
  await page.keyboard.press('c'); await page.waitForTimeout(800); await shot(11, 'staff-setup-panel');

  // contact sheet
  const cols = 5, cw = 432, ch = 768, pad = 40, label = 70;
  const rows = Math.ceil(shots.length / cols);
  const sheet = await ctx.newPage(); await sheet.setViewportSize({ width: cols * (cw + pad) + pad, height: rows * (ch + label + pad) + pad });
  const imgs = shots.map(s => ({ ...s, data: 'data:image/png;base64,' + fs.readFileSync(s.f).toString('base64') }));
  await sheet.setContent(`<body style="margin:0;background:#1b0507;font-family:Arial"><div style="display:grid;grid-template-columns:repeat(${cols},${cw}px);gap:${pad}px;padding:${pad}px">` +
    imgs.map(s => `<div><img src="${s.data}" style="width:${cw}px;height:${ch}px;display:block;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.6)"><div style="height:${label}px;display:flex;align-items:center;gap:12px;color:#fff;font:700 24px Arial"><span style="width:40px;height:40px;border-radius:50%;background:#f3cf7a;color:#5a0d16;display:grid;place-items:center">${s.n}</span>${s.name.replace(/-/g, ' ')}</div></div>`).join('') + '</div></body>');
  await sheet.waitForTimeout(500); await sheet.screenshot({ path: path.join(OUT, 'all-screens.png'), fullPage: true });
  console.log('sheet:', path.join(OUT, 'all-screens.png'));
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
