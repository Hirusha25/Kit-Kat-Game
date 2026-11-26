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
    detected() { tone({ freq: 740, type: 'sine', dur: 0.1, gain: 0.25 }); tone({ freq: 988, type: 'sine', dur: 0.14, gain: 0.25, when: 0.08 }); }
  };
})();
