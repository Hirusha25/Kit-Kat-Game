// Service worker: makes the kiosk installable from Chrome's "Install app" / "Add to Home screen"
// and keeps it running offline.
//
// Caching rules (no version bump is needed when files change):
//  - Pages and code (.html, .js, .css, .json): network-first. Online, the kiosk always gets the newest
//    push; the cached copy is used only when the network fails or takes longer than NET_TIMEOUT_MS.
//  - Media (images, video, fonts): served from cache at once and refreshed in the background, so a
//    replaced image shows on the next load without slowing this one.
// VERSION only needs to change if this file's caching rules change and old entries must be dropped.
const VERSION = 'kk-v4';
const NET_TIMEOUT_MS = 4000;
const CORE = ['./', './index.html', './register.html', './game.html', './manifest.json',
  './css/style.css', './js/stage.js', './js/ambient.js', './js/keyboard.js', './js/audio.js',
  './js/tracker.js', './js/tracker-worker.js', './js/sprites.js', './js/game.js', './js/flow.js',
  './assets/img/game/manifest.json',
  // Gameplay artwork: fetched while the player is still on the cover/register, so the game never has to wait for it.
  './assets/img/game/mug.png', './assets/img/game/mug-splash.png', './assets/img/game/wafer.png', './assets/img/game/wafer-gold.png',
  './assets/img/game/wafer-piece.png', './assets/img/game/splash-drop.png', './assets/img/game/sparkle.png', './assets/img/game/alarm.png',
  './assets/img/game/deadline.png', './assets/img/game/phone.png', './assets/img/game/orders.png', './assets/img/game/traffic.png',
  './assets/img/game/header-dunk.png', './assets/img/game/prize-cap.png', './assets/img/game/prize-tee.png', './assets/img/game/wave-pre.webp'];

self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });

// Stores a full (200) response under the URL without its ?v= query, so each file has exactly one entry
// and a new version replaces the old one. Partial (206, video ranges) and error responses are never stored.
function store(req, res) {
  if (!res || res.status !== 200 || res.type === 'opaque') return;
  const url = new URL(req.url); url.search = '';
  const copy = res.clone();
  caches.open(VERSION).then(c => c.put(url.href, copy)).catch(() => {});
}
function cached(req) { return caches.match(req, { ignoreSearch: true }); }

function networkFirst(req, isPage) {
  // Code is revalidated with the server on every load ('no-cache' = conditional request, cheap 304s).
  const net = (isPage ? fetch(req) : fetch(req, { cache: 'no-cache' })).then(res => { store(req, res); return res; });
  const timeout = new Promise(resolve => setTimeout(resolve, NET_TIMEOUT_MS, null));
  return Promise.race([net.catch(() => null), timeout])
    .then(res => res || cached(req).then(hit => hit || net)) // slow or offline: cached copy, else keep waiting
    .catch(() => isPage ? caches.match('./index.html') : Response.error())
    .then(res => res || Response.error());
}

function staleWhileRevalidate(e, req) {
  return cached(req).then(hit => {
    const refresh = fetch(req).then(res => { store(req, res); return res; });
    if (hit) { e.waitUntil(refresh.catch(() => {})); return hit; }
    return refresh;
  });
}

// Video is requested in byte ranges. A stored full copy (see js/offline-sync.js) is cut to the range asked
// for, so background videos also play with no connection. Not stored yet: the network answers.
function rangeFromCache(req) {
  return cached(req).then(hit => {
    if (!hit) return null;
    return hit.blob().then(blob => {
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || ''); if (!m) return null;
      const size = blob.size; let start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
      let end = m[1] !== '' && m[2] !== '' ? Math.min(size - 1, Number(m[2])) : size - 1;
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
      return new Response(blob.slice(start, end + 1), { status: 206, headers: {
        'Content-Type': hit.headers.get('Content-Type') || 'application/octet-stream', 'Accept-Ranges': 'bytes',
        'Content-Range': 'bytes ' + start + '-' + end + '/' + size, 'Content-Length': String(end - start + 1) } });
    });
  }).catch(() => null);
}

// Google Fonts stylesheets and font files: stored copy first, refreshed in the background.
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
function fontFromCache(e, req) {
  return caches.open(VERSION).then(c => c.match(req).then(hit => {
    const refresh = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()).catch(() => {}); return res; });
    if (hit) { e.waitUntil(refresh.catch(() => {})); return hit; }
    return refresh;
  }));
}

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (FONT_HOSTS.indexOf(url.hostname) >= 0) { e.respondWith(fontFromCache(e, req)); return; }   // web fonts, kept for offline
  if (url.origin !== location.origin) return; // anything else from another site goes straight to the network
  if (req.headers.has('range')) { e.respondWith(rangeFromCache(req).then(r => r || fetch(req))); return; }   // video: from the stored copy when there is one
  const isPage = req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/');
  const isCode = /\.(js|css|json)$/.test(url.pathname);
  if (isPage || isCode) e.respondWith(networkFirst(req, isPage));
  else e.respondWith(staleWhileRevalidate(e, req));
});
