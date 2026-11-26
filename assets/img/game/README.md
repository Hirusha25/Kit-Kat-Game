# Game sprites (`assets/img/game/`)

Final artwork for **KitKat Dunk the Break**. Every file is a transparent PNG; `manifest.json`
gives each sprite's `src`, logical draw size `w`/`h` on the 1080x1920 stage and `anchor`
(0..1 fractions of the PNG placed at the object position: item centre for falling items,
`(mugX, MUG_RIM_Y)` = centre of the drink surface for the mug). The engine pre-renders each
PNG once at `w x h` (times the page's pixel scale), so a PNG of any pixel size works; only the
manifest numbers matter.

| Manifest key | File | PNG px | Drawn at | Notes |
| --- | --- | --- | --- | --- |
| `mug` | `mug.png` | 920 x 900 | 560 x 548 | Player's mug. Anchor `(0.536, 0.202)` = rim / drink-surface centre, **measured** at (493, 182) px: drink ellipse x 224-762, y 108-256; body bottom at y 810 (0.90). Caught wafers sink behind it, so keep the drink opaque. |
| `mug-splash` | `mug-splash.png` | 920 x 900 | 685 x 670 | Shown for `SPLASH_FRAME_SECONDS` after a catch. The mug is framed ~18 % smaller in this PNG (rim 488 px wide vs 607, rim centre at (467, 345), bottom at 872), so it gets its own size and anchor `(0.508, 0.383)` to line up with `mug` on screen. If you re-export it at the same framing as `mug.png`, copy the `mug` entry. |
| `wafer` | `wafer.png` | 180 x 440 | 100 x 245 | +1. Rotated +/-30 deg while falling. |
| `gold` | `wafer-gold.png` | 180 x 440 | 100 x 245 | +3 bonus wafer (gold foil); gets a sparkle trail and a sparkle burst on catch. |
| `wafer-piece` | `wafer-piece.png` | 120 x 120 | 50 x 50 | Crumb particle in the catch splash. |
| `splash-drop` | `splash-drop.png` | 60 x 80 | 26 x 35 | Droplet particle (spins, falls with gravity). |
| `sparkle` | `sparkle.png` | 64 x 64 | 40 x 40 | Gold trail / burst particle and the ambient floating motes. |
| `alarm` | `alarm.png` | 300 x 300 | 170 x 170 | Hazard (-1, stun, streak reset). |
| `deadline` | `deadline.png` | 300 x 300 | 170 x 170 | Hazard. |
| `phone` | `phone.png` | 300 x 300 | 170 x 170 | Hazard. |
| `orders` | `orders.png` | 300 x 300 | 170 x 170 | Hazard (kitchen order rail). |
| `traffic` | `traffic.png` | 300 x 300 | 170 x 170 | Hazard (cone + car + hourglass). |

Hazards rotate: the engine picks uniformly among whichever of `TUNING.HAZARDS` loaded from a PNG
(no immediate repeat), so any subset can ship. If none loaded it falls back to the vector
`alarm`/`deadline` drawings. Hazard PNGs are also cut into four quadrants on load for the shatter
effect, so keep the subject roughly centred.

`header-dunk.png`, `digits/`, `prize-*.png` and the `wave-*.webp` files belong to the page, not
to the engine.

The page loads the manifest with:

```js
const manifest = await (await fetch('assets/img/game/manifest.json')).json();
const sprites = await DunkSprites.load(manifest, { scale: pixelScale });
```

Notes

- Keep backgrounds fully transparent; the engine draws on a transparent canvas over the page's
  red background and chocolate wave.
- Do not bake drop shadows wider than ~12 px into the items: the rotated bounding box grows and
  so does the per-frame blit area on the kiosk GPU.
- If a PNG is missing or fails to load, `DunkSprites` draws a vector fallback and logs a
  warning; the game still runs (hazards without a PNG are simply left out of the rotation).
- Changing the mug's framing: measure the new rim centre and body bottom, set the anchor, and
  check `MUG_RIM_Y` in `js/game.js` so the body bottom stays above the slider at y 1575
  (`tests/game/sim.test.js` has a layout assertion for the current mug).
