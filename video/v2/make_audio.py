"""Score + SFX for the Hover Island launch film. 120 BPM, 46 s, A minor-ish.
Writes score.wav (stereo 48k) and spectrum.json (24 bands per video frame @30fps)."""
import json, numpy as np
from scipy.signal import butter, sosfilt, fftconvolve

SR = 48000
DUR = 46.0
N = int(SR * DUR)
BEAT = 0.5
rng = np.random.default_rng(7)
L = np.zeros(N); R = np.zeros(N)

def t_arr(d): return np.arange(int(SR * d)) / SR
def add(sig, at, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N: return
    s = sig[: N - i] * gain
    l = np.cos((pan + 1) * np.pi / 4); r = np.sin((pan + 1) * np.pi / 4)
    L[i:i + len(s)] += s * l * 1.414; R[i:i + len(s)] += s * r * 1.414
def env(n, a, d, s_lvl, rel, total):
    e = np.ones(n) * s_lvl
    A = int(a * SR); D = int(d * SR); Rl = int(rel * SR)
    A = min(A, n); e[:A] = np.linspace(0, 1, A)
    e[A:A + D] = np.linspace(1, s_lvl, len(e[A:A + D]))
    rs = max(0, n - Rl); e[rs:] *= np.linspace(1, 0, n - rs)
    return e
def lp(x, f, order=2): return sosfilt(butter(order, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, order=2): return sosfilt(butter(order, f, 'high', fs=SR, output='sos'), x)
def bp(x, lo, hi): return sosfilt(butter(2, [lo, hi], 'band', fs=SR, output='sos'), x)
def note(m): return 440 * 2 ** ((m - 69) / 12)

# ---------- pad (detuned saws, filtered) ----------
chords = [[57, 60, 64, 69], [53, 57, 60, 65], [48, 55, 60, 64], [55, 59, 62, 67]]  # Am F C G
def saw(f, d):
    t = t_arr(d); out = np.zeros(len(t))
    for det in (-0.12, 0.0, 0.13):
        ff = f * 2 ** (det / 12)
        out += 2 * ((t * ff + rng.random()) % 1) - 1
    return out / 3
for bar in range(23):
    at = bar * 2.0
    ch = chords[bar % 4]
    d = 2.2
    sig = sum(saw(note(m), d) for m in ch) / 4
    cutoff = 900 if at < 4 else (2400 if at < 36 else 700)
    if 36 <= at < 40: cutoff = 500
    if at >= 40: cutoff = 1800
    sig = lp(sig, cutoff, 2) * env(len(sig), 0.25, 0.3, 0.8, 0.4, d)
    g = 0.16 if at < 4 else 0.12
    if at >= 44: g = 0.0
    add(sig, at, g, -0.3); add(lp(sig, cutoff * 0.8), at + 0.012, g, 0.3)

# final sustained chord
sig = sum(saw(note(m), 6.0) for m in [57, 60, 64, 69, 76]) / 5
add(lp(sig, 1500) * env(len(sig), 0.05, 1.0, 0.7, 4.5, 6), 40.0, 0.16)

# ---------- bass ----------
roots = [45, 41, 36, 43]
for bar in range(18):
    at = 4.0 + bar * 2.0
    if at >= 40: break
    if 36 <= at < 40: continue
    r = roots[int(at / 2) % 4]
    for k in range(4):
        tt = t_arr(0.42); f = note(r)
        s = np.sin(2 * np.pi * f * tt) + 0.3 * np.sin(4 * np.pi * f * tt)
        add(s * env(len(tt), 0.005, 0.1, 0.7, 0.15, 0.42), at + k * BEAT, 0.28)

# ---------- drums ----------
def kick():
    t = t_arr(0.45); f = 48 + 110 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t * 7.5) + 0.3 * np.exp(-t * 200) * rng.standard_normal(len(t)) * 0.3
def snare():
    t = t_arr(0.3)
    n = bp(rng.standard_normal(len(t)), 1500, 7000) * np.exp(-t * 16)
    b = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 25)
    return n * 0.8 + b * 0.5
def hat(open_=False):
    t = t_arr(0.25 if open_ else 0.06)
    return hp(rng.standard_normal(len(t)), 8000) * np.exp(-t * (14 if open_ else 70))
def clap():
    t = t_arr(0.25); n = bp(rng.standard_normal(len(t)), 900, 5000)
    e = np.zeros(len(t))
    for o in (0, 0.012, 0.024): e += np.exp(-np.clip(t - o, 0, None) * 40) * (t >= o)
    return n * e * 0.6
K, S, H, HO, C = kick(), snare(), hat(), hat(True), clap()
for b in range(int(46 / BEAT)):
    at = b * BEAT
    if at < 4 or at >= 40: continue
    breakdown = 36 <= at < 40
    if not breakdown or at >= 39.0:
        add(K, at, 0.75 if not breakdown else 0.5)
    if at >= 10 and not breakdown:
        add(H, at + 0.25, 0.10, 0.4); add(H, at, 0.06, -0.4)
        if b % 4 == 3: add(HO, at + 0.25, 0.07, 0.3)
    if at >= 14 and not breakdown and b % 2 == 1:
        add(S, at, 0.32); add(C, at, 0.2)
# snare roll into the end
for i in range(16):
    add(S, 39.0 + i * 0.0625, 0.05 + 0.02 * i)

# ---------- arp (plucks) from 20s ----------
def pluck(f, d=0.3):
    t = t_arr(d); s = (2 * ((t * f) % 1) - 1)
    return lp(s, 3000) * np.exp(-t * 11)
arp = [0, 7, 12, 7, 3, 7, 12, 15]
for b in range(int(46 / 0.25)):
    at = b * 0.25
    if at < 20 or at >= 36: continue
    r = [57, 53, 48, 55][int(at / 2) % 4]
    m = r + 12 + arp[b % 8]
    add(pluck(note(m)), at, 0.06, 0.5 if b % 2 else -0.5)

# ---------- SFX ----------
def whoosh(d=0.8, up=True):
    t = t_arr(d); n = rng.standard_normal(len(t))
    out = np.zeros(len(t)); steps = 24
    for i in range(steps):
        a, b2 = i * len(t) // steps, (i + 1) * len(t) // steps
        p = i / steps; f = (300 + 5000 * p) if up else (5300 - 5000 * p)
        out[a:b2] = bp(n, max(100, f * 0.7), min(20000, f * 1.3))[a:b2]
    return out * np.sin(np.pi * np.linspace(0, 1, len(t))) ** 2
def riser(d=2.0):
    t = t_arr(d); f = 200 * (20 ** (t / d))
    tone = np.sin(2 * np.pi * np.cumsum(f) / SR) * 0.3
    return (whoosh(d, True) * 0.8 + tone) * (t / d) ** 2
def impact():
    t = t_arr(2.5)
    sub = np.sin(2 * np.pi * (40 + 60 * np.exp(-t * 10)) * t) * np.exp(-t * 2.2)
    n = lp(rng.standard_normal(len(t)), 2500) * np.exp(-t * 4)
    return sub + n * 0.4
def pop(f=900):
    t = t_arr(0.12); fr = f * (1 + 0.6 * np.exp(-t * 60))
    return np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.exp(-t * 35)
def click():
    t = t_arr(0.04); return hp(rng.standard_normal(len(t)), 2000) * np.exp(-t * 180) + np.sin(2 * np.pi * 2400 * t) * np.exp(-t * 120) * 0.5
def chime(fs=(1318.5, 1760, 2637)):
    t = t_arr(1.4); return sum(np.sin(2 * np.pi * f * t) * np.exp(-t * (3 + i)) for i, f in enumerate(fs)) / len(fs)
def tick(): return pop(2200) * 0.5
def key():
    t = t_arr(0.05); return bp(rng.standard_normal(len(t)), 1200, 6000) * np.exp(-t * 120)
def thud():
    t = t_arr(0.4); return np.sin(2 * np.pi * (70 + 80 * np.exp(-t * 30)) * t) * np.exp(-t * 12)

add(riser(3.6), 0.4, 0.35)
add(impact(), 4.0, 0.9)
add(pop(700), 4.05, 0.5)
for at in (2.0,):
    add(whoosh(0.6, False), at - 0.1, 0.25)
add(whoosh(0.9), 9.2, 0.3, -0.6)
add(click(), 10.0, 0.6)
add(whoosh(0.6), 10.05, 0.25, 0.4)
for i in range(4): add(tick(), 10.45 + i * 0.12, 0.35, -0.5 + i * 0.3)
add(whoosh(1.0, False), 13.6, 0.3)
for i, at in enumerate([20.0, 20.5, 21.0, 21.5]): add(pop(1100 + 150 * i), at, 0.35, -0.5 + i * 0.3)
add(whoosh(0.9), 23.5, 0.3, 0.6)
add(whoosh(0.7), 24.6, 0.25, -0.4)
add(thud(), 25.9, 0.5)
add(pop(800), 25.95, 0.3)
add(chime((1046.5, 1568, 2093)), 28.2, 0.3)
add(whoosh(0.8), 29.5, 0.3)
for i in range(6): add(key(), 30.35 + i * 0.11 + rng.random() * 0.02, 0.35, rng.random() - 0.5)
add(click(), 31.4, 0.5)
add(whoosh(0.6), 32.0, 0.25)
add(chime((880, 1318.5)), 33.0, 0.25)
add(whoosh(0.6), 34.0, 0.25)
add(chime((1318.5, 1760, 2637)), 34.4, 0.3)
add(whoosh(0.8, False), 35.6, 0.3)
for i in range(4): add(thud(), 36.0 + i * 1.0, 0.35)
add(riser(2.0), 38.0, 0.4)
add(impact(), 40.0, 1.0)
add(pop(600), 40.02, 0.4)
add(chime((1318.5, 1760, 2637, 3520)), 41.6, 0.22)
add(click(), 43.2, 0.5)

# ---------- reverb + master ----------
ir_t = t_arr(2.2)
ir = rng.standard_normal(len(ir_t)) * np.exp(-ir_t * 3.0)
ir = lp(ir, 6000); ir /= np.sqrt(np.sum(ir ** 2))
wetL = fftconvolve(L, ir)[:N] * 0.18; wetR = fftconvolve(R, ir[::-1].copy())[:N] * 0.18
L2 = L + wetL; R2 = R + wetR
# sidechain-ish duck on kicks
duck = np.ones(N)
for b in range(int(46 / BEAT)):
    at = b * BEAT
    if 4 <= at < 36 or 39 <= at < 40:
        i = int(at * SR); n = int(0.22 * SR)
        duck[i:i + n] = np.minimum(duck[i:i + n], 0.65 + 0.35 * np.linspace(0, 1, len(duck[i:i + n])))
L2 *= duck ** 0.6; R2 *= duck ** 0.6
fade = np.ones(N); fs = int(43.5 * SR); fade[fs:] = np.linspace(1, 0, N - fs) ** 1.5
L2 *= fade; R2 *= fade
mix = np.stack([L2, R2], 1)
mix = np.tanh(mix * 1.1) * 0.9
peak = np.max(np.abs(mix)); mix = mix / peak * 0.93
import wave
with wave.open('/tmp/v2/score.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype(np.int16).tobytes())

# ---------- spectrum per frame ----------
mono = mix.mean(1); FPS = 30; win = 4096
edges = np.geomspace(60, 12000, 25)
freqs = np.fft.rfftfreq(win, 1 / SR)
frames = []
for f in range(int(DUR * FPS)):
    c = int(f / FPS * SR); seg = mono[max(0, c - win // 2): c + win // 2]
    if len(seg) < win: seg = np.pad(seg, (0, win - len(seg)))
    mag = np.abs(np.fft.rfft(seg * np.hanning(win)))
    bands = [float(np.log1p(mag[max(1,np.searchsorted(freqs, edges[i])):max(np.searchsorted(freqs, edges[i])+1, np.searchsorted(freqs, edges[i+1]))].mean() * 4)) for i in range(24)]
    frames.append(bands)
arr = np.array(frames); arr = arr / (np.percentile(arr, 98, axis=0) + 1e-6)
arr = np.clip(arr, 0, 1)
rms = np.array([np.sqrt(np.mean(mono[int(f / FPS * SR): int((f + 1) / FPS * SR)] ** 2)) for f in range(int(DUR * FPS))])
rms = np.clip(rms / np.percentile(rms, 98), 0, 1)
json.dump({'bands': np.round(arr, 3).tolist(), 'rms': np.round(rms, 3).tolist()}, open('/tmp/v2/spectrum.json', 'w'))
print('ok', peak)
