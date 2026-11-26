#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Dunk the Break - procedural audio generator (single-file bundle).

Synthesises every music loop, sting, effect and ambience listed in reference/AUDIO-PROMPTS.md
with Python 3 + numpy only (no samples, no scipy) and encodes the music with ffmpeg.

    python3 tests/audio/generate.py                 # writes assets/audio/* and a report
    python3 tests/audio/generate.py --out DIR --work DIR --only music-play.mp3,sfx-catch.wav
    python3 tests/audio/generate.py --no-check      # skip the two-cycle loop continuity renders

Everything is in D major / B minor. Loops are rendered as exact bar multiples; note and reverb
tails that spill past the loop end are folded back into the head (cosine fade), and the master
dynamics run over three copies of the loop so the seam state is identical on both sides.
Sections: synth toolkit, drums/instruments, music, effects, orchestration.
"""

# ==========================================================================================
# synth.py
# ==========================================================================================
"""
Small numpy-only synth toolkit for the Dunk the Break audio set.
Oscillators (polyBLEP saw/square, sine, triangle), noise, envelopes, hand-rolled biquads
(applied through their closed-form impulse response + FFT convolution for static settings,
direct-form II transposed loop for swept cutoffs), one-pole filters, Schroeder reverb,
feedback echo, soft clip, panning / Haas widening, compressor, lookahead limiter.
"""
import math
import numpy as np

SR = 44100
TWO_PI = 2.0 * math.pi
RNG = np.random.default_rng(20261126)


def reseed(seed=20261126):
    """Reseed the shared generator in place (every module holds a reference to the same object)."""
    RNG.bit_generator.state = np.random.default_rng(seed).bit_generator.state


# ------------------------------------------------------------------ basics
def db2a(d):
    return 10.0 ** (d / 20.0)


def a2db(a):
    return 20.0 * math.log10(max(float(a), 1e-12))


def mtof(m):
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


def ns(t):
    return int(round(t * SR))


def tax(n):
    return np.arange(n) / SR


def _farr(freq, n):
    f = np.asarray(freq, dtype=float)
    if f.ndim == 0:
        return np.full(n, float(f))
    if len(f) >= n:
        return f[:n]
    return np.pad(f, (0, n - len(f)), mode='edge')


# ------------------------------------------------------------------ oscillators
def phase(freq, n, ph0=0.0):
    return np.cumsum(_farr(freq, n)) / SR + ph0


def sine(freq, n, ph0=0.0):
    return np.sin(TWO_PI * phase(freq, n, ph0))


def triangle(freq, n, ph0=0.0):
    p = phase(freq, n, ph0) % 1.0
    return 4.0 * np.abs(p - 0.5) - 1.0


def saw(freq, n, ph0=0.0):
    """Band-limited sawtooth (polyBLEP), rising ramp, -1..1."""
    f = _farr(freq, n)
    dt = f / SR
    p = (np.cumsum(dt) + ph0) % 1.0
    y = 2.0 * p - 1.0
    m = p < dt
    if m.any():
        t = p[m] / dt[m]
        y[m] -= (t + t - t * t - 1.0)
    m = p > 1.0 - dt
    if m.any():
        t = (p[m] - 1.0) / dt[m]
        y[m] -= (t * t + t + t + 1.0)
    return y


def square(freq, n, ph0=0.0, pw=0.5):
    """Band-limited pulse as the difference of two polyBLEP saws."""
    return saw(freq, n, ph0) - saw(freq, n, ph0 + pw)


def white(n):
    return RNG.standard_normal(n)


def pink(n):
    """1/f noise by spectral shaping, unit RMS."""
    w = white(n)
    X = np.fft.rfft(w)
    f = np.fft.rfftfreq(n, 1.0 / SR)
    f = np.maximum(f, 20.0)
    X *= (20.0 / f) ** 0.5
    y = np.fft.irfft(X, n)
    return y / (np.sqrt(np.mean(y * y)) + 1e-12)


def periodic_noise(n, color=0.0):
    """Noise whose period is exactly n samples (random-phase spectrum). color 0 = white, 1 = pink."""
    f = np.fft.rfftfreq(n, 1.0 / SR)
    mag = (20.0 / np.maximum(f, 20.0)) ** (0.5 * color)
    ph = RNG.uniform(0, TWO_PI, len(f))
    X = mag * np.exp(1j * ph)
    X[0] = 0.0
    y = np.fft.irfft(X, n)
    return y / (np.sqrt(np.mean(y * y)) + 1e-12)


# ------------------------------------------------------------------ envelopes
def adsr(n, a=0.005, d=0.2, s=0.5, r=0.1, gate=None):
    t = tax(n)
    gate = n / SR if gate is None else gate
    a = max(a, 1e-4); d = max(d, 1e-4); r = max(r, 1e-4)
    env = np.where(t < a, t / a, s + (1.0 - s) * np.exp(-(t - a) / d))
    rel = t >= gate
    if rel.any():
        v = (gate / a) if gate < a else s + (1.0 - s) * math.exp(-(gate - a) / d)
        env[rel] = v * np.exp(-(t[rel] - gate) / r)
    return env


def expdecay(n, tau):
    return np.exp(-tax(n) / tau)


def fade_out(x, ms=10.0):
    n = min(len(x), ns(ms / 1000.0))
    if n < 2:
        return x
    w = np.linspace(1.0, 0.0, n)
    y = x.copy()
    if y.ndim == 1:
        y[-n:] *= w
    else:
        y[-n:] *= w[:, None]
    return y


def fade_in(x, ms=10.0):
    n = min(len(x), ns(ms / 1000.0))
    if n < 2:
        return x
    w = np.linspace(0.0, 1.0, n)
    y = x.copy()
    if y.ndim == 1:
        y[:n] *= w
    else:
        y[:n] *= w[:, None]
    return y


# ------------------------------------------------------------------ filters (biquad by hand)
def biquad_coefs(kind, f0, Q=0.7071, gain_db=0.0):
    """RBJ cookbook biquad, normalised so a0 = 1. Returns b0,b1,b2,a1,a2."""
    f0 = min(max(float(f0), 10.0), SR * 0.45)
    w0 = TWO_PI * f0 / SR
    c = math.cos(w0); s = math.sin(w0)
    al = s / (2.0 * max(Q, 0.05))
    if kind == 'lp':
        b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al
    elif kind == 'hp':
        b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al
    elif kind == 'bp':  # constant 0 dB peak gain
        b0 = al; b1 = 0.0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al
    elif kind == 'notch':
        b0 = 1.0; b1 = -2 * c; b2 = 1.0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al
    elif kind == 'peak':
        A = 10.0 ** (gain_db / 40.0)
        b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A
    elif kind == 'lowshelf':
        A = 10.0 ** (gain_db / 40.0); sa = 2 * math.sqrt(A) * al
        b0 = A * ((A + 1) - (A - 1) * c + sa); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - sa)
        a0 = (A + 1) + (A - 1) * c + sa; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - sa
    elif kind == 'highshelf':
        A = 10.0 ** (gain_db / 40.0); sa = 2 * math.sqrt(A) * al
        b0 = A * ((A + 1) + (A - 1) * c + sa); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - sa)
        a0 = (A + 1) - (A - 1) * c + sa; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - sa
    else:
        raise ValueError(kind)
    return b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0


def biquad_ir(coefs, nmax):
    """Impulse response of a biquad in closed form (poles), truncated where it has decayed to -160 dB."""
    b0, b1, b2, a1, a2 = coefs
    disc = a1 * a1 - 4.0 * a2
    sq = np.sqrt(complex(disc))
    p1 = (-a1 + sq) / 2.0
    p2 = (-a1 - sq) / 2.0
    pm = max(abs(p1), abs(p2))
    if pm >= 0.999999:
        n = nmax
    else:
        n = int(min(nmax, max(16, math.log(1e-8) / math.log(pm) + 4)))
    h = np.zeros(max(n, 3))
    h1 = b1 - a1 * b0
    h2 = b2 - a1 * h1 - a2 * b0
    h[0] = b0
    det = p1 * p2 * p2 - p2 * p1 * p1
    if abs(det) < 1e-14:  # repeated / degenerate poles: direct recursion
        h[1] = h1; h[2] = h2
        for i in range(3, n):
            h[i] = -a1 * h[i - 1] - a2 * h[i - 2]
        return h[:n]
    A = (h1 * p2 * p2 - p2 * h2) / det
    B = (p1 * h2 - p1 * p1 * h1) / det
    m = np.arange(1, n)
    h[1:n] = (A * p1 ** m + B * p2 ** m).real
    return h[:n]


def fftconv(x, h):
    """Linear convolution truncated to len(x). x is 1-D or (N, C); h is 1-D."""
    N = len(x)
    L = N + len(h) - 1
    nfft = 1 << (L - 1).bit_length()
    H = np.fft.rfft(h, nfft)
    if x.ndim == 1:
        return np.fft.irfft(np.fft.rfft(x, nfft) * H, nfft)[:N]
    return np.stack([np.fft.irfft(np.fft.rfft(x[:, c], nfft) * H, nfft)[:N] for c in range(x.shape[1])], axis=1)


def biquad(x, kind, f0, Q=0.7071, gain_db=0.0):
    """Static biquad applied via its (exact, truncated) impulse response."""
    return fftconv(x, biquad_ir(biquad_coefs(kind, f0, Q, gain_db), len(x)))


def circ_biquad(x, kind, f0, Q=0.7071, gain_db=0.0):
    """Same filter applied circularly (period = len(x)); keeps a periodic signal exactly periodic."""
    n = len(x)
    h = biquad_ir(biquad_coefs(kind, f0, Q, gain_db), n)
    H = np.fft.rfft(h, n)
    if x.ndim == 1:
        return np.fft.irfft(np.fft.rfft(x) * H, n)
    return np.stack([np.fft.irfft(np.fft.rfft(x[:, c]) * H, n) for c in range(x.shape[1])], axis=1)


def biquad_sweep(x, kind, f0, Q=1.0, block=16):
    """Time-varying biquad: direct-form, coefficients refreshed every `block` samples."""
    n = len(x)
    f = _farr(f0, n)
    xl = x.tolist()
    out = [0.0] * n
    x1 = x2 = y1 = y2 = 0.0
    for s in range(0, n, block):
        b0, b1, b2, a1, a2 = biquad_coefs(kind, f[s], Q)
        for i in range(s, min(s + block, n)):
            xi = xl[i]
            yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            x2 = x1; x1 = xi; y2 = y1; y1 = yi
            out[i] = yi
    return np.asarray(out)


def onepole_lp(x, fc):
    r = math.exp(-TWO_PI * min(max(fc, 5.0), SR * 0.49) / SR)
    a = 1.0 - r
    n = int(min(len(x), max(8, math.log(1e-8) / math.log(r)))) if r > 1e-9 else 1
    h = a * r ** np.arange(n)
    return fftconv(x, h)


def onepole_hp(x, fc):
    return x - onepole_lp(x, fc)


def softclip(x, drive=1.0):
    return np.tanh(drive * x) / drive


# ------------------------------------------------------------------ delays / reverb
def _comb(x, D, g):
    y = x.copy()
    n = len(x)
    for s in range(D, n, D):
        e = min(s + D, n)
        y[s:e] += g * y[s - D:e - D]
    return y


def _allpass(x, D, g):
    n = len(x)
    y = -g * x
    y[D:] += x[:-D]
    for s in range(D, n, D):
        e = min(s + D, n)
        y[s:e] += g * y[s - D:e - D]
    return y


def reverb(x, rt60=1.2, mix=0.25, predelay=0.012, damp=5000.0, size=1.0):
    """Schroeder reverb (4 parallel combs -> 2 series allpasses), slightly different L/R delays.
    Returns stereo dry+wet. mix is the wet gain relative to dry."""
    if x.ndim == 1:
        x = np.stack([x, x], axis=1)
    n = len(x)
    wet = np.empty_like(x)
    base = [0.0297, 0.0371, 0.0411, 0.0437]
    pd = ns(predelay)
    for c in range(2):
        xin = onepole_lp(x[:, c], damp)
        if pd > 0:
            xin = np.concatenate([np.zeros(pd), xin[:n - pd]])
        acc = np.zeros(n)
        gs = []
        for d in base:
            D = max(8, ns(d * size * (1.0 + 0.027 * c)))
            g = 10.0 ** (-3.0 * D / SR / rt60)
            gs.append(g)
            acc += _comb(xin, D, g)
        acc *= 0.25 * (1.0 - float(np.mean(gs))) * 2.2
        acc = _allpass(acc, max(4, ns(0.0050 * size * (1 + 0.04 * c))), 0.7)
        acc = _allpass(acc, max(4, ns(0.0017 * size * (1 + 0.04 * c))), 0.7)
        wet[:, c] = acc
    return x + mix * wet


def echo(x, time_s, fb=0.35, mix=0.3, damp=4000.0, pingpong=True):
    """Feedback echo; stereo in/out. Pingpong offsets the right channel by half a repeat."""
    if x.ndim == 1:
        x = np.stack([x, x], axis=1)
    n = len(x)
    D = max(1, ns(time_s))
    mono = onepole_lp(0.5 * (x[:, 0] + x[:, 1]), damp)
    w = _comb(mono, D, fb) - mono            # echoes only, starting at D
    out = x.copy()
    out[:, 0] += mix * w
    if pingpong:
        off = D // 2
        out[off:, 1] += mix * w[:n - off]
    else:
        out[:, 1] += mix * w
    return out


# ------------------------------------------------------------------ stereo
def pan(x, p=0.0):
    """Equal-power pan of a mono signal, p in -1..1."""
    th = (p + 1.0) * math.pi / 4.0
    return np.stack([x * math.cos(th), x * math.sin(th)], axis=1)


def widen(x, ms=12.0, amt=0.5):
    """Haas widening of a mono signal."""
    d = ns(ms / 1000.0)
    n = len(x)
    L = x.copy()
    R = x * (1.0 - amt)
    R[d:] += amt * x[:n - d]
    return np.stack([L, R], axis=1)


def stereo(x):
    return x if x.ndim == 2 else np.stack([x, x], axis=1)


# ------------------------------------------------------------------ dynamics
def compressor(x, thresh_db=-18.0, ratio=3.0, attack=0.01, release=0.2, hop=128, makeup_db=0.0):
    x = stereo(x)
    n = len(x)
    nb = (n + hop - 1) // hop
    xp = np.pad(x, ((0, nb * hop - n), (0, 0)))
    lvl = np.sqrt((xp.reshape(nb, hop, 2) ** 2).mean(axis=(1, 2))) + 1e-9
    lvl_db = 20.0 * np.log10(lvl)
    ca = math.exp(-hop / (attack * SR)); cr = math.exp(-hop / (release * SR))
    env = np.empty(nb)
    e = lvl_db[0]
    ll = lvl_db.tolist()
    for i in range(nb):
        l = ll[i]
        e = l + (e - l) * (ca if l > e else cr)
        env[i] = e
    gr = -np.maximum(0.0, env - thresh_db) * (1.0 - 1.0 / ratio)
    gain = db2a(gr + makeup_db)
    g = np.interp(np.arange(n), (np.arange(nb) + 0.5) * hop, gain)
    return x * g[:, None]


def limiter(x, ceiling_db=-1.0, release=0.08, hop=64):
    x = stereo(x)
    c = db2a(ceiling_db)
    n = len(x)
    nb = (n + hop - 1) // hop
    xp = np.pad(x, ((0, nb * hop - n), (0, 0)))
    peaks = np.abs(xp.reshape(nb, hop, 2)).max(axis=(1, 2)) + 1e-9
    need = np.minimum(1.0, c / peaks)
    need_la = np.minimum(need, np.concatenate([need[1:], need[-1:]]))  # one block of lookahead
    cr = 1.0 - math.exp(-hop / (release * SR))
    g = np.empty(nb + 1)
    gv = 1.0
    nl = need_la.tolist()
    for i in range(nb):
        gv = gv + (1.0 - gv) * cr
        gv = min(nl[i], gv)
        g[i] = gv
    g[nb] = gv
    gi = np.interp(np.arange(n), np.arange(nb + 1) * hop, g)
    y = x * gi[:, None]
    return np.clip(y, -c, c)


def rms(x):
    return float(np.sqrt(np.mean(np.asarray(x) ** 2)) + 1e-12)


def peak(x):
    return float(np.max(np.abs(x)) + 1e-12)


def normalize_rms(x, target_db):
    return x * (db2a(target_db) / rms(x))


def normalize_peak(x, target_db):
    return x * (db2a(target_db) / peak(x))


def master_music(x, loop=False, rms_db=-16.0, ceiling_db=-1.0):
    """High-pass 30 Hz -> gentle compression -> RMS normalise -> lookahead limiter.
    Loops are processed as [x x x] and the middle copy is kept so the dynamics state is
    identical on both sides of the seam."""
    x = stereo(x)
    L = len(x)
    y = np.concatenate([x, x, x]) if loop else x
    y = biquad(y, 'hp', 30.0, 0.7071)
    y = compressor(y, thresh_db=-20.0, ratio=2.5, attack=0.012, release=0.25)
    y = normalize_rms(y, rms_db)
    y = limiter(y, ceiling_db)
    if loop:
        y = y[L:2 * L]
    return y


def master_sfx(x, peak_db=-3.0, hp=28.0, tail_ms=6.0, trim=True):
    """High-pass, trim any leading silence, fade the last few ms (cosine), normalise peak."""
    x = stereo(x)
    x = biquad(x, 'hp', hp, 0.7071)
    if trim:
        a = np.abs(x).max(axis=1)
        thr = a.max() * db2a(-46.0)
        first = int(np.argmax(a > thr))
        if first > 0:
            x = x[first:]
    n = min(len(x), ns(tail_ms / 1000.0))
    if n > 2:
        w = 0.5 * (1.0 + np.cos(math.pi * np.arange(n) / n))
        x = x.copy()
        x[-n:] *= w[:, None]
    return normalize_peak(x, peak_db)


# ------------------------------------------------------------------ sequencing
class Seq:
    """Bar-based buffer with a tail region. seal() folds the tail (reverb / release) back into
    the head with a cosine fade so the loop is seamless."""

    def __init__(self, bpm, bars, tail=3.0, beats_per_bar=4, cycle_bars=None):
        """cycle_bars: bars per loop cycle. The loop is snapped to an exact integer number of
        samples (tempo error < 1 ppm) so the beat grid is identical on both sides of the seam."""
        self.bpm = bpm
        self.bars = bars
        cycle_bars = cycle_bars or bars
        cycle_len = ns(cycle_bars * beats_per_bar * 60.0 / bpm)
        self.spb = cycle_len / (cycle_bars * beats_per_bar) / SR
        self.length = cycle_len * (bars // cycle_bars)
        self.n = self.length + ns(tail)
        self.buf = np.zeros((self.n, 2))
        self.send = np.zeros((self.n, 2))   # reverb send bus

    def add(self, sig, beat, gain=1.0, pan_=0.0, send=0.0):
        st = ns(beat * self.spb)
        if st >= self.n or st < 0:
            return
        if sig.ndim == 1:
            sig = pan(sig, pan_)
        e = min(self.n, st + len(sig))
        seg = sig[:e - st]
        self.buf[st:e] += gain * seg
        if send > 0:
            self.send[st:e] += gain * send * seg

    def add_bus(self, bus, gain=1.0):
        self.buf[:len(bus)] += gain * bus[:self.n]

    def seal(self, mode='fold'):
        L = self.length
        out = self.buf[:L].copy()
        tail = self.buf[L:]
        T = len(tail)
        if T > 0:
            w = 0.5 * (1.0 + np.cos(math.pi * np.arange(T) / T))
            out[:T] += tail * w[:, None]
        return out


def seam_report(x):
    """Numeric loop-seam check: |x[0]-x[-1]| and the step across the seam vs typical step."""
    x = stereo(x)
    jump = float(np.max(np.abs(x[0] - x[-1])))
    steps = np.abs(np.diff(x, axis=0)).max(axis=1)
    typ = float(np.percentile(steps, 99.9)) + 1e-12
    return jump, jump / typ


# ------------------------------------------------------------------ file IO
def write_wav(path, x):
    import wave
    x = stereo(np.asarray(x))
    pcm = (np.clip(x, -1.0, 1.0) * 32767.0).round().astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def read_wav(path):
    import wave
    with wave.open(path, 'rb') as w:
        ch = w.getnchannels()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').astype(float) / 32768.0
    return data.reshape(-1, ch)

# ==========================================================================================
# instruments.py
# ==========================================================================================
"""Drum kit and instruments built on synth.py. Every voice returns a float array (mono, or
stereo (N,2) for the pad) that includes its natural release tail."""
import math
import numpy as np


# ------------------------------------------------------------------ drums
def kick(vel=1.0, punch=1.0, f_end=48.0, decay=0.42, click=0.6):
    n = ns(decay + 0.12)
    t = tax(n)
    f = f_end + (140.0 * punch) * np.exp(-t / 0.028) + 40 * np.exp(-t / 0.004)
    body = sine(f, n) * np.exp(-t / (decay * 0.45)) * np.minimum(1.0, t / 0.0008 + 0.2)
    cl = onepole_hp(white(n), 1800.0) * np.exp(-t / 0.0035) * click * punch
    x = softclip(1.5 * body + cl, 1.6)
    return fade_out(x * vel, 20)


def kick_soft(vel=1.0):
    return kick(vel, punch=0.55, f_end=55.0, decay=0.33, click=0.25)


def snare(vel=1.0, tone=1.0, snap=1.0, decay=0.17):
    n = ns(decay * 2.5 + 0.05)
    t = tax(n)
    f = 1.0 + 0.35 * np.exp(-t / 0.012)
    body = (sine(188.0 * f, n) * 0.6 + sine(331.0 * f, n) * 0.4) * np.exp(-t / 0.055) * tone
    nz = biquad(white(n), 'bp', 3200.0, 0.5)
    nz = biquad(nz, 'hp', 900.0, 0.7) * np.exp(-t / decay) * snap
    x = softclip(0.9 * body + 0.8 * nz, 1.3)
    return fade_out(x * vel, 15)


def clap(vel=1.0):
    n = ns(0.36)
    t = tax(n)
    nz = biquad(white(n), 'bp', 1700.0, 0.8)
    nz = biquad(nz, 'hp', 700.0, 0.7)
    env = np.zeros(n)
    for k, off in enumerate([0.0, 0.0105, 0.0205, 0.031]):
        m = t >= off
        env[m] += np.exp(-(t[m] - off) / 0.0085) * (0.75 if k < 3 else 1.0)
    m = t >= 0.031
    env[m] += 0.9 * np.exp(-(t[m] - 0.031) / 0.085)
    x = softclip(nz * env * 1.4, 1.2)
    return fade_out(x * vel, 15)


def hat(vel=1.0, open_=False, bright=1.0):
    dec = 0.32 if open_ else 0.048
    n = ns(dec * 3.2 + 0.02)
    t = tax(n)
    nz = biquad(biquad(white(n), 'hp', 6500.0 * bright, 0.7), 'peak', 9800.0, 1.2, 5.0)
    # a little metallic ring: six detuned square partials (808-ish ratios)
    met = sum(square(f, n, RNG.uniform()) for f in (3221.0, 3887.0, 4455.0, 5231.0, 6180.0, 7390.0))
    met = biquad(met, 'hp', 7000.0, 0.7) * 0.08
    env = np.exp(-t / dec) * (1.0 - np.exp(-t / 0.0008))
    x = (nz + met) * env
    return fade_out(x * vel * 0.7, 10)


def shaker(vel=1.0):
    n = ns(0.13)
    t = tax(n)
    nz = biquad(white(n), 'bp', 6200.0, 1.1)
    env = (1.0 - np.exp(-t / 0.009)) * np.exp(-t / 0.032)
    return fade_out(nz * env * vel * 1.3, 8)


def rim(vel=1.0):
    """Side-stick / rimshot."""
    n = ns(0.12)
    t = tax(n)
    x = (sine(540.0, n) * 0.55 + sine(1630.0, n) * 0.3 + sine(2900.0, n) * 0.15) * np.exp(-t / 0.018)
    x += onepole_hp(white(n), 2500.0) * np.exp(-t / 0.0025) * 0.9
    x += biquad(white(n), 'bp', 900.0, 2.0) * np.exp(-t / 0.02) * 0.4
    return fade_out(softclip(x, 1.2) * vel, 8)


def brush(vel=1.0, length=0.3):
    """Brushed-snare swish."""
    n = ns(length + 0.05)
    t = tax(n)
    nz = biquad(white(n), 'bp', 2800.0, 0.7)
    env = (1.0 - np.exp(-t / 0.035)) * np.exp(-t / (length * 0.3))
    return fade_out(nz * env * vel * 0.9, 15)


def crash(vel=1.0, length=1.6):
    n = ns(length + 0.1)
    t = tax(n)
    nz = biquad(white(n), 'hp', 4200.0, 0.6) * np.exp(-t / (length * 0.33))
    shimmer = sum(sine(f, n, RNG.uniform()) * np.exp(-t / (length * 0.4 * r)) for f, r in
                  ((3135.0, 1.0), (4698.0, 0.9), (6271.0, 0.8), (7902.0, 0.7), (9956.0, 0.6)))
    x = nz * 0.9 + 0.04 * shimmer
    x = x * (1.0 - np.exp(-t / 0.002))
    return fade_out(softclip(x, 1.2) * vel * 0.8, 40)


def timpani(midi=38, vel=1.0, length=1.8):
    f0 = mtof(midi)
    n = ns(length + 0.1)
    t = tax(n)
    f = f0 * (1.0 + 0.10 * np.exp(-t / 0.04))
    x = sine(f, n) * np.exp(-t / (length * 0.33)) + 0.4 * sine(f * 1.5, n) * np.exp(-t / (length * 0.2)) + \
        0.25 * sine(f * 1.98, n) * np.exp(-t / (length * 0.12))
    thump = onepole_lp(white(n), 250.0) * np.exp(-t / 0.018) * 2.5
    x = softclip(x * 1.2 + thump, 1.4)
    return fade_out(x * vel, 40)


def tom(freq=180.0, vel=1.0):
    n = ns(0.45)
    t = tax(n)
    f = freq * (1.0 + 0.25 * np.exp(-t / 0.03))
    x = sine(f, n) * np.exp(-t / 0.13) + onepole_lp(white(n), 1200.0) * np.exp(-t / 0.01) * 0.6
    return fade_out(softclip(x * 1.3, 1.3) * vel, 15)


def vinyl(n, density=9.0, hiss_db=-48.0):
    """Sparse crackle plus faint pink hiss, stereo."""
    out = np.zeros((n, 2))
    k = int(density * n / SR)
    for c in range(2):
        imp = np.zeros(n)
        pos = RNG.integers(0, n - 4, k)
        amp = RNG.uniform(0.2, 1.0, k) ** 3 * RNG.choice([-1, 1], k)
        imp[pos] += amp
        imp[pos + 1] += -0.6 * amp
        imp[pos + 2] += 0.2 * amp
        out[:, c] = biquad(imp, 'lp', 5500.0, 0.7) * 0.6 + periodic_noise(n, 1.0) * db2a(hiss_db) * 4
    return out


# ------------------------------------------------------------------ instruments
_CACHE = {}


def cached(name, fn, freq, dur, vel, *extra):
    key = (name, round(freq, 2), round(dur, 3), round(vel * 8) / 8, extra)
    if key not in _CACHE:
        _CACHE[key] = fn(freq, dur, round(vel * 8) / 8, *extra)
    return _CACHE[key]


def ep(freq, dur, vel=0.8):
    """Two-operator FM electric piano (modulator ratio 1, decaying index, plus a tine click op)."""
    n = ns(dur + 0.7)
    t = tax(n)
    tau = 1.6 * (220.0 / freq) ** 0.4
    idx = (0.9 + 2.0 * vel) * np.exp(-t / 0.33) + 0.12
    mod = np.sin(TWO_PI * freq * t) * idx
    tine = np.sin(TWO_PI * freq * 14.0 * t) * 0.17 * vel * np.exp(-t / 0.05)
    car = np.sin(TWO_PI * freq * t + mod + tine)
    car2 = 0.18 * np.sin(TWO_PI * freq * 2.0 * t + 0.5 * mod) * np.exp(-t / (tau * 0.5))
    env = np.exp(-t / tau) * np.minimum(1.0, t / 0.0025)
    rel = t >= dur
    env[rel] *= np.exp(-(t[rel] - dur) / 0.14)
    trem = 1.0 + 0.06 * np.sin(TWO_PI * 4.6 * t)
    x = (car + car2) * env * trem
    x = onepole_lp(x, 7500.0)
    level = (0.55 + 0.45 * vel) * min(1.0, (440.0 / freq) ** 0.25)
    return fade_out(x * level, 10)


def marimba(freq, dur, vel=0.8):
    tau = 0.30 * (440.0 / freq) ** 0.5
    n = ns(min(1.4, tau * 4.5) + 0.05)
    t = tax(n)
    x = np.sin(TWO_PI * freq * t) * np.exp(-t / tau)
    x += 0.38 * np.sin(TWO_PI * freq * 3.98 * t) * np.exp(-t / (tau * 0.22))
    x += 0.10 * np.sin(TWO_PI * freq * 9.9 * t) * np.exp(-t / (tau * 0.08))
    local = np.random.default_rng(int(freq * 100))   # cached voices never touch the shared RNG
    mallet = biquad(local.standard_normal(n), 'bp', 2200.0, 1.0) * np.exp(-t / 0.0022) * 0.45
    x = (x + mallet) * np.minimum(1.0, t / 0.0008 + 0.3)
    return fade_out(x * (0.45 + 0.55 * vel), 10)


def bell(freq, dur, vel=0.9, ratio=3.5, bright=1.0):
    """Glassy FM bell used by the effects."""
    n = ns(dur)
    t = tax(n)
    idx = (1.1 * vel * bright) * np.exp(-t / (dur * 0.28))
    mod = np.sin(TWO_PI * freq * ratio * t) * idx
    x = np.sin(TWO_PI * freq * t + mod) * np.exp(-t / (dur * 0.33))
    x += 0.35 * np.sin(TWO_PI * freq * 2.0 * t) * np.exp(-t / (dur * 0.18))
    x += 0.12 * np.sin(TWO_PI * freq * 4.0 * t) * np.exp(-t / (dur * 0.08))
    x *= np.minimum(1.0, t / 0.0012)
    return fade_out(x * (0.5 + 0.5 * vel), 12)


def pad(freq, dur, vel=0.7, cutoff=1000.0, attack=0.6, release=1.2):
    """Warm pad: detuned polyBLEP saws (different detune per channel) + sub, 12 dB low-pass."""
    n = ns(dur + release * 2.5)
    env = adsr(n, attack, 0.5, 0.85, release, gate=dur)
    def layer(dets, ph):
        return sum(saw(freq * 2.0 ** (d / 1200.0), n, ph + 0.17 * i) for i, d in enumerate(dets))
    L = layer((-9.0, 4.0, 11.0), 0.10) + 0.55 * saw(freq / 2.0, n, 0.31)
    R = layer((-12.0, 6.0, 9.0), 0.63) + 0.55 * saw(freq / 2.0, n, 0.82)
    L = biquad(L, 'lp', cutoff + 400 * vel, 0.9)
    R = biquad(R, 'lp', cutoff + 400 * vel, 0.9)
    out = np.stack([L, R], axis=1) * env[:, None] * 0.22
    out = onepole_hp(out, 50.0)
    return fade_out(out, 20)


def pluck(freq, dur, vel=0.8):
    """Plucky subtractive synth: saw+pulse through a resonant low-pass with a fast cutoff sweep."""
    n = ns(min(dur, 0.45) + 0.25)
    t = tax(n)
    osc = 0.6 * saw(freq, n) + 0.4 * square(freq, n, 0.25, 0.5) + 0.25 * np.sin(TWO_PI * freq * t)
    cutoff = freq * 1.6 + (freq * 9.0 + 1800.0) * (0.45 + 0.55 * vel) * np.exp(-t / 0.075)
    y = biquad_sweep(osc, 'lp', cutoff, 2.6)
    env = np.exp(-t / 0.23) * np.minimum(1.0, t / 0.001)
    rel = t >= dur
    env[rel] *= np.exp(-(t[rel] - dur) / 0.045)
    return fade_out(y * env * (0.55 + 0.45 * vel) * 0.9, 8)


def brass(freq, dur, vel=0.9):
    """Brass stab: detuned saw stack (+sub octave) through a swept resonant low-pass."""
    n = ns(dur + 0.25)
    t = tax(n)
    osc = saw(freq, n, 0.0) + saw(freq * 2 ** (9 / 1200.0), n, 0.33) + saw(freq * 2 ** (-9 / 1200.0), n, 0.71) \
        + 0.6 * saw(freq / 2.0, n, 0.2)
    cutoff = 700.0 + (2600.0 + 2600.0 * vel) * (1.0 - np.exp(-t / 0.035)) * np.exp(-t / 0.4) + 500.0 * np.exp(-t / 0.5)
    y = biquad_sweep(osc, 'lp', cutoff, 1.7)
    env = adsr(n, 0.014, 0.28, 0.6, 0.09, gate=dur)
    y = softclip(y * env * 0.32, 1.4)
    return fade_out(y * (0.6 + 0.4 * vel), 10)


def bass(freq, dur, vel=0.9, bright=0.5, attack=0.004):
    n = ns(dur + 0.16)
    t = tax(n)
    sub = np.sin(TWO_PI * freq * t)
    sw = biquad(saw(freq, n, 0.1), 'lp', 180.0 + 700.0 * bright, 1.1)
    env = adsr(n, attack, 0.35, 0.65, 0.07, gate=dur)
    y = (0.72 * sub + 0.65 * sw) * env
    y = softclip(y * 1.3, 1.3)
    return fade_out(y * (0.7 + 0.3 * vel), 10)


def lead(freq, dur, vel=0.9):
    """Bright pop lead: pulse + saw with light vibrato."""
    n = ns(dur + 0.22)
    t = tax(n)
    vib = 1.0 + 0.0035 * np.sin(TWO_PI * 5.6 * t) * np.minimum(1.0, t / 0.18)
    osc = 0.55 * square(freq * vib, n, 0.0, 0.32) + 0.5 * saw(freq * vib * 1.0025, n, 0.4)
    y = biquad(osc, 'lp', min(9000.0, freq * 7.0), 1.1)
    env = adsr(n, 0.006, 0.35, 0.72, 0.09, gate=dur)
    return fade_out(softclip(y * env * 0.5, 1.2) * (0.6 + 0.4 * vel), 10)


def chip_arp(freq, dur, vel=0.9):
    """Short, bright bell-pluck for arpeggio runs in the stings/effects."""
    n = ns(dur)
    t = tax(n)
    x = np.sin(TWO_PI * freq * t) * np.exp(-t / (dur * 0.35)) + 0.3 * np.sin(TWO_PI * freq * 3.0 * t) * np.exp(-t / (dur * 0.15))
    return fade_out(x * vel * np.minimum(1.0, t / 0.001), 8)

# ==========================================================================================
# music.py
# ==========================================================================================
"""Musical content for Dunk the Break. Everything is in D major (relative B minor) so the
game's 0.6 s crossfades between loops land in the same key."""
import math
import numpy as np



# Chord dictionary: name -> (bass midi, EP/lounge voicing, bright pop voicing, chord tones for arps)
CHORDS = {
    'D':   (38, [62, 66, 69, 73], [62, 66, 69, 74], [50, 54, 57]),   # Dmaj7 / D
    'A':   (45, [61, 64, 67, 71], [61, 64, 69, 73], [45, 49, 52]),   # A9 / A
    'Bm':  (47, [62, 66, 69, 71], [62, 66, 71, 74], [47, 50, 54]),   # Bm7 / Bm
    'G':   (43, [62, 66, 67, 71], [62, 67, 71, 74], [43, 47, 50]),   # Gmaj7 / G
    'F#m': (42, [61, 64, 66, 69], [61, 66, 69, 73], [42, 45, 49]),   # F#m7
    'Em':  (40, [62, 64, 67, 71], [64, 67, 71, 74], [40, 43, 47]),   # Em7
}


def jit(v, amt=0.08):
    return float(np.clip(v * (1.0 + RNG.uniform(-amt, amt)), 0.05, 1.0))


# ------------------------------------------------------------------ ATTRACT  (92 BPM lounge)
ATTRACT_PROG = ['D', 'A', 'Bm', 'G', 'D', 'A', 'Bm', 'G',
                'D', 'F#m', 'G', 'A', 'Bm', 'G', 'Em', 'A',
                'D', 'A', 'Bm', 'G', 'D', 'A', 'G', 'A']

# marimba hook, (beat, duration, midi); 8 bars
MARIMBA_A = [
    (0, 1.5, 78), (1.5, .5, 81), (2, 1, 83), (3, 1, 81),
    (4, 1.5, 76), (5.5, .5, 73), (6, 2, 76),
    (8, 1, 78), (9, 1, 74), (10, 1.5, 71), (11.5, .5, 74),
    (12, 1.5, 78), (13.5, .5, 76), (14, 2, 74),
    (16, 1, 81), (17, .5, 78), (17.5, .5, 81), (18, 1, 83), (19, 1, 85),
    (20, 1.5, 88), (21.5, .5, 85), (22, 2, 83),
    (24, 1, 81), (25, 1, 78), (26, 1.5, 74), (27.5, .5, 76),
    (28, 3, 78),
]
# variation for the last A section: octave colour, altered rhythm, turnaround lick at the end
MARIMBA_A2 = [
    (0, 1, 78), (1, .5, 81), (1.5, .5, 83), (2, 1, 85), (3, 1, 81),
    (4, 1.5, 76), (5.5, .5, 73), (6, 1, 76), (7, 1, 73),
    (8, 1, 78), (9, 1, 74), (10, 1.5, 71), (11.5, .5, 74),
    (12, 1.5, 78), (13.5, .5, 76), (14, 2, 74),
    (16, 1, 81), (17, .5, 78), (17.5, .5, 81), (18, 1, 83), (19, 1, 85),
    (20, 1.5, 88), (21.5, .5, 85), (22, 2, 83),
    (24, 1, 83), (25, 1, 81), (26, 1, 78), (27, 1, 76),
    (28, 1, 78), (29, 1, 76), (30, 1, 74), (31, .5, 73),
]
# sparse answers in the B section (8 bars) over D F#m G A | Bm G Em A
MARIMBA_B = [
    (2, 1, 81), (3, 1, 78),
    (10, .5, 78), (10.5, .5, 81), (11, 1, 83),
    (14, 1.5, 85), (15.5, .5, 83),
    (18, 1, 81), (19, 1, 78),
    (24, .5, 76), (24.5, .5, 78), (25, 1, 79), (26, 1, 78), (27, 1, 76),
    (28, 2, 73), (30, 1, 76), (31, 1, 73),
]


def make_attract(cycles=1):
    bpm, bars = 92, 24
    S = Seq(bpm, bars * cycles, tail=3.5, cycle_bars=bars)
    swing = 0.09  # beats, applied to off-beat 8ths
    for pos in range(bars * cycles):
        bar = pos % bars
        reseed(1000 + bar)
        b0 = pos * 4
        ch = CHORDS[ATTRACT_PROG[bar]]
        nxt = CHORDS[ATTRACT_PROG[(bar + 1) % bars]]
        # --- brushed drums
        S.add(kick_soft(jit(0.9)), b0 + 0, 0.7)
        S.add(kick_soft(jit(0.55)), b0 + 2, 0.7)
        if bar % 2 == 1:
            S.add(kick_soft(jit(0.4)), b0 + 3.5 + swing, 0.65)
        for bt in (1, 3):
            S.add(rim(jit(0.8)), b0 + bt, 0.38, pan_=-0.25, send=0.5)
            S.add(brush(jit(0.7)), b0 + bt, 0.4, pan_=-0.15, send=0.3)
        hv = [1.0, .45, .75, .5, .9, .45, .75, .55]
        for k in range(8):
            bt = b0 + k * 0.5 + (swing if k % 2 else 0.0)
            S.add(hat(jit(hv[k]), open_=(bar % 4 == 3 and k == 7)), bt, 0.26, pan_=0.3)
            if k % 2:
                S.add(shaker(jit(0.8)), bt, 0.2, pan_=-0.45)
        if bar % 8 == 7:  # soft fill into the next phrase
            for i, f in enumerate((220.0, 180.0, 150.0)):
                S.add(tom(f, 0.5 + 0.15 * i), b0 + 3 + i * 0.33, 0.35, pan_=0.2 - 0.2 * i, send=0.4)
        # --- bass: root, 5th, root, leading tone into the next chord
        r = ch[0]
        line = [(0, 1.45, r), (2, 0.95, r + 7), (3, 0.45, r), (3.5 + swing, 0.45, nxt[0] - 1 if bar % 2 else r + 12)]
        for bt, d, m in line:
            S.add(cached('bass', bass, mtof(m), d * S.spb, jit(0.85), 0.35), b0 + bt, 0.42)
        # --- EP comping, alternating patterns, light strum
        pat = [(0, 1.5, .62), (2.5 + swing, 1.0, .5), (3.5 + swing, .5, .42)] if bar % 2 == 0 else [(0, 2.0, .58), (2.5 + swing, 1.4, .5)]
        for bt, d, v in pat:
            for i, m in enumerate(ch[1]):
                S.add(cached('ep', ep, mtof(m), d * S.spb, jit(v)), b0 + bt + i * 0.012 / S.spb, 0.5,
                      pan_=-0.3 + 0.2 * i, send=0.35)
        # --- pad underneath, quiet
        padm = [ch[0] + 12, ch[1][0], ch[1][1]]
        for m in padm:
            S.add(cached('pad', pad, mtof(m), 4.0 * S.spb, 0.5, 850.0), b0, 0.16)
    # --- marimba hook
    for cyc in range(cycles):
        for section, data in ((0, MARIMBA_A), (8, MARIMBA_B), (16, MARIMBA_A2)):
            reseed(2000 + section)
            for bt, d, m in data:
                sw = swing if (bt % 1) == 0.5 else 0.0
                S.add(cached('mar', marimba, mtof(m), d * S.spb, jit(0.85, 0.15)), (cyc * bars + section) * 4 + bt + sw, 0.85,
                      pan_=0.2, send=0.45)
    # --- vinyl warmth (periodic per cycle so the loop closes)
    reseed(3000)
    vin = vinyl(ns(bars * 4 * S.spb), 7.0, -50.0)
    S.add_bus(np.tile(vin, (cycles, 1))[:S.length], 0.5)   # body only: hiss is periodic, so the seam closes
    # reverb return (room) and seal
    S.buf += reverb(S.send, rt60=1.1, mix=1.0, damp=4500.0, size=0.9) - S.send
    S.buf = biquad(S.buf, 'highshelf', 6000.0, 0.7, 2.5)
    if cycles > 1:
        return master_music(S.buf[:S.length], loop=False, rms_db=-16.5), bpm, bars
    return master_music(S.seal(), loop=True, rms_db=-16.5), bpm, bars


# ------------------------------------------------------------------ REGISTER (80 BPM, piano + pad)
REGISTER_PROG = ['D', 'Bm', 'G', 'A', 'D', 'F#m', 'G', 'A', 'Bm', 'G', 'Em', 'A', 'D', 'G', 'Em', 'A']


def make_register(cycles=1):
    bpm, bars = 80, 16
    S = Seq(bpm, bars * cycles, tail=4.0, cycle_bars=bars)
    for pos in range(bars * cycles):
        bar = pos % bars
        reseed(1100 + bar)
        b0 = pos * 4
        ch = CHORDS[REGISTER_PROG[bar]]
        # pad chord (root an octave up + voicing) with slow attack
        for m in [ch[0] + 12] + ch[1][:3]:
            S.add(cached('pad', pad, mtof(m), 4.0 * S.spb, 0.6, 1050.0, 0.9, 1.6), b0, 0.19)
        # EP: low root + fifth on 1, broken chord 8ths rising then falling, soft
        S.add(cached('ep', ep, mtof(ch[0] + 12), 3.5 * S.spb, 0.5), b0, 0.36, pan_=-0.2, send=0.5)
        tones = ch[1] + [ch[1][0] + 12]
        order = [0, 1, 2, 3, 4, 3, 2, 1] if bar % 2 == 0 else [0, 2, 1, 3, 4, 2, 3, 1]
        for k in range(8):
            if bar % 4 == 3 and k >= 6:
                continue  # breathe before the next phrase
            m = tones[order[k]]
            v = 0.55 if k == 0 else 0.33 + 0.08 * (k % 2)
            S.add(cached('ep', ep, mtof(m), 0.9 * S.spb, jit(v, 0.12)), b0 + k * 0.5 + 0.03, 0.34,
                  pan_=-0.25 + 0.5 * (order[k] / 4.0), send=0.55)
        # occasional high answer note on the 4th bar of a phrase
        if bar % 4 == 3:
            top = ch[1][-1] + 12
            S.add(cached('ep', ep, mtof(top), 1.0 * S.spb, 0.5), b0 + 3, 0.3, pan_=0.3, send=0.6)
    S.buf += reverb(S.send, rt60=1.8, mix=1.0, damp=3800.0, size=1.1) - S.send
    S.buf = biquad(S.buf, 'highshelf', 3500.0, 0.7, 6.0)
    if cycles > 1:
        return master_music(S.buf[:S.length], loop=False, rms_db=-19.0), bpm, bars
    return master_music(S.seal(), loop=True, rms_db=-19.0), bpm, bars


# ------------------------------------------------------------------ PLAY (128 BPM arcade pop) / FAST (148)
# arrangement over 24 bars: chord per bar, melody flag, arp pattern index
PLAY_PROG = ['D', 'A', 'Bm', 'G'] * 3 + ['Bm', 'G', 'D', 'A'] + ['D', 'A', 'Bm', 'G'] + ['D', 'A', 'G', 'A']

HOOK_A = [  # 8 bars, (beat, dur, midi)
    (0, .5, 74), (.5, .5, 76), (1, 1, 78), (2, .5, 81), (2.5, .5, 78), (3, 1, 81),
    (4, 1, 76), (5, .5, 73), (5.5, .5, 76), (6, 2, 81),
    (8, .5, 83), (8.5, .5, 81), (9, 1, 78), (10, .5, 74), (10.5, .5, 78), (11, 1, 81),
    (12, 1, 79), (13, .5, 78), (13.5, .5, 76), (14, 2, 74),
    (16, .5, 74), (16.5, .5, 76), (17, 1, 78), (18, .5, 81), (18.5, .5, 78), (19, 1, 81),
    (20, .5, 81), (20.5, .5, 83), (21, 1, 85), (22, 2, 81),
    (24, .5, 86), (24.5, .5, 85), (25, 1, 83), (26, .5, 81), (26.5, .5, 78), (27, 1, 76),
    (28, 1.5, 78), (29.5, .5, 76), (30, 1.5, 74),
]
HOOK_B = [  # 4 bars over Bm G D A
    (0, 1, 83), (1, .5, 81), (1.5, .5, 78), (2, 2, 81),
    (4, 1, 79), (5, 1, 78), (6, 2, 76),
    (8, .5, 74), (8.5, .5, 76), (9, .5, 78), (9.5, .5, 81), (10, 2, 86),
    (12, 1, 85), (13, 1, 83), (14, 1, 81), (15, 1, 79),
]
HOOK_TAIL = [  # 4 bars over D A G A, ending with a rising run into the loop point
    (0, .5, 74), (.5, .5, 76), (1, 1, 78), (2, .5, 81), (2.5, .5, 78), (3, 1, 81),
    (4, 1, 76), (5, .5, 73), (5.5, .5, 76), (6, 2, 81),
    (8, 1, 79), (9, 1, 78), (10, 1, 76), (11, 1, 74),
    (12, .5, 73), (12.5, .5, 76), (13, .5, 78), (13.5, .5, 81), (14, .5, 83), (14.5, .5, 85), (15, 1, 88),
]
ARP_PATTERNS = [
    [0, 1, 2, 3, 1, 2, 3, 4, 0, 1, 2, 3, 2, 3, 4, 3],
    [0, 2, 1, 3, 0, 2, 1, 3, 4, 2, 3, 1, 4, 3, 2, 1],
    [0, 3, 1, 4, 0, 3, 1, 4, 2, 3, 1, 4, 0, 3, 2, 4],
]


def make_play(bpm=128, fast=False, cycles=1):
    """The gameplay track. fast=True renders bars 1-8 + 21-24 of the same arrangement at the
    faster tempo with driving 16th hats and risers (no time-stretching)."""
    one = list(range(24)) if not fast else list(range(8)) + [20, 21, 22, 23]
    bars = len(one)
    bar_ids = one * cycles
    S = Seq(bpm, bars * cycles, tail=3.0, cycle_bars=bars)
    padbus = np.zeros((S.n, 2))
    for pos, bar in enumerate(bar_ids):
        reseed(1200 + bar)
        b0 = pos * 4
        ch = CHORDS[PLAY_PROG[bar]]
        phrase_end = (bar % 8 == 7) or (fast and pos % bars == bars - 1)
        half_end = (bar % 4 == 3)
        # --- drums
        for bt in range(4):
            S.add(kick(jit(0.95 if bt in (0, 2) else 0.85), punch=1.0, f_end=54.0), b0 + bt, 0.75)
        if phrase_end or half_end:
            S.add(kick(0.8), b0 + 3.5, 0.8)
        for bt in (1, 3):
            S.add(clap(jit(0.9)), b0 + bt, 0.52, pan_=0.1, send=0.35)
            S.add(snare(jit(0.6), tone=0.8, snap=0.9), b0 + bt, 0.38, send=0.3)
        hat_steps = 16 if (fast or phrase_end) else 8
        for k in range(hat_steps):
            bt = b0 + k * (4.0 / hat_steps)
            onbeat = (bt - b0) % 1.0 == 0
            if hat_steps == 8 and onbeat and not phrase_end:
                continue  # off-beat 8ths
            v = 0.45 if onbeat else 0.9
            if hat_steps == 16 and (k % 4) in (1, 3):
                v *= 0.6
            S.add(hat(jit(v, 0.15)), bt, 0.16 if not fast else 0.19, pan_=0.3)
        if bar % 2 == 1:
            S.add(hat(0.8, open_=True), b0 + 3.5, 0.13, pan_=0.3)
        for k in range(16):
            S.add(shaker(jit(0.6 if k % 2 else 0.9, 0.2)), b0 + k * 0.25, 0.055, pan_=-0.45)
        if phrase_end:  # snare roll on beat 4 with rising velocity
            for i in range(4):
                S.add(snare(0.5 + 0.15 * i, decay=0.1), b0 + 3 + i * 0.25, 0.45, send=0.4)
        if (pos % bars) % 8 == 0:
            S.add(crash(0.8), b0, 0.33, pan_=-0.1, send=0.3)
        # --- bass: octave-bouncing 8ths
        r = ch[0]
        pat = [r, r + 12, r, r + 12, r + 7, r + 12, r, r + 12] if bar % 2 == 0 else [r, r + 12, r, r + 7, r + 12, r, r + 12, r + 10 if ch is CHORDS['A'] else r + 12]
        for k, m in enumerate(pat):
            S.add(cached('bass', bass, mtof(m), 0.42 * S.spb, jit(0.9 if k % 2 == 0 else 0.7), 0.7), b0 + k * 0.5, 0.42)
        # --- plucky arpeggio, 16ths, pattern changes every 8 bars
        tones = ch[3]
        tones = [t + 12 for t in tones] + [tones[0] + 24, tones[1] + 24]
        pat = ARP_PATTERNS[(bar // 8) % 3]
        for k in range(16):
            v = 0.95 if k % 4 == 0 else (0.7 if k % 2 == 0 else 0.55)
            S.add(cached('pluck', pluck, mtof(tones[pat[k]]), 0.22 * S.spb, jit(v, 0.1)), b0 + k * 0.25, 0.36,
                  pan_=-0.35 + 0.7 * ((k * 5) % 7) / 6.0, send=0.25)
        # --- brass stabs
        stabs = [(0, .32, .95), (2.5, .28, .8), (3.5, .22, .7)] if bar % 2 == 0 else [(0, .32, .95), (1.5, .28, .8), (3, .35, .85)]
        for bt, d, v in stabs:
            for i, m in enumerate(ch[2]):
                S.add(cached('brass', brass, mtof(m), d * S.spb, jit(v)), b0 + bt + i * 0.004 / S.spb, 0.34, pan_=-0.2 + 0.13 * i, send=0.3)
        # --- pad (side-chain pumped later)
        for m in [ch[0] + 12] + ch[2][:3]:
            seg = cached('pad', pad, mtof(m), 4.0 * S.spb, 0.7, 1300.0, 0.05, 0.3)
            st = ns(b0 * S.spb); e = min(S.n, st + len(seg))
            padbus[st:e] += 0.17 * seg[:e - st]
        # --- fast-mode riser: filtered noise sweeping up over each 4 bars
        if fast and (pos % bars) % 4 == 0:
            L = ns(4 * 4 * S.spb)
            t = tax(L)
            nz = biquad_sweep(white(L), 'bp', 300.0 * (14000.0 / 300.0) ** (t / t[-1]), 1.5) * (t / t[-1]) ** 2.2
            S.add(np.stack([nz, nz], 1) * 0.08, b0)
    # --- melody
    def place_hook(data, section_bar):
        for bt, d, m in data:
            S.add(cached('lead', lead, mtof(m), d * S.spb * 0.95, jit(0.9, 0.1)), section_bar * 4 + bt, 0.42, pan_=0.05, send=0.3)
    for cyc in range(cycles):
        reseed(4000)
        off = cyc * bars
        if not fast:
            place_hook(HOOK_A, off + 0)
            place_hook(HOOK_B, off + 12)
            place_hook(HOOK_A[:21], off + 16)   # bars 17-20: first half of the hook
            place_hook(HOOK_TAIL, off + 20)
        else:
            place_hook(HOOK_A, off + 0)
            place_hook(HOOK_TAIL, off + 8)
    # side-chain pump on the pad: dip on every beat
    # side-chain pump on the pad: dip on every beat, built on the exact beat grid (periodic per loop)
    starts = np.array([ns(i * S.spb) for i in range(int(S.n / S.spb) + 2)])
    idx = np.searchsorted(starts, np.arange(S.n), side='right') - 1
    since = (np.arange(S.n) - starts[idx]) / SR
    pump = 1.0 - 0.75 * np.exp(-since / (0.18 * S.spb))
    S.buf += padbus * pump[:, None]
    S.buf += reverb(S.send, rt60=0.9, mix=1.0, damp=5200.0, size=0.8) - S.send
    S.buf = biquad(S.buf, 'hp', 42.0, 0.8)
    target = -15.0 if fast else -15.5
    if cycles > 1:
        return master_music(S.buf[:S.length], loop=False, rms_db=target), bpm, bars
    return master_music(S.seal(), loop=True, rms_db=target), bpm, bars


# ------------------------------------------------------------------ WIN (8 s fanfare)
def make_win():
    bpm = 120
    S = Seq(bpm, 4, tail=0.0)   # 8.0 s total
    S.n = ns(8.0); S.buf = np.zeros((S.n, 2)); S.send = np.zeros((S.n, 2))
    spb = S.spb
    S.add(timpani(38, 1.0, 1.6), 0, 0.8, send=0.3)
    S.add(crash(0.9, 1.6), 0, 0.3, pan_=-0.1, send=0.3)
    S.add(kick(1.0), 0, 0.8)
    # fanfare melody with harmony: A D F# A(hold) G A(hold)
    motif = [(0, .45, [69, 62, 66]), (0.5, .45, [74, 66, 69]), (1.0, .45, [78, 69, 74]),
             (1.5, 1.3, [81, 74, 78, 66]), (3.0, .45, [79, 74, 71]), (3.5, 2.6, [81, 78, 74, 69, 62])]
    for bt, d, notes in motif:
        for i, m in enumerate(notes):
            v = 0.95 if i == 0 else 0.75
            S.add(cached('brass', brass, mtof(m), d * spb, v), bt + i * 0.006 / spb, 0.34, pan_=-0.25 + 0.14 * i, send=0.45)
        S.add(cached('bass', bass, mtof(notes[-1] - 24 if notes[-1] - 24 > 35 else notes[-1] - 12), d * spb, 0.9, 0.5), bt, 0.5)
    for bt in (0.5, 1.0, 1.5, 3.0, 3.5):
        S.add(kick(0.9), bt, 0.7)
        S.add(snare(0.8), bt, 0.3, send=0.3)
    # timpani roll into the final chord, cymbal on it
    for i in range(6):
        S.add(timpani(38 if i % 2 else 45, 0.4 + 0.08 * i, 0.5), 2.55 + i * 0.075, 0.5)
    S.add(timpani(38, 1.0, 2.0), 3.5, 0.85, send=0.3)
    S.add(crash(1.0, 2.2), 3.5, 0.33, pan_=0.1, send=0.4)
    # sparkle glissando up two octaves of D major, landing with the final chord
    scale = [74, 76, 78, 79, 81, 83, 85, 86, 88, 90, 91, 93, 95, 97, 98]
    for i, m in enumerate(scale):
        S.add(cached('bell', bell, mtof(m), 0.5, 0.8, 3.5, 0.7), 3.5 + i * 0.045 / spb * spb * 0.5 / 0.5 if False else 3.5 + i * 0.09 / spb, 0.2,
              pan_=-0.6 + 1.2 * i / len(scale), send=0.7)
    # pad bed on the final chord
    for m in (50, 57, 62, 66):
        S.add(cached('pad', pad, mtof(m), 2.6 * spb, 0.8, 1400.0, 0.1, 0.8), 3.5, 0.2)
    S.buf += reverb(S.send, rt60=1.7, mix=1.0, damp=4500.0, size=1.1) - S.send
    out = S.buf
    out = fade_out(out, 350)
    return master_music(out, loop=False, rms_db=-15.0), bpm, None


# ------------------------------------------------------------------ LOSE (5 s encouraging sting)
def make_lose():
    bpm = 100
    S = Seq(bpm, 1, tail=0.0)
    S.n = ns(5.0); S.buf = np.zeros((S.n, 2)); S.send = np.zeros((S.n, 2))
    spb = S.spb
    chords = [(0.0, 1.0, [47 + 12, 62, 66, 69, 71]), (1.0, 1.0, [43 + 12, 62, 66, 67, 71]),
              (2.0, 1.0, [45 + 12, 61, 64, 67, 71]), (3.0, 2.4, [50 + 12, 66, 69, 73, 78])]
    for bt, d, notes in chords:
        for i, m in enumerate(notes):
            S.add(cached('ep', ep, mtof(m), d * spb, 0.6 if i else 0.7), bt + i * 0.014 / spb, 0.42, pan_=-0.3 + 0.15 * i, send=0.5)
        S.add(cached('bass', bass, mtof(notes[0] - 24), d * spb, 0.8, 0.3), bt, 0.45)
    for m in (50, 57, 62, 66):
        S.add(cached('pad', pad, mtof(m), 2.4 * spb, 0.6, 900.0, 0.4, 1.0), 3.0, 0.16)
    # rising marimba lick into the last chord, then a wink
    for bt, m in ((2.5, 74), (2.75, 78), (3.0, 81), (3.5, 86)):
        S.add(cached('mar', marimba, mtof(m), 0.4, 0.85), bt, 0.5, pan_=0.25, send=0.6)
    S.add(cached('mar', marimba, mtof(90), 0.4, 0.7), 4.0, 0.4, pan_=0.35, send=0.6)
    S.add(brush(0.7, 0.5), 3.0, 0.2, pan_=-0.2, send=0.4)
    S.buf += reverb(S.send, rt60=1.5, mix=1.0, damp=4200.0, size=1.0) - S.send
    out = fade_out(S.buf, 400)
    return master_music(out, loop=False, rms_db=-18.0), bpm, None


# ------------------------------------------------------------------ AMBIENCE (10 s steam loop)
def make_steam():
    """10 s steam / room-tone loop. Built from exactly periodic noise and filtered circularly, so the
    file repeats with no seam at all."""
    reseed(5)
    n = ns(10.0)
    t = tax(n)
    hiss = circ_biquad(circ_biquad(periodic_noise(n, 0.0), 'bp', 4200.0, 0.45), 'hp', 1600.0, 0.7)
    lfo = 0.55 + 0.45 * (0.5 * np.sin(TWO_PI * 3 * t / 10.0) + 0.3 * np.sin(TWO_PI * 7 * t / 10.0 + 1.0) + 0.2 * np.sin(TWO_PI * 2 * t / 10.0 + 2.5))
    hiss *= lfo
    whistle = circ_biquad(periodic_noise(n, 0.0), 'bp', 7800.0, 3.0) * (0.3 + 0.7 * (0.5 + 0.5 * np.sin(TWO_PI * 1 * t / 10.0 - 0.6)) ** 2) * 0.35
    room = circ_biquad(periodic_noise(n, 1.0), 'lp', 320.0, 0.7) * 0.9
    room2 = circ_biquad(periodic_noise(n, 1.0), 'lp', 1200.0, 0.7) * 0.25
    L = hiss + whistle + room + room2
    R = np.roll(hiss, ns(0.009)) * 0.92 + whistle * 1.05 + np.roll(room, ns(0.013)) + room2
    x = np.stack([L, R], 1)
    x = circ_biquad(x, 'hp', 40.0, 0.7)
    return normalize_peak(x, -14.0)

# ==========================================================================================
# sfx.py
# ==========================================================================================
"""Designed sound effects for Dunk the Break. Each function returns a finished stereo array
(44.1 kHz float, peak-normalised, transient at sample 0)."""
import math
import numpy as np




def _buf(dur):
    n = ns(dur)
    return n, tax(n)


def _put(buf, sig, at=0.0, gain=1.0, pan_=0.0):
    """Add sig (mono or stereo) into buf (stereo) at time `at` seconds."""
    if sig.ndim == 1:
        sig = pan(sig, pan_)
    i = ns(at)
    e = min(len(buf), i + len(sig))
    if e > i:
        buf[i:e] += gain * sig[:e - i]
    return buf


def sfx_ui_tap():
    reseed(11)
    n, t = _buf(0.085)
    click = onepole_hp(white(n), 1200.0) * np.exp(-t / 0.0014)
    wood = biquad(white(n), 'bp', 1850.0, 5.0) * np.exp(-t / 0.0065)
    body = sine(820.0 * (1 + 0.12 * np.exp(-t / 0.003)), n) * np.exp(-t / 0.011) * 0.6 + sine(255.0, n) * np.exp(-t / 0.018) * 0.45
    x = softclip(click * 0.8 + wood * 1.6 + body, 1.2)
    return master_sfx(x, -3.0, tail_ms=12)


def sfx_ui_done():
    reseed(12)
    n, t = _buf(0.34)
    x = np.zeros((n, 2))
    _put(x, marimba(mtof(81), 0.2, 0.85), 0.0, 1.0, -0.15)     # A5
    _put(x, marimba(mtof(86), 0.2, 0.95), 0.105, 1.0, 0.15)    # D6
    x = reverb(x, rt60=0.5, mix=0.18, predelay=0.004, damp=6500.0, size=0.6)
    return master_sfx(x, -3.0, tail_ms=90)


def sfx_ui_error():
    reseed(13)
    n, t = _buf(0.27)
    x = np.zeros(n)
    for st, f in ((0.0, 164.8), (0.115, 146.8)):   # E3 -> D3, muted
        i = ns(st); m = n - i; tt = tax(m)
        bonk = sine(f * (1 + 0.3 * np.exp(-tt / 0.009)), m) * np.exp(-tt / 0.045)
        bonk += 0.35 * sine(f * 2.42, m) * np.exp(-tt / 0.018)
        bonk += onepole_lp(white(m), 900.0) * np.exp(-tt / 0.004) * 0.9
        x[i:] += bonk * np.minimum(1.0, tt / 0.0008)
    x = onepole_lp(x, 2400.0)
    return master_sfx(x, -3.0, tail_ms=40)


def sfx_detect():
    reseed(14)
    n, t = _buf(0.55)
    x = np.zeros((n, 2))
    wl = ns(0.17); tt = tax(wl); u = tt / tt[-1]
    wh = biquad_sweep(white(wl), 'bp', 400.0 * (6000.0 / 400.0) ** u, 2.2) * (1 - np.exp(-tt / 0.006)) * (0.35 + 0.65 * u) * (1 - u) ** 0.4
    _put(x, wh * 0.9, 0.0)
    _put(x, bell(mtof(81), 0.34, 0.9, 2.0, 0.8), 0.15, 0.9, -0.2)   # A5
    _put(x, bell(mtof(86), 0.36, 1.0, 2.0, 0.8), 0.27, 1.0, 0.2)    # D6
    x = reverb(x, rt60=0.6, mix=0.2, predelay=0.005, damp=7000.0, size=0.6)
    return master_sfx(x, -3.0, tail_ms=70)


def sfx_count():
    reseed(15)
    n, t = _buf(0.16)
    click = onepole_hp(white(n), 2500.0) * np.exp(-t / 0.001) * 0.7
    body = sine(185.0 * (1 + 0.7 * np.exp(-t / 0.006)), n) * np.exp(-t / 0.034)
    knock = biquad(white(n), 'bp', 1150.0, 3.0) * np.exp(-t / 0.008)
    x = softclip(click + body * 1.25 + knock * 0.8, 1.3)
    return master_sfx(x, -3.0, tail_ms=25)


def sfx_go():
    reseed(16)
    n, t = _buf(0.65)
    x = np.zeros((n, 2))
    for i, m in enumerate((62, 66, 69, 74)):
        _put(x, brass(mtof(m), 0.26, 1.0), i * 0.004, 0.8, -0.3 + 0.2 * i)
    _put(x, kick(1.0), 0.0, 0.9)
    _put(x, clap(0.8), 0.0, 0.4)
    _put(x, crash(0.9, 0.55), 0.0, 0.5, 0.15)
    x = reverb(x, rt60=0.7, mix=0.15, predelay=0.006, damp=6000.0, size=0.7)
    return master_sfx(x, -3.0, tail_ms=80)


def sfx_catch(pitch=1.0, seed=17):
    reseed(seed)
    n, t = _buf(0.27)
    pop = onepole_hp(white(n), 3000.0) * np.exp(-t / 0.0012) * 0.9 + biquad(white(n), 'bp', 2600.0 * pitch, 1.5) * np.exp(-t / 0.006) * 1.2
    f1 = (300.0 + 620.0 * np.exp(-t / 0.03)) * pitch
    plop = sine(f1, n) * np.exp(-t / 0.06) * np.minimum(1.0, t / 0.0015)
    tt = t - 0.025
    m = tt > 0
    tb = np.clip(tt, 0, 1)
    f2 = np.where(m, (430.0 * pitch) * 2.0 ** (tb / 0.045), 0.0)
    bub = np.where(m, np.sin(TWO_PI * np.cumsum(f2) / SR), 0.0) * np.where(m, np.exp(-tb / 0.03), 0.0) * 0.6
    splash = biquad(white(n), 'bp', 3800.0 * pitch ** 0.5, 0.8) * np.exp(-t / 0.035) * 0.5 * (1 - np.exp(-t / 0.004))
    x = softclip(pop * 0.9 + plop * 1.1 + bub + splash, 1.3)
    x = reverb(x, rt60=0.4, mix=0.12, predelay=0.004, damp=6000.0, size=0.5)
    return master_sfx(x, -3.0, tail_ms=40)


def sfx_gold():
    reseed(18)
    n, t = _buf(0.75)
    x = np.zeros((n, 2))
    for i, m in enumerate((74, 78, 81, 86, 90, 93)):   # D5 F#5 A5 D6 F#6 A6
        _put(x, bell(mtof(m), 0.45, 0.85, 3.5, 0.9), i * 0.055, 0.8, -0.5 + 0.2 * i)
    shimmer = biquad(white(n), 'hp', 8000.0, 0.7) * np.minimum(1.0, t / 0.15) * np.exp(-t / 0.25) * 0.12
    for f in (4698.6, 5919.9, 7040.0):
        shimmer += sine(f * (1 + 0.012 * np.sin(TWO_PI * 6.0 * t)), n) * np.exp(-t / 0.3) * np.minimum(1.0, t / 0.1) * 0.05
    _put(x, shimmer, 0.0)
    x = reverb(x, rt60=0.9, mix=0.3, predelay=0.008, damp=8000.0, size=0.8)
    return master_sfx(x, -3.0, tail_ms=90)


def sfx_streak():
    reseed(19)
    n, t = _buf(0.64)
    x = np.zeros((n, 2))
    for i, (m, d) in enumerate(((74, .26), (76, .26), (78, .26), (81, .42))):   # D5 E5 F#5 A5
        _put(x, bell(mtof(m), d, 0.9, 2.0, 1.0), i * 0.09, 0.9, -0.3 + 0.2 * i)
    _put(x, hat(0.5), 0.27, 0.15, 0.3)
    x = reverb(x, rt60=0.7, mix=0.25, predelay=0.006, damp=7500.0, size=0.7)
    return master_sfx(x, -3.0, tail_ms=90)


def sfx_hit():
    reseed(20)
    n, t = _buf(0.42)
    thud = sine(95.0 * (1 + 0.8 * np.exp(-t / 0.015)), n) * np.exp(-t / 0.08) * 1.2 + onepole_lp(white(n), 400.0) * np.exp(-t / 0.012) * 1.5
    crack = np.zeros(n)
    for st, f in ((0.004, 3300.0), (0.012, 4700.0), (0.019, 6100.0), (0.031, 5400.0)):
        i = ns(st); m = n - i; tt = tax(m)
        crack[i:] += biquad(white(m), 'bp', f, 6.0) * np.exp(-tt / 0.012) * 1.6 + onepole_hp(white(m), 4000.0) * np.exp(-tt / 0.002) * 0.8
    i = ns(0.02); m = n - i; tt = tax(m)
    buzz = np.zeros(n)
    buzz[i:] = biquad(square(55.0, m, 0.0, 0.5) * np.exp(-tt / 0.12) * (0.6 + 0.4 * np.sin(TWO_PI * 31.0 * tt)), 'lp', 700.0, 1.0) * 0.9
    x = softclip(thud + crack * 0.8 + buzz, 1.5)
    return master_sfx(x, -3.0, tail_ms=50)


def sfx_miss():
    reseed(21)
    n, t = _buf(0.22)
    x = biquad_sweep(white(n), 'bp', 900.0 * np.exp(-t / 0.1) + 250.0, 1.2) * np.minimum(1.0, t / 0.006) * np.exp(-t / 0.06)
    x = onepole_lp(x, 1800.0)
    return master_sfx(x, -14.0, tail_ms=40)


def sfx_whoosh():
    reseed(22)
    n, t = _buf(0.42)
    u = t / t[-1]
    fc = 300.0 * (3200.0 / 300.0) ** np.sin(math.pi * u)
    env = (1 - np.exp(-t / 0.012)) * (1 - u) ** 0.6 * (0.55 + 0.45 * np.sin(math.pi * u))
    x = biquad_sweep(white(n), 'bp', fc, 1.3) * env
    th = (np.linspace(-1.0, 1.0, n) + 1.0) * math.pi / 4.0
    st = np.stack([x * np.cos(th), x * np.sin(th)], 1)
    return master_sfx(st, -3.0, tail_ms=30)


def sfx_hurry():
    reseed(23)
    n, t = _buf(0.5)
    x = np.zeros(n)
    for st, f in ((0.0, 880.0), (0.16, 987.8), (0.32, 1174.7)):   # A5 B5 D6
        i = ns(st); m = ns(0.1); tt = tax(m)
        b = (0.7 * sine(f, m) + 0.3 * square(f, m, 0.0, 0.5)) * adsr(m, 0.003, 0.05, 0.8, 0.012, gate=0.085)
        x[i:i + m] += b
    x = onepole_lp(x, 7000.0)
    return master_sfx(x, -3.0, tail_ms=15)


def sfx_timeup():
    reseed(24)
    n, t = _buf(1.2)
    f0 = 110.0
    x = np.zeros(n)
    for k, (r, a, tau) in enumerate(((1.0, 1.0, 0.9), (1.52, 0.7, 0.7), (2.07, 0.55, 0.55), (2.71, 0.4, 0.45),
                                     (3.4, 0.3, 0.35), (4.3, 0.22, 0.28), (5.6, 0.15, 0.2), (7.1, 0.1, 0.15))):
        bloom = 1.0 - 0.6 * np.exp(-t / (0.05 + 0.04 * k))
        x += a * (sine(f0 * r, n) + 0.6 * sine(f0 * r * 1.004, n)) * np.exp(-t / tau) * bloom
    strike = onepole_lp(white(n), 2000.0) * np.exp(-t / 0.01) * 1.2 + biquad(white(n), 'bp', 500.0, 2.0) * np.exp(-t / 0.05) * 0.6
    shimmer = biquad(white(n), 'hp', 6000.0, 0.7) * np.exp(-t / 0.35) * 0.12
    x = softclip(x * 0.6 + strike + shimmer, 1.3)
    st = widen(x, 9.0, 0.35)
    st = reverb(st, rt60=0.9, mix=0.2, predelay=0.01, damp=5000.0, size=0.9)
    return master_sfx(st, -3.0, tail_ms=300)


def sfx_countup():
    reseed(25)
    n = ns(1.0)
    x = np.zeros(n)
    period = n // 20
    m = ns(0.02); tt = tax(m)
    for k in range(20):
        tick = onepole_hp(white(m), 3000.0) * np.exp(-tt / 0.0008) * 0.7 + sine(2600.0 * (1 + 0.3 * np.exp(-tt / 0.002)), m) * np.exp(-tt / 0.004) * 0.8 \
            + sine(1100.0, m) * np.exp(-tt / 0.006) * 0.3
        v = (1.0 if k % 2 == 0 else 0.8) * RNG.uniform(0.9, 1.0)
        x[k * period:k * period + m] += tick * v
    return master_sfx(x, -8.0, tail_ms=6, trim=False)


def sfx_prize():
    reseed(26)
    n, t = _buf(0.85)
    x = np.zeros((n, 2))
    wl = ns(0.32); tt = tax(wl); u = tt / tt[-1]
    wh = biquad_sweep(white(wl), 'bp', 250.0 * (6000.0 / 250.0) ** u, 1.6) * (1 - np.exp(-tt / 0.004)) * (0.5 + 0.5 * u)
    _put(x, wh * 0.8, 0.0)
    notes = (86, 90, 93, 95, 98, 100, 102, 105)   # D major pentatonic, high
    for i, m in enumerate(notes):
        _put(x, bell(mtof(m), 0.38, 0.8, 3.5, 0.9), 0.28 + i * 0.042, 0.55, -0.6 + 1.2 * i / 7)
    _put(x, bell(mtof(74), 0.5, 0.8, 2.0, 0.6), 0.30, 0.5, -0.1)
    _put(x, bell(mtof(81), 0.5, 0.8, 2.0, 0.6), 0.30, 0.45, 0.1)
    x = reverb(x, rt60=1.0, mix=0.35, predelay=0.008, damp=8000.0, size=0.9)
    return master_sfx(x, -3.0, tail_ms=120)


def sfx_confetti():
    reseed(27)
    n, t = _buf(0.72)
    pop = onepole_hp(white(n), 1500.0) * np.exp(-t / 0.002) * 1.5 + sine(180.0 * (1 + 2 * np.exp(-t / 0.004)), n) * np.exp(-t / 0.03) * 1.2 \
        + biquad(white(n), 'bp', 900.0, 1.0) * np.exp(-t / 0.015)
    x = np.zeros((n, 2))
    _put(x, softclip(pop, 1.3), 0.0)
    for _ in range(38):
        st = float(RNG.uniform(0.03, 0.62))
        m = ns(RNG.uniform(0.006, 0.018)); tt = tax(m)
        burst = biquad(white(m), 'bp', float(RNG.uniform(1500, 5500)), 2.0) * np.sin(math.pi * tt / tt[-1]) * (1.0 - st / 0.7) * 0.9
        _put(x, burst, st, 1.0, float(RNG.uniform(-0.8, 0.8)))
    rustle = biquad(white(n), 'bp', 3200.0, 1.0) * (0.5 + 0.5 * np.sin(TWO_PI * 23.0 * t) * np.sin(TWO_PI * 7.0 * t + 1.0)) * np.exp(-t / 0.25) * 0.35
    _put(x, rustle, 0.03)
    x = reverb(x, rt60=0.6, mix=0.18, predelay=0.005, damp=6000.0, size=0.7)
    return master_sfx(x, -3.0, tail_ms=80)


SFX = {
    'sfx-ui-tap.wav': sfx_ui_tap,
    'sfx-ui-done.wav': sfx_ui_done,
    'sfx-ui-error.wav': sfx_ui_error,
    'sfx-detect.wav': sfx_detect,
    'sfx-count.wav': sfx_count,
    'sfx-go.wav': sfx_go,
    'sfx-catch.wav': lambda: sfx_catch(1.0, 17),
    'sfx-catch-2.wav': lambda: sfx_catch(1.122, 28),
    'sfx-catch-3.wav': lambda: sfx_catch(1.26, 29),
    'sfx-gold.wav': sfx_gold,
    'sfx-streak.wav': sfx_streak,
    'sfx-hit.wav': sfx_hit,
    'sfx-miss.wav': sfx_miss,
    'sfx-whoosh.wav': sfx_whoosh,
    'sfx-hurry.wav': sfx_hurry,
    'sfx-timeup.wav': sfx_timeup,
    'sfx-countup.wav': sfx_countup,
    'sfx-prize.wav': sfx_prize,
    'sfx-confetti.wav': sfx_confetti,
}

# ==========================================================================================
# main.py
# ==========================================================================================
"""Orchestration: render every file, encode, validate, print the table, build the preview."""
import os, sys, json, time, argparse, subprocess
import numpy as np





MUSIC = [
    ('music-attract.mp3', make_attract, True),
    ('music-register.mp3', make_register, True),
    ('music-play.mp3', lambda **kw: make_play(128, False, **kw), True),
    ('music-play-fast.mp3', lambda **kw: make_play(148, True, **kw), True),
    ('music-win.mp3', make_win, False),
    ('music-lose.mp3', make_lose, False),
]


def ffprobe(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=sample_rate,channels,codec_name,bit_rate:format=duration',
                        '-of', 'json', path], capture_output=True, text=True, check=True)
    j = json.loads(r.stdout)
    s = j['streams'][0]
    return {'dur': float(j['format']['duration']), 'sr': int(s['sample_rate']), 'ch': int(s['channels']),
            'codec': s['codec_name'], 'bitrate': int(s.get('bit_rate', 0) or 0)}


def decode(path):
    r = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-'],
                       capture_output=True, check=True)
    return np.frombuffer(r.stdout, dtype='<f4').astype(float).reshape(-1, 2)


def to_mp3(wav, mp3):
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', wav, '-codec:a', 'libmp3lame', '-b:a', '192k',
                    '-ar', str(SR), '-ac', '2', '-write_xing', '1', mp3], check=True)


def continuity(fn, loop):
    """Compare the sealed loop played twice with a continuous two-cycle render around the seam."""
    ref, _, _ = fn(cycles=2)
    L = len(loop)
    k = ns(0.05)
    tiled = np.concatenate([loop, loop])
    a = ref[L - k:L + k]
    b = tiled[L - k:L + k]
    g = float(np.sum(a * b) / (np.sum(b * b) + 1e-12))
    return float(np.max(np.abs(a - g * b))), g


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'assets', 'audio'))
    ap.add_argument('--work', default='/home/user/audio-gen')
    ap.add_argument('--only', default='')
    ap.add_argument('--no-check', action='store_true', help='skip the two-cycle loop continuity renders')
    ap.add_argument('--no-preview', action='store_true')
    args = ap.parse_args()
    out = os.path.abspath(args.out); work = os.path.abspath(args.work)
    os.makedirs(out, exist_ok=True); os.makedirs(work, exist_ok=True)
    only = set(x.strip() for x in args.only.split(',') if x.strip())
    rows = []
    previews = []
    t_all = time.time()

    for name, fn, is_loop in MUSIC:
        if only and name not in only:
            continue
        t0 = time.time()
        reseed(1)
        x, bpm, bars = fn()
        stem = os.path.splitext(name)[0]
        wav = os.path.join(work, stem + '.wav')
        write_wav(wav, x)
        mp3 = os.path.join(out, name)
        to_mp3(wav, mp3)
        row = {'file': name, 'kind': 'loop' if is_loop else 'one-shot', 'bpm': bpm, 'bars': bars,
               'dur': len(x) / SR, 'peak_db': a2db(peak(x)), 'rms_db': a2db(rms(x))}
        if is_loop:
            jump, ratio = seam_report(x)
            row['seam_jump'] = jump
            row['seam_ratio'] = ratio
            if not args.no_check:
                err, g = continuity(fn, x)
                row['cont_err'] = err
                row['cont_gain'] = g
        dec = decode(mp3)
        row['mp3_len_delta'] = len(dec) - len(x)
        row['mp3_err_db'] = a2db(np.max(np.abs(dec[:len(x)] - x[:len(dec)]))) if len(dec) >= len(x) - 2 else None
        row.update(ffprobe(mp3))
        row['secs'] = time.time() - t0
        rows.append(row)
        previews.append((name, x[:ns(4.0)]))
        print(f"  rendered {name:22s} {row['dur']:6.2f}s  {row['secs']:5.1f}s", flush=True)

    for name, fn in list(SFX.items()) + [('amb-steam.wav', make_steam)]:
        if only and name not in only:
            continue
        t0 = time.time()
        x = fn()
        path = os.path.join(out, name)
        write_wav(path, x)
        y = read_wav(path)
        row = {'file': name, 'kind': 'loop' if name in ('amb-steam.wav', 'sfx-countup.wav') else 'effect',
               'dur': len(y) / SR, 'peak_db': a2db(peak(y)), 'rms_db': a2db(rms(y)),
               'lead_ms': 1000.0 * int(np.argmax(np.abs(y).max(axis=1) > db2a(-40.0))) / SR}
        if row['kind'] == 'loop':
            jump, ratio = seam_report(y)
            row['seam_jump'] = jump; row['seam_ratio'] = ratio
        row.update(ffprobe(path))
        row['secs'] = time.time() - t0
        rows.append(row)
        previews.append((name, y))
        print(f"  rendered {name:22s} {row['dur']:6.2f}s  {row['secs']:5.1f}s", flush=True)

    # ---- table
    print()
    print(f"{'file':22s} {'kind':9s} {'dur s':>7s} {'sr':>6s} {'ch':>2s} {'peak':>7s} {'rms':>7s} {'seam|dx|':>9s} {'2cyc err':>9s} {'mp3Δ':>5s} {'lead':>6s}")
    for r in rows:
        print(f"{r['file']:22s} {r['kind']:9s} {r['dur']:7.3f} {r['sr']:6d} {r['ch']:2d} {r['peak_db']:7.2f} {r['rms_db']:7.2f} "
              f"{(f'{r['seam_jump']:.4f}' if 'seam_jump' in r else '-'):>9s} "
              f"{(f'{r['cont_err']:.4f}' if 'cont_err' in r else '-'):>9s} "
              f"{(str(r['mp3_len_delta']) if 'mp3_len_delta' in r else '-'):>5s} "
              f"{(f'{r['lead_ms']:.1f}ms' if 'lead_ms' in r else '-'):>6s}")
    with open(os.path.join(work, 'report.json'), 'w') as f:
        json.dump(rows, f, indent=1)

    # ---- preview: 4 s of each music track then every effect, 0.3 s gaps
    if not args.no_preview and previews:
        gap = np.zeros((ns(0.3), 2))
        parts = []
        for name, x in previews:
            parts.append(fade_out(stereo(x), 60) if name.startswith('music') else stereo(x))
            parts.append(gap)
        pv = np.concatenate(parts)
        pwav = os.path.join(work, 'preview.wav')
        write_wav(pwav, pv)
        to_mp3(pwav, os.path.join(work, 'preview.mp3'))
        print(f"\npreview: {os.path.join(work, 'preview.mp3')}  ({len(pv) / SR:.1f} s, {len(previews)} items)")
    print(f"total {time.time() - t_all:.1f}s")


if __name__ == '__main__':
    main()
