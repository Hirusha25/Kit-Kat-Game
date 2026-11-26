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
  the speed/interval ramp endpoints and difficulty multipliers, the catch test edges, the
  spawn-kind rules (`pickKind`: warm-up wafers only, lane cooldown, global hazard cap, gold share
  and gold only after `GOLD_AFTER_SECONDS`), `pickHazard` (uniform, never the same twice in a
  row), the layout (mug body above the slider at y 1575, every spawn lane reachable), and the
  backwards-compatible exports (`KIND.ALARM`, `KIND.DEADLINE`, `BAD_KINDS`);
- a 40 s round with a scripted "perfect" player (follows the lowest good item, side-steps a
  hazard that would land first): ends at `timeLeft === 0` with one `onEnd`, score in the 38..70
  band (40-seed sweep on `normal`: 40..66, median 54), most wafers caught, warm-up is wafers
  only, hazard kinds all come from `TUNING.HAZARDS`, gold ~6 % of spawns after 10 s (12-seed
  aggregate) with every hazard kind appearing and no immediate repeat, no two hazards in the same
  lane within `BAD_LANE_COOLDOWN`, never more than `MAX_CONSECUTIVE_BADS` in a row, crossfires
  only after `CROSSFIRE_AFTER` with the pair exactly `CROSSFIRE_GAP` apart in adjacent lanes (one
  hazard, one wafer), doubles exactly `DOUBLE_GAP` apart, active items never exceed `ITEM_POOL`,
  regular spawn gaps follow the ramp, the `catch` (`kind`/`points`/`score`/`streak`/`x`) /
  `streak` / `final10` / `final5` event contracts, and an exact replay of the score from the
  event stream (gold = +3);
- the same seed reproduces the round exactly, a different seed does not, and
  `reducedEffects: true` never changes gameplay (effects use their own PRNG);
- a frozen centred player accumulates misses, scores 2..32 (40-seed sweep: 4..31, median 12),
  score never drops below 0;
- a greedy player that chases everything gets hits, stun and `hit` events with more than one
  hazard kind;
- easy/normal/hard change the pace and the hazard share; `SPAWN_ONLY_IF_REACHABLE` holds;
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
node tests/game/bench.js --seconds 18 --duration 20 --input perfect   # worst case: final-10 s layer + a catch every second
node tests/game/bench.js --seconds 20 --input perfect --screenshot /tmp/shot.png --shot-at 15 --shot-on catch --shot-delay 70
```

`bench.js` starts a tiny static server for the repo, opens `tests/game/bench.html` in
Playwright Chromium at 1080x1920 with the real sprites and engine, feeds a synthetic 30 Hz
input and prints `avgFrameMs`, `fps`, `p95FrameMs`, `maxFrameMs`, `droppedFrames`
(frames > 25 ms), `avgEngineMs` (update + render CPU time), the per-frame draw-call count and
the event tally. It fails when fps is below the threshold, when the page throws, or when nothing
was caught. Options: `--seed N`, `--difficulty easy|hard`, `--duration S` (round length; the
final-10 s speed lines only appear if the run reaches them), `--input perfect` (scripted player
instead of the sine sweep: streaks, gold catches, splash frames), and `--screenshot file`
with `--shot-at seconds` and optionally `--shot-on catch|hit|streak` + `--shot-delay ms` to
grab a 1080x1920 frame of a specific moment.

`bench.html` also works standalone, which is the quickest way to profile **on the kiosk**:
serve the repo (`python3 -m http.server 8080`) and open
`http://<host>:8080/tests/game/bench.html?seconds=10` on the device. The overlay shows
live fps, frame time, item/particle counts and draw calls. `?manual=1` lets you drive the
mug with the mouse or a finger instead of the sine input; `&input=perfect`, `&reduced=1`,
`&difficulty=hard`, `&seed=123`, `&duration=20` are also understood.

Reference numbers (this container, headless Chromium software rendering, all effects on):

| Run | fps | p95 | max | dropped | max draws |
| --- | --- | --- | --- | --- | --- |
| default (10 s, sine input) | 60.1 | 16.9 ms | ~23 ms | 0 / 598 | 79 |
| `--reduced` | 60.1 | 16.8 ms | ~19 ms | 0 / 598 | 35 |
| `--seconds 18 --duration 20 --input perfect` (final-10 s speed lines + streak rays + a splash every second) | 59.4-59.6 | 18.6 ms | ~26 ms | 1-3 / 1068 | 116 |

`avgEngineMs` stays at ~0.1-0.2 ms in all runs: the engine's own CPU work is negligible and the
frame time here is Chromium's software rasteriser blitting the pre-rendered layers (the ray
quad and the stun vignette are the big ones). On the kiosk GPU these are single textured quads.

## Tuning

Every gameplay and effect number lives in the `TUNING` object at the top of `js/game.js`.

### Layout / mug

| Key | Default | Effect |
| --- | --- | --- |
| `MUG_MIN_X` / `MUG_MAX_X` | 240 / 840 | mug centre range (tracker 0..1 maps to this) |
| `MUG_RIM_Y` | 1180 | y of the drink surface (= `mug` anchor). The body bottom is 382 px lower, so this keeps it above the slider at 1575 |
| `MUG_HALF_WIDTH` | 280 | half of the 560 px mug |
| `CATCH_HALF_FRAC`, `CATCH_BAND` | 0.60, 44 | catch window: `MUG_HALF_WIDTH * frac` (168 px = the drink surface) wide, rim y +/- band |
| `MUG_BOB_AMP` / `MUG_BOB_HZ` | 4 px / 0.8 Hz | idle bob |
| `MUG_TILT_MAX`, `MUG_TILT_SPEED`, `MUG_TILT_SMOOTH` | 6 deg, 900 px/s, 9 | lean into the direction of motion |
| `MUG_RECOIL_PX`, `MUG_RECOIL_TILT`, `MUG_RECOIL_SECONDS` | 22 px, 7 deg, 0.4 s | jolt away from a hazard on hit |
| `SPLASH_FRAME_SECONDS`, `SPLASH_SQUASH` | 0.4 s, 0.06 | `mug-splash` frame after a catch and its 1.0 -> 1.06 -> 1.0 squash |
| `SPRING_OMEGA` | 22 rad/s | mug follow stiffness; lower = floatier, higher = snappier |

### Spawning / difficulty

| Key | Default | Effect |
| --- | --- | --- |
| `SPEED_START` / `SPEED_END` | 480 / 980 px/s | fall speed at t=0 and t=duration (linear ramp) |
| `SPAWN_START` / `SPAWN_END` | 1.0 / 0.45 s | spawn interval ramp; `SPAWN_JITTER` randomises +/-15 % |
| `WAFERS_ONLY_SECONDS` | 6 | warm-up with no hazards |
| `MIX` | wafer 0.55 / hazard 0.45 | weights after warm-up (hazard weight x `DIFFICULTY.bad`); the caps below bring the effective hazard share after warm-up to ~34 % on normal |
| `GOLD_SHARE`, `GOLD_AFTER_SECONDS`, `GOLD_SCORE` | 0.06, 10 s, 3 | gold wafer frequency, start and value |
| `HAZARDS` | alarm, deadline, phone, orders, traffic | hazard rotation (uniform, no immediate repeat); only kinds whose PNG loaded are used, `HAZARD_FALLBACK` otherwise |
| `BAD_LANE_COOLDOWN` | 0.8 s | minimum gap between two hazards in the same lane |
| `MAX_CONSECUTIVE_BADS` | 2 | global cap on hazards in a row |
| `CROSSFIRE_AFTER`, `CROSSFIRE_EVERY`, `CROSSFIRE_JITTER`, `CROSSFIRE_GAP` | 15 s, 6 s, 0.2, 0.25 s | hazard + wafer pair in adjacent lanes (`DIFFICULTY.crossfire` scales the cadence) |
| `DOUBLE_AFTER`, `DOUBLE_CHANCE`, `DOUBLE_GAP` | 4 s, 0.10, 0.2 s | "catch both" wafer pairs |
| `LANES`, `LANE_JITTER`, `SPAWN_PAD` | 5, 0.25, 150 | spawn columns across the mug range widened by `SPAWN_PAD` per side (lanes 180 px apart; keep `SPAWN_PAD` < catch half-width so edge items stay catchable) |
| `SPAWN_ONLY_IF_REACHABLE` | true | stop spawning once an item could not reach the rim before the end |
| `STREAK_EVERY`, `STREAK_BONUS` | 3, +1 | streak bonus cadence and size |
| `HIT_PENALTY`, `STUN_SECONDS`, `STUN_BLOCKS_CATCH`, `STUN_INVULNERABLE` | 1, 1.2, false, true | what a hazard costs |
| `FINAL_FX_SECONDS`, `FINAL_SECONDS` | 10, 5 | `final10` (speed lines, brighter rays) and `final5` events |
| `LOST_GRACE`, `REGAIN_DELAY` | 2.0, 0.5 s | tracker-lost auto-pause timing |
| `MISS_Y`, `KILL_Y` | 1330, 1560 | where a passed item counts as missed and where it is fully gone (stay above the slider at 1575) |
| `DIFFICULTY` | easy / normal / hard | multipliers `{ speed, spawn, bad, crossfire }`: easy 0.85 / 1.2 / 0.7 / 1.6, hard 1.15 / 0.85 / 1.3 / 0.7 |

### Effects / budget

| Key | Default | Effect |
| --- | --- | --- |
| `ITEM_POOL`, `PARTICLE_POOL`, `POPUP_POOL`, `GLOW_POOL`, `FLASH_POOL`, `FRAGMENT_POOL` | 16, 140, 8, 4, 3, 12 | object pools (a 40 s round peaks at ~6 items) |
| `SPLASH_PARTICLES` (`_REDUCED`), `SPLASH_CRUMBS`, `SPLASH_SPEED`, `SPLASH_SPREAD`, `SPLASH_SPIN`, `GRAVITY` | 22 (8), 3, 300-760, 360, 9, 2000 | catch splash: droplets + wafer crumbs with gravity and spin |
| `GOLD_BURST`, `GOLD_TRAIL_EVERY` | 9, 0.05 s | sparkle burst on a gold catch, sparkle trail cadence behind a falling gold wafer |
| `GLOW_SECONDS`, `FLASH_SECONDS`, `POPUP_SECONDS`, `BIG_POPUP_SECONDS`, `POPUP_POP` | 0.35, 0.22, 0.9, 1.3 s, 1.35 | gold ring pulse, radial flash, popup life, "+1" overshoot scale |
| `SHAKE_SECONDS`, `SHAKE_PX` | 0.35 s, 14 px | screen shake on hit (whole canvas translated by a decaying random offset) |
| `FRAGMENT_SECONDS`, `FRAGMENT_SPEED`, `FRAGMENT_SPIN` | 0.6 s, 220-420, 9 | hazard shatter quadrants |
| `TRAIL_GHOSTS`, `TRAIL_SPACING`, `TRAIL_ALPHA`, `TRAIL_MIN_SPEED` | 3, 0.03 s, 0.34, 300 | motion-trail ghosts behind falling items (1 ghost in `reducedEffects`) |
| `ITEM_GLOW_ALPHA` | 0.6 | pre-rendered halo under items (gold for wafers, hot orange for hazards) |
| `RAYS_IDLE_ALPHA`, `RAYS_MIN_STREAK`, `RAYS_FULL_STREAK`, `RAYS_MAX_ALPHA`, `RAYS_ROT_SPEED`, `RAYS_Y_OFFSET`, `RAYS_RADIUS` | 0.2, 3, 7, 0.62, 0.12 rad/s, 150, 600 | light rays behind the play area (one rotating textured quad): always faintly on, brighten and spin faster with the streak and in the final seconds; not in `reducedEffects` |
| `SPEEDLINES_SPEED`, `SPEEDLINES_ALPHA`, `SPEEDLINE_COUNT` | 1100 px/s, 0.55, 34 | final-10 s speed lines (individual streak blits, not a full-stage layer) |
| `MOTES`, `MOTE_ALPHA`, `MOTE_SPEED` | 7, 0.5, 22-48 px/s | ambient sparkle motes (0 in `reducedEffects`) |
| `COMBO_MIN_STREAK`, `COMBO_Y_OFFSET` | 3, 22 | "xN STREAK" meter on the drink surface (pre-rendered per value) |
| `VIGNETTE_RES` | 0.25 | stun vignette texture resolution |

`reducedEffects: true` drops the rays, speed lines, motes and vignette, uses 1 trail ghost and
`SPLASH_PARTICLES_REDUCED`; it never changes gameplay (verified by the sim test).

Change a value, re-run `node tests/game/sim.test.js` (the score bands and spawn-gap assertions
are derived from `TUNING`, so only the bands in the "perfect player" / "frozen player" tests may
need updating) and `node tests/game/bench.js` if you raised any pool, particle or layer count.

For a quick feel for a change without the page, see `runRound()` in `sim.test.js` for the
harness (30 Hz input, scripted player, `game.advance(1/30)`); a 40-seed sweep of
perfect/frozen scores per difficulty is a short loop over it.
