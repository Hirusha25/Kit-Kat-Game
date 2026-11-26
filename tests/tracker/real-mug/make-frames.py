#!/usr/bin/env python3
"""
Builds detector test frames from photos of the REAL KitKat mug (tests/tracker/real-mug/photos).

Each photo is pasted on a 640x360 "camera frame" so that the mug takes a given share of the frame
height (how far the player stands), then shrunk to the detector's sizes with an area average, the way
the browser shrinks the camera picture. frames.json records where the logo is in each frame; photos
without a logo (blank side, top view) are negatives: nothing may be found in them.

Usage: python3 tests/tracker/real-mug/make-frames.py     (needs Pillow and numpy)
Stills on a plain background only: no hand, no person, no red stall. Kiosk recordings cover those.
"""
import json, os
from PIL import Image
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MUG_SHARE_OF_PHOTO = 0.42          # the mug is about 42% of the photo height in these shots
SHARES = (0.35, 0.25, 0.18, 0.13)  # mug height as a share of the camera frame height
SIZES = ((160, 90), (320, 180))
out = {}
for name in sorted(os.listdir(os.path.join(HERE, 'photos'))):
    im = Image.open(os.path.join(HERE, 'photos', name)).convert('RGB'); W, H = im.size
    a = np.asarray(im).astype(int); r, g, b = a[..., 0], a[..., 1], a[..., 2]; mx = np.maximum(g, b)
    ys, xs = np.nonzero((r > 90) & (r - mx > 40) & (r > 1.8 * mx))
    has_logo = len(xs) > 500
    if has_logo: x0, x1, y0, y1 = [float(np.percentile(v, q)) for v, q in ((xs, 0.5), (xs, 99.5), (ys, 0.5), (ys, 99.5))]
    for share in SHARES:
        s = share * 360 / (H * MUG_SHARE_OF_PHOTO)
        small = im.resize((max(1, round(W * s)), max(1, round(H * s))), Image.LANCZOS)
        frame = Image.new('RGB', (640, 360), (70, 60, 60))
        ox, oy = 320 - small.width // 2, 180 - small.height // 2
        frame.paste(small, (ox, oy))
        for dw, dh in SIZES:
            f = '%s_%02d_%d.png' % (name[:-4], round(share * 100), dw)
            frame.resize((dw, dh), Image.BOX).convert('RGBA').save(os.path.join(HERE, 'frames', f), optimize=True)
            out[f] = {'photo': name, 'share': share, 'width': dw, 'height': dh,
                      'logo': [round((ox + x0 * s) / 640, 4), round((oy + y0 * s) / 360, 4), round((ox + x1 * s) / 640, 4), round((oy + y1 * s) / 360, 4)] if has_logo else None}
json.dump(out, open(os.path.join(HERE, 'frames.json'), 'w'), indent=1)
print(len(out), 'frames')
