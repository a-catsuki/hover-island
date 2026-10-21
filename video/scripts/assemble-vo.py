import json
import os
import subprocess
import wave

import numpy as np

OUT = r"C:\Users\HP\source\hover-island\video\assets\vo"

with open(os.path.join(OUT, "lines.json"), encoding="utf-8") as handle:
    lines = json.load(handle)
by_key = {line["key"]: line for line in lines}


def read_wav(path):
    with wave.open(path, "rb") as handle:
        assert handle.getframerate() == 48000
        assert handle.getnchannels() == 1
        frames = handle.readframes(handle.getnframes())
    return np.frombuffer(frames, dtype=np.int16)


def build(name, order, lead, gaps, tail):
    chunks = [np.zeros(int(48000 * lead), dtype=np.int16)]
    timing = []
    cursor = lead
    for index, key in enumerate(order):
        line = by_key[key]
        audio = read_wav(line["wav"])
        timing.append(
            {
                "key": key,
                "text": line["text"],
                "start": round(cursor, 3),
                "end": round(cursor + len(audio) / 48000, 3),
            }
        )
        chunks.append(audio)
        cursor += len(audio) / 48000
        gap = tail if index == len(order) - 1 else gaps[index]
        chunks.append(np.zeros(int(48000 * gap), dtype=np.int16))
        cursor += gap
    samples = np.concatenate(chunks)
    raw = os.path.join(OUT, name + "-raw.wav")
    with wave.open(raw, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(48000)
        handle.writeframes(samples.tobytes())
    final = os.path.join(OUT, name + ".wav")
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            raw,
            "-af",
            "loudnorm=I=-16:TP=-1.5:LRA=9",
            "-ar",
            "48000",
            "-ac",
            "1",
            final,
        ],
        check=True,
    )
    meta = {"name": name, "duration": round(len(samples) / 48000, 3), "lines": timing}
    with open(os.path.join(OUT, name + ".json"), "w", encoding="utf-8") as handle:
        json.dump(meta, handle, indent=2)
    print(name, meta["duration"])
    for item in timing:
        print(f"  {item['start']:6.2f}  {item['key']}  {item['text']}")


all_keys = [line["key"] for line in lines]
build(
    "master-16x9",
    all_keys,
    lead=1.0,
    gaps=[0.40, 0.45, 0.35, 0.30, 0.35, 0.35, 0.40, 0.45, 0.45],
    tail=2.4,
)

vertical_keys = [key for key in all_keys if key != "03-surface"]
build(
    "master-9x16",
    vertical_keys,
    lead=0.8,
    gaps=[0.28, 0.30, 0.26, 0.28, 0.30, 0.32, 0.34, 0.36],
    tail=2.0,
)
