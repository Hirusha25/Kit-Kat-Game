/*
 * Offline sync: keeps a complete copy of the game on the kiosk so it runs with no connection.
 *
 * The server publishes precache.json ({rev, files}) on every deploy. On the cover page, when the
 * kiosk is online and the published rev differs from the one last downloaded, every listed file is
 * requested once. The requests go through the service worker (sw.js), which stores each file, so the
 * kiosk's copy is replaced by the new version without anyone touching it. Until a download has fully
 * finished, the previous copy stays in use.
 *
 * A small status line (bottom left of the cover) shows the state for staff:
 *   "offline ready · <rev>"   the whole game is stored on this kiosk
 *   "updating 12/85"          a new version is being downloaded
 *   "not stored for offline"  no complete copy yet (needs a connection once)
 */
(function () {
  'use strict';
  var KEY = 'kk_offline_rev', label = null;
  function show(text) {
    if (!label) {
      label = document.createElement('div');
      label.style.cssText = 'position:fixed;left:10px;bottom:6px;z-index:5;font:12px/1 system-ui,Arial,sans-serif;color:#fff;opacity:.45;pointer-events:none';
      document.body.appendChild(label);
    }
    label.textContent = text;
  }
  function get() { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  function set(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* ignore */ } }
  var state = { rev: get(), done: 0, total: 0, running: false };
  window.KKOffline = state;

  function controlled() {
    // Files are only stored when the service worker is in charge of this page.
    if (!('serviceWorker' in navigator)) return Promise.reject(new Error('no service worker'));
    if (navigator.serviceWorker.controller) return Promise.resolve();
    return new Promise(function (resolve) {
      navigator.serviceWorker.addEventListener('controllerchange', function () { resolve(); });
      navigator.serviceWorker.ready.then(function () { if (navigator.serviceWorker.controller) resolve(); });
    });
  }

  async function sync() {
    if (state.running) return;
    state.running = true;
    try {
      await controlled();
      var res = await fetch('precache.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('no list');
      var list = await res.json();
      if (!list || !list.rev || !Array.isArray(list.files)) throw new Error('bad list');
      if (list.rev === state.rev) { show('offline ready · ' + state.rev.slice(0, 7)); state.running = false; return; }
      state.total = list.files.length; state.done = 0;
      var queue = list.files.slice(), failed = 0;
      async function worker() {
        while (queue.length) {
          var url = queue.shift();
          try { var r = await fetch(url, { cache: 'no-cache' }); if (!r.ok) throw new Error(r.status); await r.arrayBuffer(); }
          catch (e) { failed++; }
          state.done++; show('updating ' + state.done + '/' + state.total);
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()]);
      // web fonts come from another site; asking for the stylesheets lets the service worker keep them too
      document.querySelectorAll('link[rel="stylesheet"][href^="https://fonts.googleapis.com"]').forEach(function (l) { fetch(l.href, { mode: 'no-cors' }).catch(function () {}); });
      if (failed) throw new Error(failed + ' file(s) failed');
      state.rev = list.rev; set(list.rev);
      show('offline ready · ' + list.rev.slice(0, 7));
    } catch (e) {
      show(state.rev ? 'offline ready · ' + state.rev.slice(0, 7) + (navigator.onLine ? ' · update pending' : '') : 'not stored for offline');
    }
    state.running = false;
  }

  window.addEventListener('load', function () { setTimeout(sync, 1500); });
  window.addEventListener('online', sync);
  setInterval(function () { if (navigator.onLine) sync(); }, 5 * 60 * 1000);   // an idle kiosk picks up a new version within 5 minutes
})();
