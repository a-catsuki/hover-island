import asyncio
import json
import os
import subprocess

import edge_tts

OUT = r"C:\Users\HP\source\hover-island\video\assets\vo"
os.makedirs(OUT, exist_ok=True)

VOICE = "en-US-AndrewNeural"
RATE = "-2%"
PITCH = "-2Hz"

LINES = [
    ("01-hook", "Your PC has a notch now."),
    ("02-not", "Not a widget. Not another window."),
    ("03-surface", "A small, quiet surface at the top of your screen."),
    ("04-hover", "Hover, and it's everything you check a hundred times a day."),
    ("05-music", "Music, with a visualizer that actually listens to your speakers."),
    ("06-glance", "Weather, your calendar, and the controls you reach for."),
    ("07-beam", "Drag a file onto it, and it's on your phone. Same Wi-Fi, one scan, no cloud."),
    ("08-name", "It's called Hover Island. Rust and Tauri. The installer is five megabytes."),
    ("09-free", "Free for Windows 10 and 11."),
    ("10-close", "The notch was always the good part."),
]


async def synth(key, text):
    mp3 = os.path.join(OUT, key + ".mp3")
    communicate = edge_tts.Communicate(text, VOICE, rate=RATE, pitch=PITCH)
    boundaries = []
    with open(mp3, "wb") as handle:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                handle.write(chunk["data"])
            elif chunk["type"] in ("WordBoundary", "SentenceBoundary"):
                boundaries.append(
                    {
                        "type": chunk["type"],
                        "text": chunk["text"],
                        "offset": chunk["offset"],
                        "duration": chunk["duration"],
                    }
                )
    return mp3, boundaries


def duration(path):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", path],
        capture_output=True,
        text=True,
        check=True,
    )
    return float(result.stdout.strip())


async def main():
    manifest = []
    for key, text in LINES:
        mp3, boundaries = await synth(key, text)
        wav = os.path.join(OUT, key + ".wav")
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", mp3, "-ar", "48000", "-ac", "1", wav],
            check=True,
        )
        manifest.append(
            {
                "key": key,
                "text": text,
                "duration": round(duration(wav), 3),
                "mp3": mp3,
                "wav": wav,
                "boundaries": boundaries,
            }
        )
        print(key, round(duration(wav), 3), text)
    with open(os.path.join(OUT, "lines.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
    print("total speech", round(sum(item["duration"] for item in manifest), 3))


asyncio.run(main())
