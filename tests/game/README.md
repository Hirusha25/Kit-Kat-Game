# Engine tests (`tests/game/`)

Two checks for the catch-game engine in `js/game.js` / `js/sprites.js`. Neither needs npm
install or a bundler.

## 1. Headless simulation — `sim.test.js`

```bash
node tests/game/sim.test.js
```

Loads `js/game.js` into a Node `vm` context with a stub `window`/`document` (no canvas) and
drives it with `game.advance()` at a tracker-like 30 Hz. It checks:

- pure parts: PRNG determinism, the critically damped spring (no overshoot, settles < 0.6 s),
  the speed/interval ramp endpoints, the catch test edges, the spawn-kind rules;
- a 45 s round with a scripted "perfect" player (follows the lowest wafer, side-steps a bad
  that would land first): ends at `timeLeft === 0` with one `onEnd`, score in the 40..75 band
  (40-seed sweep gives 44..61 on `normal`), zero misses, warm-up is wafers only, no two bads in
  the same lane within 0.8 s, never more than 2 bads in a row, active items never exceed the
  pool, spawn gaps follow the ramp, `catch`/`streak`/`final5` event contracts;
- the same seed reproduces the round exactly, a different seed does not;
- a frozen player (mug never moves) accumulates misses, score never drops below 0;
- a greedy player that chases bads gets hits, stun and `hit` events;
- tracking lost -> `lost` after 2 s and auto-pause, `regained` -> play resumes 0.5 s later,
  `pause()`/`resume()` and `document.hidden` freeze the timer, `destroy()` removes listeners,
  `stop()` reports `durationPlayed` and `stopped: true`.

Exit code is 1 on any failure.

## 2. Benchmark — `bench.html` + `bench.js`

```bash
node tests/game/bench.js                 # 10 s, requires >= 55 fps
node tests/game/bench.js --seconds 20 --min-fps 58
node tests/game/bench.js --reduced       # reducedEffects: true
node tests/game/bench.js --headed        # watch it
```

`bench.js` starts a tiny static server for the repo, opens `tests/game/bench.html` in
Playwright Chromium at 1080x1920 with the real sprites and engine, feeds a synthetic 30 Hz
sine input and prints `avgFrameMs`, `fps`, `p95FrameMs`, `maxFrameMs`, `droppedFrames`
(frames > 25 ms), the per-frame draw-call count and the event tally. It fails when fps is
below the threshold, when the page throws, or when nothing was caught (a broken engine
should not pass by rendering nothing).

`bench.html` also works standalone, which is the quickest way to profile **on the kiosk**:
serve the repo (`python3 -m http.server 8080`) and open
`http://<host>:8080/tests/game/bench.html?seconds=10` on the device. The overlay shows
live fps, frame time, item/particle counts and draw calls. `?manual=1` lets you drive the
mug with the mouse or a finger instead of the sine input; `&reduced=1`, `&difficulty=hard`,
`&seed=123` are also understood.

Reference numbers (this container, headless Chromium software rendering, 10 s):
60.1 fps average, p95 16.9 ms, max 18.5 ms, 0 dropped frames, both with and without
`reducedEffects`. `avgEngineMs` is the engine's own update+render CPU time per frame, which is
the number to watch on the kiosk (the rAF cadence is capped at 60 Hz regardless).

## Tuning

Every gameplay number lives in the `TUNING` object at the top of `js/game.js`. The ones you
are most likely to touch:

| Key | Default | Effect |
| --- | --- | --- |
| `SPEED_START` / `SPEED_END` | 420 / 820 px/s | fall speed at t=0 and t=duration (linear ramp) |
| `SPAWN_START` / `SPAWN_END` | 1.0 / 0.5 s | spawn interval ramp; `SPAWN_JITTER` randomises +/-15 % |
| `WAFERS_ONLY_SECONDS` | 8 | warm-up with no bads |
| `MIX` | 65 / 20 / 15 | wafer / alarm / deadline weights after warm-up |
| `BAD_LANE_COOLDOWN` | 0.8 s | minimum gap between two bads in the same lane |
| `MAX_CONSECUTIVE_BADS` | 2 | global cap on bads in a row |
| `LANES`, `LANE_JITTER`, `SPAWN_PAD` | 5, 0.3, 0 | spawn columns across the mug range (+ optional padding) |
| `CATCH_HALF_FRAC`, `CATCH_BAND` | 0.75, 40 | catch window: `MUG_HALF_WIDTH * frac` wide, rim y +/- band |
| `SPRING_OMEGA` | 22 rad/s | mug follow stiffness; lower = floatier, higher = snappier |
| `STREAK_EVERY`, `STREAK_BONUS` | 3, +1 | streak bonus cadence and size |
| `HIT_PENALTY`, `STUN_SECONDS`, `STUN_BLOCKS_CATCH` | 1, 1.2, false | what a bad costs |
| `LOST_GRACE`, `REGAIN_DELAY` | 2.0, 0.5 s | tracker-lost auto-pause timing |
| `MISS_Y`, `KILL_Y` | 1330, 1560 | where a passed item counts as missed and where it is fully gone (stay above the slider at 1575) |
| `SPLASH_PARTICLES`, `PARTICLE_POOL`, `ITEM_POOL` | 14, 80, 12 | effect budget (`reducedEffects` uses `SPLASH_PARTICLES_REDUCED`) |
| `DIFFICULTY` | easy/normal/hard | multipliers for speed, spawn interval and bad share |

Change a value, re-run `node tests/game/sim.test.js` (the score band and spawn-gap
assertions are derived from `TUNING`, so only the band in the "perfect player" test may need
updating) and `node tests/game/bench.js` if you raised any pool or particle count.

For a quick feel for a change without the page: the sweep used to set the score band is
`node -e` friendly; see `runRound()` in `sim.test.js` for the harness (30 Hz input, scripted
player, `game.advance(1/30)`).
