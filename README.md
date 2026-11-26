# KitKat Hot Cocoa · Got Hotter — kiosk motion game

Browser-based catch game for the KitKat Hot Cocoa launch. The player holds a KitKat mug in front of the kiosk webcam and moves it to catch falling wafers in a mug of hot cocoa. Runs in Chrome on the Android kiosk (RK3566, 1080x1920 portrait) from a home-screen shortcut.

## Screens

| File | Screen |
| --- | --- |
| `index.html` | Cover / attract page with the animated gold START button |
| `register.html` | Registration form with built-in on-screen keyboard, then the play code |
| `game.html` | Calibration, countdown, motion game, results, staff setup panel |

## Run locally

Any static server works. For example:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080/`. The 1080x1920 stage scales to fit the window, so a laptop preview shows the whole kiosk screen.

## Design frame

All screens are laid out on a fixed 1080 x 1920 px stage (`.stage` in `css/style.css`) and scaled to the viewport by `js/stage.js`. Fonts: Cinzel (gold serif), Great Vibes (script), Jost (body). Colours and assets follow the launch invitation and the KitKat Hot Cocoa toolkit; see `reference/brand-notes.txt`.

## Game architecture

| Module | Role |
| --- | --- |
| `js/tracker.js` + `js/tracker-worker.js` | Webcam capture, mug detection (red KitKat oval on the white mug), calibration, smoothed 0..1 position. Pure typed-array detector, runs in a Web Worker. |
| `js/game.js` + `js/sprites.js` | Canvas 2D engine: falling wafers (+1), alarm clocks and deadline calendars (hazards), 3-in-a-row bonus, 45 s timer, pooled sprites, fixed-timestep physics. |
| `js/flow.js` | Page flow: calibrate, countdown, play, lost/regained, results, leaderboard (`localStorage` key `kk_leaderboard`), setup panel. |
| `js/audio.js` | Generated WebAudio sounds, no files. |

Staff setup panel on the game page: press `c` on a keyboard, or tap the logo five times. It selects the camera, mirror, sensitivity, smoothing, camera preview during play, sound, calibration and clearing the leaderboard.

Tests live in `tests/tracker` (synthetic frames, fake camera end-to-end) and `tests/game` (headless simulation, frame-rate benchmark). Each folder has a README.

## Folders

- `assets/img`, `assets/video` — logos, backgrounds, chocolate-wave loop
- `reference/` — drop UI screenshots and design references here
- `css/`, `js/` — shared styles, stage scaler, on-screen keyboard

## Kiosk notes

- Add to Home screen from Chrome; `manifest.json` requests fullscreen portrait.
- Inputs use the built-in keyboard (`js/keyboard.js`); the Android keyboard never opens.
- Registrations are queued in `localStorage` under `kk_players` until the backend endpoint is connected.
