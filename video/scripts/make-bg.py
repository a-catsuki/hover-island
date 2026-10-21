import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = r"C:\Users\HP\source\hover-island\video\assets\bg"
os.makedirs(OUT, exist_ok=True)


def radial(size, color, radius=None, power=2.0):
    w, h = size
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    cx, cy = w / 2, h / 2
    r = np.sqrt(((x - cx) / (w / 2)) ** 2 + ((y - cy) / (h / 2)) ** 2)
    if radius is None:
        radius = 1.0
    falloff = np.clip(1 - r / radius, 0, 1) ** power
    out = np.zeros((h, w, 4), dtype=np.float32)
    out[..., 0] = color[0]
    out[..., 1] = color[1]
    out[..., 2] = color[2]
    out[..., 3] = falloff * color[3]
    return out


def base(size, cool=(0.16, 0.24, 0.40), warm=(0.45, 0.29, 0.14)):
    w, h = size
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    img = np.zeros((h, w, 3), dtype=np.float32)
    top = np.array([0.042, 0.047, 0.056], dtype=np.float32)
    bottom = np.array([0.024, 0.027, 0.033], dtype=np.float32)
    t = (y / h)[..., None]
    img += top * (1 - t) + bottom * t
    # very subtle horizontal lift
    img += (x / w)[..., None] * np.array([0.002, 0.003, 0.005], dtype=np.float32)
    # cool glow top
    cy = np.exp(-(((x - w * 0.5) / (w * 0.55)) ** 2 + ((y + h * 0.05) / (h * 0.45)) ** 2) * 1.8)
    for channel, level in enumerate(cool):
        img[..., channel] += cy * level * 0.22
    # warm glow bottom right
    wy = np.exp(-(((x - w * 0.88) / (w * 0.45)) ** 2 + ((y - h * 0.88) / (h * 0.45)) ** 2) * 2.2)
    for channel, level in enumerate(warm):
        img[..., channel] += wy * level * 0.12
    # vignette
    r = np.sqrt(((x - w / 2) / (w / 2)) ** 2 + ((y - h / 2) / (h / 2)) ** 2)
    vignette = np.clip(1 - 0.52 * (r / 1.15) ** 2.2, 0.35, 1)
    img *= vignette[..., None]
    return img


def grain(img, sigma=0.012):
    rng = np.random.default_rng(21)
    noise = rng.normal(0, sigma, img.shape[:2]).astype(np.float32)
    return img + noise[..., None]


def save(name, img):
    img = np.clip(img, 0, 1)
    image = Image.fromarray((img * 255).astype(np.uint8))
    image.save(os.path.join(OUT, name + ".png"), optimize=True)
    print(name, image.size)


def desktop(size, portrait=False):
    w, h = size
    img = base(size, cool=(0.20, 0.28, 0.42), warm=(0.55, 0.34, 0.15))
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    if portrait:
        rect = (int(w * 0.06), int(h * 0.28), int(w * 0.94), int(h * 0.95))
    else:
        rect = (int(w * 0.10), int(h * 0.12), int(w * 0.90), int(h * 0.92))
    x0, y0, x1, y1 = rect
    radius = 26
    # window body
    draw.rounded_rectangle(rect, radius=radius, fill=(32, 39, 50, 255))
    # titlebar
    draw.rounded_rectangle((x0, y0, x1, y0 + 48), radius=radius, fill=(28, 33, 42, 255))
    draw.rectangle((x0, y0 + 24, x1, y0 + 48), fill=(28, 33, 42, 255))
    for i, color in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        cx = x0 + 24 + i * 22
        draw.ellipse((cx - 6, y0 + 18, cx + 6, y0 + 30), fill=color + (230,))
    # sidebar
    draw.rounded_rectangle((x0 + 18, y0 + 70, x0 + 280, y1 - 18), radius=16, fill=(32, 39, 50, 255))
    for i in range(7):
        yy = y0 + 96 + i * 38
        draw.rounded_rectangle((x0 + 36, yy, x0 + 246 - (i % 3) * 24, yy + 12), radius=6, fill=(52, 60, 74, 255))
    # main blocks
    draw.rounded_rectangle((x0 + 304, y0 + 70, x1 - 24, y0 + 150), radius=16, fill=(36, 43, 55, 255))
    draw.rounded_rectangle((x0 + 304, y0 + 172, x0 + (x0 + x1) // 2 - 12, y0 + 420), radius=16, fill=(30, 36, 46, 255))
    draw.rounded_rectangle(((x0 + x1) // 2 + 4, y0 + 172, x1 - 24, y0 + 300), radius=16, fill=(32, 39, 50, 255))
    draw.rounded_rectangle(((x0 + x1) // 2 + 4, y0 + 322, x1 - 24, y0 + 470), radius=16, fill=(28, 34, 44, 255))
    draw.rounded_rectangle((x0 + 304, y0 + 444, x0 + (x0 + x1) // 2 - 12, y1 - 18), radius=16, fill=(26, 32, 41, 255))
    # accent lines
    draw.rounded_rectangle((x0 + 328, y0 + 94, x0 + 560, y0 + 104), radius=4, fill=(110, 150, 235, 220))
    draw.rounded_rectangle((x0 + 328, y0 + 116, x0 + 470, y0 + 124), radius=4, fill=(70, 84, 104, 190))
    blurred = layer.filter(ImageFilter.GaussianBlur(18 if portrait else 12))
    canvas = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).convert("RGBA")
    canvas.alpha_composite(blurred)
    # a warm lamp glow over the whole frame
    glow = radial(size, (255, 186, 110, 0.10), radius=0.9, power=2.2)
    gimg = Image.fromarray((np.clip(glow, 0, 1) * 255).astype(np.uint8), "RGBA")
    canvas.alpha_composite(gimg)
    arr = np.asarray(canvas).astype(np.float32)[..., :3] / 255.0
    arr = grain(arr, 0.006)
    save("desktop-" + ("portrait" if portrait else "landscape"), arr)


def paper(size):
    w, h = size
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    base_color = np.array([0.933, 0.914, 0.874], dtype=np.float32)
    img = np.ones((h, w, 3), dtype=np.float32) * base_color
    # warm uneven light
    light = np.exp(-(((x - w * 0.35) / (w * 0.8)) ** 2 + ((y - h * 0.2) / (h * 0.8)) ** 2) * 1.2)
    img += light[..., None] * np.array([0.020, 0.016, 0.008], dtype=np.float32)
    # edge darkening
    r = np.sqrt(((x - w / 2) / (w / 2)) ** 2 + ((y - h / 2) / (h / 2)) ** 2)
    img *= np.clip(1 - 0.10 * (r / 1.2) ** 2, 0.85, 1)[..., None]
    # fiber texture: low frequency + fine grain
    rng = np.random.default_rng(4)
    low = rng.normal(0, 1, (h // 8 + 1, w // 8 + 1)).astype(np.float32)
    low = np.array(Image.fromarray(((low - low.min()) / (low.max() - low.min()) * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC), dtype=np.float32) / 255.0 - 0.5
    img += low[..., None] * 0.012
    img = grain(img, 0.008)
    save("paper-" + ("portrait" if h > w else "landscape"), img)


for size in ((1080, 1920), (1920, 1080)):
    save("bg-" + ("portrait" if size[1] > size[0] else "landscape"), grain(base(size), 0.010))
    paper(size)

desktop((1080, 1920), portrait=True)
desktop((1920, 1080), portrait=False)

# transparent radial glows
for name, color in (("glow-cool", (86, 132, 255, 0.26)), ("glow-warm", (255, 176, 92, 0.22))):
    arr = radial((1200, 1200), color, radius=1.0, power=2.4)
    Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8), "RGBA").save(os.path.join(OUT, name + ".png"))
    print(name)
