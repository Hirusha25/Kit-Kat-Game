# KitKat Dunk the Break — all kiosk screens

Design frame for every screen: **1080 x 1920 px** (scales 2x on the 4K kiosk, so export artwork at **2160 x 3840** where possible).
Numbers match `tests/e2e/screens/all-screens.png`. For each screen, the list says which artwork can be swapped and what stays dynamic (text the code fills in).

| # | Screen | File | Swappable artwork | Dynamic (code-driven) |
| --- | --- | --- | --- | --- |
| 1 | Cover | `index.html` | Background with gold ribbon · logo · title + tagline · mug with wafers and wave · START button artwork | Steam, sparkles, button shine and float |
| 2 | Register (empty) | `register.html` | Background · decoration layer (wafer top right, cup bottom right, wave) · logo · "DUNK THE Break" title · REGISTER button artwork (blank pill, text drawn by code) | Labels, input boxes, consent text, validation messages |
| 3 | Register with keyboard | `register.html` | Same as 2 | On-screen keyboard (styled in CSS, colours can be changed) |
| 4 | Register (filled) | `register.html` | Same as 2 | Filled state: red text, warmer box, green tick on the label |
| 5 | Play code | `register.html` | Same as 2 · PLAY NOW uses the blank pill | Player first name, code letters |
| 6 | Camera check | `game.html` | Background · header logo + title · CONTINUE uses the blank pill | Live camera preview, camera dropdown |
| 7 | Show your mug | `game.html` | Same background · guide box and ring are CSS | Live camera, MUG DETECTED pill, left–right position bar, progress ring |
| 8 | Countdown | `game.html` | HUD pill (CSS, can become artwork) · wave strip | 3-2-1-GO numerals |
| 9 | Gameplay | `game.html` | **Game sprites:** white mug · wafer finger · alarm clock · DEADLINE calendar · chocolate wave strip · single-line "DUNK THE Break" header with sparkle lines | Score, timer, live rank, falling items, splash, "+1 / 3 IN A ROW" popups, position slider |
| 10 | Show the mug (paused) | `game.html` | Same as 9 | Appears when the mug leaves the camera for 2 s |
| 11 | Results with prize | `game.html` | Prize icons (cap, T-shirt) · PLAY AGAIN uses the blank pill | Score count-up, rank today, wafers, best streak, prize name and claim code |
| 12 | Results without prize | `game.html` | Same as 11 | "So Close!" message with the thresholds |
| 13 | Staff setup panel | `game.html` | Not player-facing; no artwork needed | Camera, mirror, sensitivity, calibration, mug sample capture, rewards stock and thresholds, CSV export |

## Rewards logic (adjustable in the setup panel)

- Daily stock: **80 caps and 80 T-shirts**, reset automatically each day.
- Default thresholds: score **12+** wins a cap, **25+** wins a T-shirt. If T-shirts run out, a qualifying player gets a cap; if both run out, the screen says today's prizes are gone.
- Each win shows a claim code (`CAP-XXXX` / `TEE-XXXX`) and is logged with name, mobile and score. Staff can export the day as CSV.

## Game sprite sizes (transparent PNG, 2x)

| Sprite | Pixel size | Notes |
| --- | --- | --- |
| `mug.png` | 920 x 900 | White mug, handle on the left, rim ellipse centre at about 54% across, 23% down |
| `wafer.png` | 180 x 440 | Single KitKat finger, vertical |
| `wafer-piece.png` | 120 x 120 | Broken chunk for the splash |
| `alarm.png` | 300 x 300 | Red twin-bell alarm clock |
| `deadline.png` | 300 x 300 | Red/white calendar with "DEADLINE" header |
| `splash-drop.png` | 60 x 80 | Chocolate droplet |

Drop replacements into `assets/img/game/` with the same file names; no code change is needed.
