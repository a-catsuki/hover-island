import json
import os
import subprocess

import numpy as np
import soundfile as sf
from faster_whisper import WhisperModel

OUT = r"C:\Users\HP\source\hover-island\video\assets\vo"
SCRIPT = (
    "Your PC has a notch now. Not a widget. Not another window. "
    "A small, quiet surface at the top of your screen. "
    "Hover, and it's everything you check a hundred times a day. "
    "Music, with a visualizer that actually listens to your speakers. "
    "Weather, your calendar, and the controls you reach for. "
    "Drag a file onto it, and it's on your phone. Same Wi-Fi, one scan, no cloud. "
    "It's called Hover Island. Rust and Tauri. The installer is five megabytes. "
    "Free for Windows 10 and 11. The notch was always the good part."
)

model = WhisperModel("base.en", device="cpu", compute_type="int8")


def transcribe(name):
    wav = os.path.join(OUT, name + ".wav")
    small = os.path.join(OUT, name + "-16k.wav")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", wav, "-ar", "16000", "-ac", "1", small], check=True)
    audio, sr = sf.read(small, dtype="float32")
    segments, info = model.transcribe(
        audio,
        language="en",
        beam_size=5,
        word_timestamps=True,
        initial_prompt=SCRIPT,
        condition_on_previous_text=True,
    )
    words = []
    for segment in segments:
        for word in segment.words or []:
            text = word.word.strip()
            if not text:
                continue
            words.append({"text": text, "start": round(word.start, 3), "end": round(word.end, 3)})
    print(name, "words", len(words))
    print(" ".join(w["text"] for w in words))
    return words


def chunk(words):
    chunks = []
    current = []
    for word in words:
        current.append(word)
        text = " ".join(w["text"] for w in current)
        ends = word["text"][-1] in ".,?!:;"
        long = len(text) >= 22
        enough = len(current) >= 4
        gap = False
        if len(current) >= 2:
            gap = word["start"] - current[-2]["end"] > 0.28
        if ends or long or enough or gap:
            chunks.append(
                {
                    "text": text,
                    "start": current[0]["start"],
                    "end": current[-1]["end"],
                }
            )
            current = []
    if current:
        chunks.append(
            {"text": " ".join(w["text"] for w in current), "start": current[0]["start"], "end": current[-1]["end"]}
        )
    return chunks


for name in ("master-16x9", "master-9x16"):
    words = transcribe(name)
    pieces = chunk(words)
    with open(os.path.join(OUT, name + "-captions.json"), "w", encoding="utf-8") as handle:
        json.dump(pieces, handle, indent=2)
    print("chunks", len(pieces))
    for piece in pieces:
        print(f"  {piece['start']:6.2f}-{piece['end']:6.2f}  {piece['text']}")
