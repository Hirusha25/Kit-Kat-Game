# KitKat Hot Cocoa · Got Hotter — kiosk motion game

Browser-based catch game for the KitKat Hot Cocoa launch. The player holds a KitKat mug in front of the kiosk webcam and moves it to catch falling wafers in a mug of hot cocoa. Runs in Chrome on the Android kiosk (RK3566, 1080x1920 portrait) from a home-screen shortcut.

## Screens

| File | Screen |
| --- | --- |
| `index.html` | Cover / attract page with the animated gold START button |
| `register.html` | Registration form with built-in on-screen keyboard, then the play code |
| `game.html` | Motion game (next) |

## Run locally

Any static server works. For example:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080/`. The 1080x1920 stage scales to fit the window, so a laptop preview shows the whole kiosk screen.

## Design frame

All screens are laid out on a fixed 1080 x 1920 px stage (`.stage` in `css/style.css`) and scaled to the viewport by `js/stage.js`. Fonts: Cinzel (gold serif), Great Vibes (script), Jost (body). Colours and assets follow the launch invitation and the KitKat Hot Cocoa toolkit; see `reference/brand-notes.txt`.

## Folders

- `assets/img`, `assets/video` — logos, backgrounds, chocolate-wave loop
- `reference/` — drop UI screenshots and design references here
- `css/`, `js/` — shared styles, stage scaler, on-screen keyboard

## Kiosk notes

- Add to Home screen from Chrome; `manifest.json` requests fullscreen portrait.
- Inputs use the built-in keyboard (`js/keyboard.js`); the Android keyboard never opens.
- Registrations are queued in `localStorage` under `kk_players` until the backend endpoint is connected.
