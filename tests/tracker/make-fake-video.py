#!/usr/bin/env python3
"""
Writes tests/tracker/fake-mug.y4m: a 640x360 @ 30 fps, 6 s synthetic webcam clip for Chromium's
fake camera (--use-fake-device-for-media-stream --use-file-for-fake-video-capture=<path>).

Scene: red-ish gradient backdrop (KitKat venue), a person (skin + dark shirt) holding the WHITE mug
with the RED oval logo. The logo centre follows x = 0.5 + 0.3 sin(2 pi t / 3) (two full cycles, so
the clip loops seamlessly) with a small vertical bob. A sidecar fake-mug.json records the motion so
tests/tracker/e2e.js can compare the tracked x with the expected sine.

Usage: python3 tests/tracker/make-fake-video.py [out.y4m]
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W, H, FPS, DUR = 640, 360, 30, 6.0
PERIOD, AMP, CX, CY = 3.0, 0.30, 0.5, 0.58
RED = (186, 0, 24)
SKIN = (222, 170, 138)
SHIRT = (38, 48, 88)


def backdrop():
    y = np.linspace(0, 1, H, dtype=np.float32)[:, None]
    x = np.linspace(0, 1, W, dtype=np.float32)[None, :]
    r = 150 - 45 * y + 10 * np.sin(x * 6.0)
    g = 26 - 8 * y + 0 * x
    b = 30 - 10 * y + 0 * x
    vig = 1.0 - 0.35 * ((x - 0.5) ** 2 * 2.2 + (y - 0.5) ** 2 * 1.4)
    img = np.stack([r, g, b], axis=-1) * vig[..., None]
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), 'RGB')


BACK = backdrop()


def draw_frame(t):
    img = BACK.copy()
    d = ImageDraw.Draw(img)
    lx = (CX + AMP * math.sin(2 * math.pi * t / PERIOD)) * W      # logo centre
    ly = CY * H + 6 * math.sin(2 * math.pi * t / 1.5)
    mug_w, mug_h = 96, 112
    mx, my = lx - mug_w / 2, ly - mug_h * 0.45                     # mug top-left

    # person behind the mug, swaying with it
    tx = lx + 25 * math.sin(2 * math.pi * t / PERIOD + 0.6)
    d.ellipse([tx - 150, H * 0.55, tx + 150, H * 1.6], fill=SHIRT)          # torso
    d.ellipse([tx - 52, H * 0.02, tx + 52, H * 0.42], fill=SKIN)            # head
    d.ellipse([tx - 190, H * 0.6, tx - 110, H * 1.3], fill=SKIN)            # far arm
    # forearm + hand coming to the mug from the right
    d.line([tx + 150, H * 1.1, mx + mug_w + 10, my + mug_h * 0.75], fill=SKIN, width=46)

    # mug body with a soft shaded side and a handle
    d.rounded_rectangle([mx, my, mx + mug_w, my + mug_h], radius=14, fill=(248, 246, 242))
    d.rectangle([mx + mug_w * 0.84, my + 8, mx + mug_w - 3, my + mug_h - 10], fill=(214, 211, 206))
    d.ellipse([mx + mug_w - 10, my + 22, mx + mug_w + 34, my + mug_h - 24], fill=(242, 240, 236))
    d.ellipse([mx + mug_w + 2, my + 36, mx + mug_w + 22, my + mug_h - 38], fill=tuple(BACK.getpixel((int(lx) % W, int(ly) % H))))

    # logo: red oval ring, "KitKat"-like strokes, tiny Nestle line above and CHOCOLATE DRINK below
    lw, lh = 54, 34
    d.ellipse([lx - lw / 2, ly - lh / 2, lx + lw / 2, ly + lh / 2], outline=RED, width=5)
    st = 4
    k = lx - 18
    d.line([k, ly - 9, k, ly + 9], fill=RED, width=st)
    d.line([k, ly, k + 7, ly - 9], fill=RED, width=st - 1)
    d.line([k, ly, k + 7, ly + 9], fill=RED, width=st - 1)
    d.line([lx - 6, ly - 10, lx - 6, ly + 9], fill=RED, width=st - 1)       # t
    d.line([lx - 9, ly - 5, lx - 2, ly - 5], fill=RED, width=2)
    d.line([lx + 3, ly - 9, lx + 3, ly + 9], fill=RED, width=st)            # K
    d.line([lx + 3, ly, lx + 10, ly - 9], fill=RED, width=st - 1)
    d.line([lx + 3, ly, lx + 10, ly + 9], fill=RED, width=st - 1)
    d.line([lx + 15, ly - 2, lx + 15, ly + 9], fill=RED, width=st - 1)      # a / t
    d.text((lx - 16, ly - lh / 2 - 11), "Nestle", fill=RED)
    d.text((lx - 27, ly + lh / 2 + 2), "CHOCOLATE", fill=RED)
    d.text((lx - 14, ly + lh / 2 + 12), "DRINK", fill=RED)

    # hand on the mug: thumb over the lower right of the body, fingertips just reaching the logo edge
    d.ellipse([mx + mug_w - 30, my + mug_h * 0.55, mx + mug_w + 26, my + mug_h * 1.05], fill=SKIN)
    d.ellipse([lx + lw / 2 - 6, ly + 2, lx + lw / 2 + 12, ly + 22], fill=SKIN)

    img = img.filter(ImageFilter.GaussianBlur(0.8))   # optical softness
    return np.asarray(img, dtype=np.float32)


def rgb_to_i420(rgb, rng):
    rgb = np.clip(rgb + rng.normal(0, 3.0, rgb.shape).astype(np.float32), 0, 255)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    y = 16 + (65.738 * r + 129.057 * g + 25.064 * b) / 256
    u = 128 + (-37.945 * r - 74.494 * g + 112.439 * b) / 256
    v = 128 + (112.439 * r - 94.154 * g - 18.285 * b) / 256
    sub = lambda c: c.reshape(H // 2, 2, W // 2, 2).mean(axis=(1, 3))
    return (np.clip(y, 16, 235).astype(np.uint8).tobytes() +
            np.clip(sub(u), 16, 240).astype(np.uint8).tobytes() +
            np.clip(sub(v), 16, 240).astype(np.uint8).tobytes())


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fake-mug.y4m')
    rng = np.random.default_rng(7)
    n = int(round(FPS * DUR))
    with open(out, 'wb') as f:
        f.write(('YUV4MPEG2 W%d H%d F%d:1 Ip A1:1 C420jpeg\n' % (W, H, FPS)).encode())
        for i in range(n):
            f.write(b'FRAME\n')
            f.write(rgb_to_i420(draw_frame(i / FPS), rng))
    meta = {'width': W, 'height': H, 'fps': FPS, 'duration': DUR, 'frames': n,
            'motion': {'period': PERIOD, 'amp': AMP, 'cx': CX, 'cy': CY,
                       'formula': 'x = cx + amp * sin(2*pi*t/period), unmirrored frame coordinates'}}
    with open(os.path.splitext(out)[0] + '.json', 'w') as f:
        json.dump(meta, f, indent=2)
    print('wrote %s (%d frames, %.1f MB) and %s' % (out, n, os.path.getsize(out) / 1e6, os.path.splitext(out)[0] + '.json'))


if __name__ == '__main__':
    main()
