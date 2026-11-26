# Game sprites (`assets/img/game/`)

Placeholder artwork for **KitKat Dunk the Break**, generated procedurally. Every file is a
transparent PNG at **2x** the size it is drawn on the 1080x1920 stage. Replace any file 1:1
with final artwork of the **same pixel size** and the engine needs no change; if you change a
size, update `w`/`h` (logical draw size = PNG size / 2) in `manifest.json`.

| File | PNG size (2x) | Drawn at | Replace with |
| --- | --- | --- | --- |
| `wafer.png` | 180 x 440 | 90 x 220 | One KitKat finger, **vertical**, milk chocolate, embossed "KitKat". Centre of the PNG = item centre; it is rotated +/-30 deg while falling, so keep ~8 px of transparent margin. |
| `wafer-piece.png` | 80 x 80 | 40 x 40 | A small broken chunk (splash debris). Any orientation. |
| `alarm.png` | 300 x 300 | 150 x 150 | Red twin-bell alarm clock. Visually centred (it is rotated about the PNG centre). |
| `deadline.png` | 300 x 300 | 150 x 150 | Red/white tear-off calendar with a "DEADLINE" header. |
| `mug.png` | 920 x 900 | 460 x 450 | The player's mug, handle on the **left** as in the reference, with the cocoa surface visible inside the rim. The engine places the sprite's `anchor` at `(mugX, rim y = 1195)`. Current anchor: `x: 0.5435, y: 0.23` (rim ellipse centre at 500 x 207 of 920 x 900). After swapping, measure the rim centre in the new PNG and set `anchor = { x: rimX / 920, y: rimY / 900 }`. Everything above the anchor is "inside the cup" and caught wafers sink behind the sprite, so keep the rim ellipse opaque. |
| `splash-drop.png` | 48 x 64 | 24 x 32 | A single chocolate droplet (splash particle). |

`manifest.json` lists each sprite's `src`, logical draw size `w`/`h` and `anchor` (0..1 fractions
of the sprite placed at the object position). The page loads it with:

```js
const manifest = await (await fetch('assets/img/game/manifest.json')).json();
const sprites = await DunkSprites.load(manifest, { basePath: '' });
```

Notes

- Keep backgrounds fully transparent; the engine draws on a transparent canvas over the page's red background and chocolate wave.
- Do not bake drop shadows wider than ~12 px into the items: the rotated bounding box grows and so does the per-frame blit area on the RK3566.
- If a PNG is missing or fails to load, `DunkSprites` draws a vector fallback and logs a warning; the game still runs.
- Regenerate the placeholders from the lead's copy of the generator script if needed; they are not design-approved artwork.
