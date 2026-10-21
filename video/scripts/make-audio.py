import json
import os
import wave

import numpy as np
from scipy.signal import butter, fftconvolve, lfilter, sosfilt

SR = 48000
OUT = r"C:\Users\HP\source\hover-island\video\assets\audio"
VO = r"C:\Users\HP\source\hover-island\video\assets\vo"
os.makedirs(OUT, exist_ok=True)


def read_wav(path):
    with wave.open(path, "rb") as handle:
        data = handle.readframes(handle.getnframes())
        channels = handle.getnchannels()
    audio = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
    if channels == 2:
        audio = audio.reshape(-1, 2)
    return audio


def write_wav(path, audio):
    audio = np.clip(audio, -1.0, 1.0)
    if audio.ndim == 1:
        audio = np.stack([audio, audio], axis=1)
    pcm = (audio * 32767.0).astype(np.int16)
    with wave.open(path, "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes(pcm.tobytes())


def lowpass(sig, cutoff, order=2):
    sos = butter(order, cutoff / (SR / 2), btype="low", output="sos")
    return sosfilt(sos, sig)


def highpass(sig, cutoff, order=2):
    sos = butter(order, cutoff / (SR / 2), btype="high", output="sos")
    return sosfilt(sos, sig)


def bandpass(sig, low, high, order=2):
    sos = butter(order, [low / (SR / 2), high / (SR / 2)], btype="band", output="sos")
    return sosfilt(sos, sig)


def midi(name):
    names = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
    pitch = name[:-1]
    octave = int(name[-1])
    return 440.0 * 2 ** ((names[pitch] + 12 * (octave + 1) - 69) / 12)


def pad_note(freq, seconds, detune_cents=5.0, bright=1.0):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    signal = np.zeros(n, dtype=np.float32)
    for cents in (-detune_cents, 0.0, detune_cents):
        f = freq * 2 ** (cents / 1200)
        phase = (t * f) % 1.0
        saw = 2.0 * phase - 1.0
        signal += saw.astype(np.float32) / 3.0
    signal = lowpass(signal, 700 + 900 * bright)
    # slow chorus drift
    drift = 1.0 + 0.012 * np.sin(2 * np.pi * 0.11 * t + freq)
    signal *= drift
    # amplitude shape
    attack = 0.9
    release = 1.2
    env = np.ones(n, dtype=np.float32)
    a = int(attack * SR)
    r = int(release * SR)
    if a > 0:
        env[:a] = np.linspace(0, 1, a) ** 1.4
    if r > 0:
        env[-r:] *= np.linspace(1, 0, r) ** 1.2
    return signal * env


CHORDS = [
    ["D2", "A2", "C#3", "F#3", "E4"],
    ["B1", "F#2", "A2", "D3", "C#4"],
    ["G1", "D2", "F#2", "B2", "A3"],
    ["A1", "E2", "G2", "C#3", "F#3"],
    ["D2", "A2", "C#3", "F#3", "E4"],
    ["B1", "F#2", "A2", "D3", "C#4"],
    ["G1", "D2", "F#2", "B2", "A3"],
    ["A1", "E2", "G2", "C#3", "F#3"],
]


def music_bed(seconds):
    n = int(seconds * SR)
    left = np.zeros(n, dtype=np.float32)
    right = np.zeros(n, dtype=np.float32)
    step = 4.8
    length = 6.2
    for index, chord in enumerate(CHORDS):
        start = index * step
        if start >= seconds:
            break
        bright = 0.35 + 0.5 * (0.5 + 0.5 * np.sin(index * 0.9))
        for note_index, note in enumerate(chord):
            freq = midi(note)
            if freq > 900:
                continue
            voice = pad_note(freq, length, detune_cents=6.0, bright=bright)
            gain = 0.20 if note_index == 0 else 0.13
            if note_index >= 3:
                gain *= 0.6
            offset = int(start * SR)
            end = min(n, offset + len(voice))
            pan = 0.5 + 0.35 * np.sin(note_index * 1.7 + index)
            left[offset:end] += voice[: end - offset] * gain * (1.05 - pan)
            right[offset:end] += voice[: end - offset] * gain * pan
        # sub
        sub_freq = midi(chord[0]) / 2
        t = np.arange(int(length * SR)) / SR
        sub = np.sin(2 * np.pi * sub_freq * t).astype(np.float32)
        sub *= np.exp(-t * 0.35) * 0.10
        offset = int(start * SR)
        end = min(n, offset + len(sub))
        left[offset:end] += sub[: end - offset]
        right[offset:end] += sub[: end - offset]

    # texture: soft noise with slow filter movement
    rng = np.random.default_rng(7)
    noise = rng.standard_normal(n).astype(np.float32)
    noise = lowpass(noise, 900)
    noise = highpass(noise, 120)
    t = np.arange(n) / SR
    noise *= 0.010 * (0.6 + 0.4 * np.sin(2 * np.pi * 0.07 * t))
    left += noise
    right += noise * 0.92

    # reverb
    ir_n = int(1.9 * SR)
    ir_t = np.arange(ir_n) / SR
    ir = rng.standard_normal((ir_n, 2)).astype(np.float32) * np.exp(-ir_t / 0.55)[:, None]
    ir = np.stack([lowpass(ir[:, 0], 4200), lowpass(ir[:, 1], 4200)], axis=1)
    ir /= np.sqrt((ir**2).sum(axis=0, keepdims=True))
    wet_l = fftconvolve(left, ir[:, 0])[:n]
    wet_r = fftconvolve(right, ir[:, 1])[:n]
    left = 0.82 * left + 0.22 * wet_l
    right = 0.82 * right + 0.22 * wet_r

    # slow global shape: intro and outro
    env = np.ones(n, dtype=np.float32)
    fade_in = int(2.5 * SR)
    fade_out = int(4.0 * SR)
    env[:fade_in] = np.linspace(0, 1, fade_in) ** 1.5
    env[-fade_out:] = np.linspace(1, 0, fade_out) ** 1.5
    left *= env
    right *= env
    peak = max(np.abs(left).max(), np.abs(right).max())
    if peak > 0:
        left *= 0.55 / peak
        right *= 0.55 / peak
    return np.stack([left, right], axis=1)


def duck(music, vo_path):
    vo = read_wav(vo_path)
    if vo.ndim == 2:
        vo = vo.mean(axis=1)
    n = len(music)
    vo = np.pad(vo, (0, max(0, n - len(vo))))[:n]
    # presence envelope
    window = int(0.05 * SR)
    power = np.convolve(vo**2, np.ones(window) / window, mode="same")
    presence = np.clip((10 * np.log10(power + 1e-12) + 42) / 22, 0, 1).astype(np.float32)
    # smooth attack/release
    attack = int(0.06 * SR)
    release = int(0.45 * SR)
    smoothed = np.zeros_like(presence)
    current = 0.0
    for i in range(0, n, 32):
        target = presence[min(i, n - 1)]
        coeff = 1 - np.exp(-32 / (attack if target > current else release))
        current += (target - current) * coeff
        smoothed[i : i + 32] = current
    gain = 1.0 - 0.62 * smoothed
    return music * gain[:, None], smoothed


def place(track, signal, at, gain=1.0):
    start = int(at * SR)
    end = min(len(track), start + len(signal))
    if end <= start:
        return
    track[start:end] += signal[: end - start] * gain


def sfx_track(seconds, events):
    n = int(seconds * SR)
    track = np.zeros(n, dtype=np.float32)
    rng = np.random.default_rng(11)

    def click(gain=0.25):
        length = int(0.035 * SR)
        t = np.arange(length) / SR
        sig = rng.standard_normal(length).astype(np.float32) * np.exp(-t * 160)
        sig = bandpass(sig, 1200, 6000)
        return sig * gain

    def tick(gain=0.18):
        length = int(0.05 * SR)
        t = np.arange(length) / SR
        sig = (np.sin(2 * np.pi * 2200 * t) * 0.6 + rng.standard_normal(length) * 0.4).astype(np.float32)
        return sig * np.exp(-t * 90) * gain

    def impact(gain=0.5):
        length = int(0.9 * SR)
        t = np.arange(length) / SR
        freq = 70 * np.exp(-t * 5) + 38
        sig = np.sin(2 * np.pi * np.cumsum(freq) / SR).astype(np.float32)
        sig += rng.standard_normal(length).astype(np.float32) * np.exp(-t * 18) * 0.35
        sig = lowpass(sig, 180)
        return sig * np.exp(-t * 2.2) * gain

    def whoosh(duration=0.7, gain=0.16):
        length = int(duration * SR)
        t = np.arange(length) / SR
        noise = rng.standard_normal(length).astype(np.float32)
        # three bands crossfading upward
        low = bandpass(noise, 180, 700)
        mid = bandpass(noise, 600, 2200)
        high = bandpass(noise, 1800, 6000)
        shape = np.linspace(0, 1, length) ** 1.5
        sig = low * (1 - shape) + mid * shape * (1 - shape) * 2 + high * shape**2
        env = np.sin(np.pi * np.linspace(0, 1, length)) ** 1.4
        return sig * env * gain

    def chime(gain=0.18):
        length = int(1.6 * SR)
        t = np.arange(length) / SR
        sig = (
            np.sin(2 * np.pi * 880 * t) * 0.5
            + np.sin(2 * np.pi * 1320 * t) * 0.25
            + np.sin(2 * np.pi * 1760 * t) * 0.12
        ).astype(np.float32)
        return sig * np.exp(-t * 3.0) * gain

    for event in events:
        kind = event["kind"]
        at = event["at"]
        gain = event.get("gain", 1.0)
        if kind == "click":
            place(track, click(0.22), at, gain)
        elif kind == "tick":
            place(track, tick(0.16), at, gain)
        elif kind == "impact":
            place(track, impact(0.5), at, gain)
        elif kind == "whoosh":
            place(track, whoosh(0.75, 0.14), at, gain)
        elif kind == "chime":
            place(track, chime(0.16), at, gain)
    return np.stack([track, track], axis=1)


def normalize(path, target_lufs):
    tmp = path + ".tmp.wav"
    os.replace(path, tmp)
    os.system(
        f'ffmpeg -y -v error -i "{tmp}" -af loudnorm=I={target_lufs}:TP=-3:LRA=7 -ar 48000 -ac 2 "{path}"'
    )
    os.remove(tmp)


for name, events in {
    "master-16x9": [
        {"kind": "impact", "at": 0.55, "gain": 0.7},
        {"kind": "click", "at": 1.0, "gain": 0.9},
        {"kind": "tick", "at": 3.3},
        {"kind": "tick", "at": 4.35},
        {"kind": "whoosh", "at": 5.8},
        {"kind": "whoosh", "at": 9.35},
        {"kind": "click", "at": 13.4},
        {"kind": "tick", "at": 17.7},
        {"kind": "tick", "at": 18.6},
        {"kind": "whoosh", "at": 21.55},
        {"kind": "chime", "at": 25.9, "gain": 0.9},
        {"kind": "impact", "at": 27.6, "gain": 0.8},
        {"kind": "chime", "at": 33.3, "gain": 0.8},
        {"kind": "impact", "at": 36.2, "gain": 0.5},
    ],
    "master-9x16": [
        {"kind": "impact", "at": 0.35, "gain": 0.7},
        {"kind": "click", "at": 0.8, "gain": 0.9},
        {"kind": "tick", "at": 3.0},
        {"kind": "tick", "at": 4.05},
        {"kind": "whoosh", "at": 5.5},
        {"kind": "click", "at": 9.32},
        {"kind": "tick", "at": 13.6},
        {"kind": "tick", "at": 14.4},
        {"kind": "whoosh", "at": 17.4},
        {"kind": "chime", "at": 21.6, "gain": 0.9},
        {"kind": "impact", "at": 23.4, "gain": 0.8},
        {"kind": "chime", "at": 29.0, "gain": 0.8},
        {"kind": "impact", "at": 31.75, "gain": 0.5},
    ],
}.items():
    with open(os.path.join(VO, name + ".json"), encoding="utf-8") as handle:
        meta = json.load(handle)
    seconds = meta["duration"]
    bed = music_bed(seconds + 0.2)[: int(seconds * SR)]
    ducked, _ = duck(bed, os.path.join(VO, name + ".wav"))
    music_path = os.path.join(OUT, "music-" + name + ".wav")
    write_wav(music_path, ducked)
    normalize(music_path, -27)

    sfx = sfx_track(seconds, events)
    sfx_path = os.path.join(OUT, "sfx-" + name + ".wav")
    write_wav(sfx_path, sfx)
    normalize(sfx_path, -22)
    print(name, seconds, "music + sfx written")
