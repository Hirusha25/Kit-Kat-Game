// Service worker: makes the kiosk installable from Chrome's "Install app" / "Add to Home screen"
// and keeps it running offline. Pages are network-first (so updates land), assets are cache-first.
const VERSION = 'kk-v1';
const CORE = ['./', './index.html', './register.html', './game.html', './manifest.json',
  './css/style.css', './js/stage.js', './js/ambient.js', './js/keyboard.js', './js/audio.js',
  './js/tracker.js', './js/tracker-worker.js', './js/sprites.js', './js/game.js', './js/flow.js',
  './assets/img/game/manifest.json'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url); if (url.origin !== location.origin) return; // fonts etc. go straight to the network
  const isPage = req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/');
  if (isPage) {
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return r; }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
  } else {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return r; })));
  }
});
