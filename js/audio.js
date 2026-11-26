// Tiny WebAudio synth for game feedback. No audio files needed; everything is generated.
// Unlocked on the first user gesture (kiosk Chrome requires it).
(function () {
  let ctx = null, master = null, muted = false;
  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    ctx = new AC(); master = ctx.createGain(); master.gain.value = 0.6; master.connect(ctx.destination);
    return ctx;
  }
  function unlock() { const c = ensure(); if (c && c.state === 'suspended') c.resume(); }
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, unlock, { once: true, passive: true }));

  function tone({ freq = 440, type = 'sine', dur = 0.12, gain = 0.5, slide = 0, attack = 0.005, release = 0.08, when = 0 }) {
    const c = ensure(); if (!c || muted) return;
    const t0 = c.currentTime + when;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + attack);
    g.gain.setValueAtTime(gain, t0 + Math.max(attack, dur - release)); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.02);
  }
  function noise({ dur = 0.15, gain = 0.25, when = 0, lowpass = 1200 }) {
    const c = ensure(); if (!c || muted) return;
    const t0 = c.currentTime + when;
    const len = Math.floor(c.sampleRate * dur), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = buf; f.type = 'lowpass'; f.frequency.value = lowpass; g.gain.value = gain;
    s.connect(f); f.connect(g); g.connect(master); s.start(t0);
  }

  window.KKAudio = {
    unlock,
    setMuted(m) { muted = !!m; },
    catch() { tone({ freq: 880, type: 'triangle', dur: 0.09, gain: 0.35 }); tone({ freq: 1320, type: 'triangle', dur: 0.12, gain: 0.3, when: 0.06 }); noise({ dur: 0.12, gain: 0.12, lowpass: 900 }); },
    streak() { [660, 880, 1100, 1320].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.14, gain: 0.35, when: i * 0.07 })); },
    hit() { tone({ freq: 180, type: 'sawtooth', dur: 0.25, gain: 0.35, slide: -120 }); noise({ dur: 0.2, gain: 0.2, lowpass: 600 }); },
    miss() { tone({ freq: 300, type: 'sine', dur: 0.12, gain: 0.15, slide: -80 }); },
    tick() { tone({ freq: 1000, type: 'square', dur: 0.06, gain: 0.18 }); },
    go() { tone({ freq: 1200, type: 'square', dur: 0.25, gain: 0.3 }); tone({ freq: 1600, type: 'square', dur: 0.3, gain: 0.25, when: 0.1 }); },
    end() { [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.35, gain: 0.35, when: i * 0.12 })); },
    gold() { [880, 1175, 1480, 1760].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.16, gain: 0.32, when: i * 0.06 })); noise({ dur: 0.1, gain: 0.08, lowpass: 2500 }); },
    whoosh() { noise({ dur: 0.35, gain: 0.16, lowpass: 1800 }); tone({ freq: 420, type: 'sine', dur: 0.3, gain: 0.08, slide: 380 }); },
    hurry() { [1000, 1000, 1250].forEach((f, i) => tone({ freq: f, type: 'square', dur: 0.08, gain: 0.16, when: i * 0.12 })); },
    detected() { tone({ freq: 740, type: 'sine', dur: 0.1, gain: 0.25 }); tone({ freq: 988, type: 'sine', dur: 0.14, gain: 0.25, when: 0.08 }); }
  };
})();

// ---------------------------------------------------------------------------------------------
// File-based audio on top of the synth: music loops per screen with crossfade and ducking,
// effect files with variations, separate music/effects volumes. Any file missing from
// assets/audio/ silently falls back to the synthesised tone, so nothing breaks before the
// files are delivered. Names and triggers: reference/AUDIO-PROMPTS.md
// ---------------------------------------------------------------------------------------------
(function () {
  const A = window.KKAudio; if (!A) return;
  const BASE = 'assets/audio/';
  const SFX = {
    tap: ['sfx-ui-tap.wav'], done: ['sfx-ui-done.wav'], error: ['sfx-ui-error.wav'],
    detected: ['sfx-detect.wav'], tick: ['sfx-count.wav'], go: ['sfx-go.wav'],
    catch: ['sfx-catch.wav', 'sfx-catch-2.wav', 'sfx-catch-3.wav'], gold: ['sfx-gold.wav'], streak: ['sfx-streak.wav'],
    hit: ['sfx-hit.wav'], miss: ['sfx-miss.wav'], whoosh: ['sfx-whoosh.wav'], hurry: ['sfx-hurry.wav'],
    end: ['sfx-timeup.wav'], countup: ['sfx-countup.wav'], prize: ['sfx-prize.wav'], confetti: ['sfx-confetti.wav']
  };
  const MUSIC = { attract: 'music-attract.mp3', register: 'music-register.mp3', play: 'music-play.mp3', playFast: 'music-play-fast.mp3', win: 'music-win.mp3', lose: 'music-lose.mp3', steam: 'amb-steam.wav' };

  let ctx = null, master = null, musicBus = null, sfxBus = null, duck = null;
  const buffers = {}, missing = {};
  const vol = Object.assign({ master: 1, music: 0.55, sfx: 0.9 }, (() => { try { return JSON.parse(localStorage.getItem('kk_volume') || '{}'); } catch (_) { return {}; } })());

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = vol.master; master.connect(ctx.destination);
    duck = ctx.createGain(); duck.gain.value = 1; duck.connect(master);
    musicBus = ctx.createGain(); musicBus.gain.value = vol.music; musicBus.connect(duck);
    sfxBus = ctx.createGain(); sfxBus.gain.value = vol.sfx; sfxBus.connect(master);
    return ctx;
  }
  const unlock = () => { const c = ensure(); if (c && c.state === 'suspended') c.resume(); };
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, unlock, { passive: true }));

  async function load(name) {
    if (buffers[name]) return buffers[name];
    if (missing[name]) return null;
    const c = ensure(); if (!c) return null;
    try {
      const r = await fetch(BASE + name, { cache: 'force-cache' });
      if (!r.ok) { missing[name] = true; return null; }
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('text/html')) { missing[name] = true; return null; } // GitHub Pages 404 page
      const buf = await c.decodeAudioData(await r.arrayBuffer());
      buffers[name] = buf; return buf;
    } catch (_) { missing[name] = true; return null; }
  }
  // Preload everything in the background on first unlock so play is instant.
  let preloaded = false;
  function preload() { if (preloaded) return; preloaded = true; Object.values(SFX).flat().concat(Object.values(MUSIC)).forEach(n => load(n)); }
  // Pages that load heavy artwork first (game.html) mark the script data-preload="manual" and call KKAudio.preload() themselves.
  const manual = !!(document.currentScript && document.currentScript.dataset.preload === 'manual');
  if (!manual) { document.addEventListener('pointerdown', preload, { once: true, passive: true }); setTimeout(preload, 1500); }

  // ---- effects: file if present, else the synth tone it replaces
  let catchIx = 0, muted = false;
  const synth = {}; Object.keys(SFX).forEach(k => { synth[k] = A[k]; });
  function playSfx(key, { rate = 1, gain = 1 } = {}) {
    if (muted) return;
    const names = SFX[key]; let name = names[0];
    if (key === 'catch') { name = names[catchIx % names.length]; catchIx++; }
    const buf = buffers[name] || (names.length > 1 ? buffers[names[0]] : null);
    if (!buf) { if (!buffers[name] && !missing[name]) load(name); synth[key] && synth[key](); return; }
    const c = ensure(); const s = c.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate;
    const g = c.createGain(); g.gain.value = gain; s.connect(g); g.connect(sfxBus); s.start();
  }
  function duckMusic(db = 6, ms = 300) { const c = ensure(); if (!c) return; const t = c.currentTime; duck.gain.cancelScheduledValues(t); duck.gain.setValueAtTime(Math.pow(10, -db / 20), t); duck.gain.linearRampToValueAtTime(1, t + ms / 1000); }

  // Override the public effect calls so existing call sites get files automatically.
  let streak = 0;
  A.catch = () => { streak++; playSfx('catch', { rate: 1 + Math.min(0.25, streak * 0.02) }); duckMusic(6, 300); };
  A.gold = () => { playSfx('gold'); duckMusic(6, 400); };
  A.streak = () => { playSfx('streak'); duckMusic(6, 400); };
  A.hit = () => { streak = 0; playSfx('hit'); };
  A.miss = () => { streak = 0; playSfx('miss'); };
  ['tick', 'go', 'detected', 'whoosh', 'hurry', 'end'].forEach(k => { A[k] = () => playSfx(k); });
  A.tap = () => playSfx('tap'); A.done = () => playSfx('done'); A.error = () => playSfx('error');
  A.countup = () => playSfx('countup'); A.prize = () => playSfx('prize'); A.confetti = () => playSfx('confetti');

  // ---- music: one loop at a time, crossfaded; stings play once over the bus
  let current = null; // { name, src, gain }
  function startLoop(name, fadeMs) {
    const c = ensure(); const buf = buffers[name]; if (!c || !buf) return null;
    const src = c.createBufferSource(); src.buffer = buf; src.loop = true;
    const g = c.createGain(); g.gain.value = 0; src.connect(g); g.connect(musicBus); src.start();
    g.gain.linearRampToValueAtTime(1, c.currentTime + fadeMs / 1000);
    return { name, src, gain: g };
  }
  async function music(key, { fade = 600 } = {}) {
    const name = MUSIC[key]; if (!name) return;
    await load(name);
    if (muted || !buffers[name]) { if (!buffers[name]) stopMusic(fade); return; }
    if (current && current.name === name) return;
    const c = ensure(); const old = current; current = startLoop(name, fade);
    if (old) { old.gain.gain.linearRampToValueAtTime(0, c.currentTime + fade / 1000); setTimeout(() => { try { old.src.stop(); } catch (_) {} }, fade + 50); }
  }
  function stopMusic(fade = 400) { if (!current) return; const c = ensure(); const old = current; current = null; old.gain.gain.linearRampToValueAtTime(0, c.currentTime + fade / 1000); setTimeout(() => { try { old.src.stop(); } catch (_) {} }, fade + 50); }
  async function sting(key) { const name = MUSIC[key]; await load(name); if (muted || !buffers[name]) return; const c = ensure(); const s = c.createBufferSource(); s.buffer = buffers[name]; s.connect(musicBus); s.start(); }

  A.music = music; A.stopMusic = stopMusic; A.sting = sting;
  A.setVolumes = v => { Object.assign(vol, v); try { localStorage.setItem('kk_volume', JSON.stringify(vol)); } catch (_) {} if (ctx) { master.gain.value = vol.master; musicBus.gain.value = vol.music; sfxBus.gain.value = vol.sfx; } };
  A.getVolumes = () => Object.assign({}, vol);
  const baseMute = A.setMuted; A.setMuted = m => { muted = !!m; baseMute(m); if (muted) stopMusic(200); };
  A.hasFiles = () => Object.keys(buffers).length > 0;
  A.preload = preload;
})();
