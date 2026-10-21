import os
from PIL import Image

SRC = r"C:\Users\HP\source\hover-island\video\assets\ui"
OUT = r"C:\Users\HP\source\hover-island\video\assets\cut"
os.makedirs(OUT, exist_ok=True)

# name -> (left, top, right, bottom) in device pixels of the 2x capture
CROPS = {
    "today": (100, 0, 1820, 1080),
    "controls": (100, 0, 1820, 1080),
    "beam": (100, 0, 1820, 1080),
    "activity": (100, 0, 1820, 1080),
    "calendar": (100, 0, 1820, 1080),
    "visualizer": (100, 0, 1820, 1080),
    "media-widget": (60, 60, 60 + 756, 60 + 860),
    "weather-widget": (60, 60, 60 + 756, 60 + 860),
    "visualizer-a": (60, 60, 60 + 1536, 60 + 860),
    "beam-widget": (60, 60, 60 + 1536, 60 + 860),
    "calendar-widget": (60, 60, 60 + 1536, 60 + 860),
    "controls-widget": (60, 60, 60 + 1536, 60 + 860),
    "ai-widget": (60, 60, 60 + 756, 60 + 860),
    "rest": (60, 0, 60 + 616, 64),
}

for name, box in CROPS.items():
    path = os.path.join(SRC, name + ".png")
    image = Image.open(path).convert("RGBA")
    cropped = image.crop(box)
    # trim fully transparent edges
    alpha = cropped.getchannel("A")
    bbox = alpha.getbbox()
    if bbox:
        cropped = cropped.crop(bbox)
    out = os.path.join(OUT, name + ".png")
    cropped.save(out)
    print(name, cropped.size, "bbox", bbox)
