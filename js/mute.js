// Sound button, the same on every page: a round gold-rimmed toggle in the top-right of the stage.
// Mute is remembered across pages (localStorage kk_mute) and the music comes straight back on unmute.
(function () {
  var A = window.KKAudio, stage = document.querySelector('.stage'); if (!A || !stage) return;
  var b = document.createElement('button'); b.type = 'button'; b.className = 'mute-btn'; b.setAttribute('aria-label', 'Sound on / off');
  b.innerHTML =
    '<svg class="i-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.5L13 19V5L7.5 9.5H4z" fill="currentColor"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a7.5 7.5 0 0 1 0 11"/></svg>' +
    '<svg class="i-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.5L13 19V5L7.5 9.5H4z" fill="currentColor"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/></svg>';
  function render() { b.classList.toggle('muted', !!(A.isMuted && A.isMuted())); }
  // swallow the press so page-level tap handlers (keyboard close, "tap to start", start button) never see it
  ['pointerdown', 'touchstart', 'mousedown'].forEach(function (ev) { b.addEventListener(ev, function (e) { e.stopPropagation(); }, { passive: true }); });
  b.addEventListener('click', function (e) {
    e.stopPropagation(); e.preventDefault();
    var m = !(A.isMuted && A.isMuted());
    A.setMuted(m); try { localStorage.setItem('kk_mute', m ? '1' : '0'); } catch (_) {}
    render(); if (!m && A.tap) A.tap();
  });
  stage.appendChild(b); render();
  window.addEventListener('kk:mute', render);
})();
