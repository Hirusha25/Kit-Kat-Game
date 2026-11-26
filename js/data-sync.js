/*
 * Data sync: sends registrations, scores and prize codes saved on this kiosk to the server (api/sync/).
 *
 * The game keeps working exactly as before: everything is still written to the kiosk's own storage
 * first (kk_players, kk_leaderboard, kk_stock). This script only copies what has not been sent yet,
 * whenever the kiosk is online, and remembers what the server confirmed. Sending twice is harmless.
 * It needs the kiosk key (the same one as the debug recorder: open game.html?debugkey=<key> once).
 * Loaded on the cover page and the game page; it never blocks or changes the game.
 */
(function () {
  'use strict';
  var API = 'api/sync/', SENT = 'kk_synced', busy = false;
  function read(k, fallback) { try { return JSON.parse(localStorage.getItem(k) || 'null') || fallback; } catch (e) { return fallback; } }
  function key() { try { return localStorage.getItem('kk_debug_key') || ''; } catch (e) { return ''; } }

  function pending() {
    var sent = read(SENT, {}), out = { players: [], scores: [], prizes: [] };
    read('kk_players', []).forEach(function (p) {
      var id = 'p-' + (p.code || '') + '-' + (p.createdAt || '');
      if (!sent[id]) out.players.push({ id: id, name: p.name, dob: p.dob, mobile: p.mobile, email: p.email, code: p.code, verified: !!p.verified, uid: p.uid, createdAt: p.createdAt });
    });
    (read('kk_leaderboard', {}).rows || []).forEach(function (r) {
      var id = 's-' + r.ts + '-' + (r.code || '');
      if (!sent[id]) out.scores.push({ id: id, name: r.name, code: r.code, score: r.score, caught: r.caught, streak: r.streak, ts: r.ts });
    });
    // The game clears its prize list when the day changes, so prizes are copied into a log of our own
    // first. A kiosk that was offline over midnight still sends yesterday's prize codes.
    var log = read('kk_prize_log', {}), grew = false;
    (read('kk_stock', {}).awarded || []).forEach(function (a) { if (a && a.code && !log[a.code]) { log[a.code] = a; grew = true; } });
    Object.keys(log).forEach(function (c) { if (sent['z-' + c] && Date.now() - sent['z-' + c] > 7 * 86400000) { delete log[c]; grew = true; } });
    if (grew) { try { localStorage.setItem('kk_prize_log', JSON.stringify(log)); } catch (e) { /* ignore */ } }
    Object.keys(log).forEach(function (c) {
      var a = log[c], id = 'z-' + a.code;
      if (!sent[id]) out.prizes.push({ id: id, kind: a.kind, code: a.code, name: a.name, mobile: a.mobile, score: a.score, ts: a.ts });
    });
    return out;
  }

  async function sync() {
    var p = pending();   // always runs: it also copies today's prize codes into the log, online or not
    if (busy || !key() || !navigator.onLine) return;
    if (!p.players.length && !p.scores.length && !p.prizes.length) { state.waiting = 0; return; }
    busy = true;
    try {
      // small batches keep each request short on a weak venue connection
      var body = { players: p.players.slice(0, 100), scores: p.scores.slice(0, 200), prizes: p.prizes.slice(0, 100) };
      var res = await fetch(API + '?a=push', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-KK-Key': key() }, body: JSON.stringify(body) });
      var j = await res.json();
      if (j && j.ok) {
        var sent = read(SENT, {}), now = Date.now();
        ['players', 'scores', 'prizes'].forEach(function (k) { (j.saved[k] || []).forEach(function (id) { sent[id] = now; }); });
        // forget confirmations older than 60 days so the list cannot grow for ever
        Object.keys(sent).forEach(function (id) { if (now - sent[id] > 60 * 86400000) delete sent[id]; });
        localStorage.setItem(SENT, JSON.stringify(sent));
        state.last = new Date().toISOString();
      } else state.error = (j && j.error) || ('http ' + res.status);
    } catch (e) { state.error = 'offline'; }
    busy = false;
    var left = pending(); state.waiting = left.players.length + left.scores.length + left.prizes.length;
    if (state.waiting && !state.error) setTimeout(sync, 500);   // more than one batch
  }
  var state = { waiting: 0, last: '', error: '', sync: sync, pending: pending };
  window.KKDataSync = state;

  window.addEventListener('load', function () { setTimeout(sync, 2500); });
  window.addEventListener('online', sync);
  // prize codes are kept per day on the kiosk, so they are sent soon after each round, not only on the cover
  setInterval(function () { state.error = ''; sync(); }, 60000);
})();
