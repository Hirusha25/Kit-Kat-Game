# MugTracker — webcam tracking of the KitKat mug

`js/tracker.js` finds the white KitKat mug (red oval logo on a white body) in the kiosk webcam
feed and reports its horizontal position 30 times a second. Pure JavaScript on typed arrays, no
TensorFlow / MediaPipe / OpenCV, sized for the RK3566 kiosk: the detector works on a 160x90
downscale (configurable up to 320x180) and runs in about 0.2 ms per frame on a laptop.

## Files

| File | Role |
| --- | --- |
| `js/tracker.js` | `window.MugTracker`: the pure detector (`detect`), the page tracker (`create`), `listCameras`, `defaultParams` |
| `js/tracker-worker.js` | Web Worker that runs the same `detect` off the main thread (loads `tracker.js` with `importScripts`) |
| `tests/tracker/synth.js` | synthetic frame renderer used by the unit test |
| `tests/tracker/detect.test.js` | accuracy, false-positive and speed test of `detect` (plain Node) |
| `tests/tracker/make-fake-video.py` | renders `fake-mug.y4m` (+ `fake-mug.json`), a 640x360 clip for Chromium's fake camera |
| `tests/tracker/harness.html` | page that starts the tracker and logs its states (used by e2e, handy with a real camera) |
| `tests/tracker/e2e.js` | Playwright end-to-end test: real Chromium, fake camera, worker + inline paths, calibration |

`fake-mug.y4m` is 62 MB of raw video. It is generated on demand by `e2e.js` and should be
git-ignored (`tests/tracker/fake-mug.y4m`, `tests/tracker/fake-mug.json`), not committed.

## Using it in a page

```html
<video id="cam" hidden playsinline muted></video>
<script src="js/tracker.js"></script>
<script>
  const tracker = MugTracker.create({ video: document.getElementById('cam'), width: 160, height: 90,
                                      mirror: true, useWorker: true, smoothing: 0.35, lostAfterMs: 600 });
  tracker.onUpdate = (s) => {
    // s.x is 0..1, mirrored (moving right moves right on screen) and smoothed; s.found false after
    // lostAfterMs without a detection, but s.x keeps the last position so the cup does not jump.
    cup.style.left = (s.x * 1080) + 'px';
  };
  tracker.start({ facingMode: 'user' })           // or { deviceId } from MugTracker.listCameras()
    .catch(err => showError(err.code, err.message)); // 'no-camera' | 'denied' | 'in-use' | 'error'
</script>
```

State object passed to `onUpdate` every processed frame:

```
{ found, x, y, rawX, rawY, frameX, frameY, w, h, confidence, fps, lastSeenMs, ts, redArea, whiteRatio }
```

* `x, y` smoothed (EMA, `smoothing` = share of the previous value, 0 = no smoothing), mirrored when `mirror`.
* `rawX, rawY` the last unsmoothed detection in the same (mirrored) space; `frameX, frameY` the same
  in unmirrored frame coordinates; `w, h` the logo box size as a fraction of the frame.
* `confidence` the detector score 0..1 (0 once lost); `fps` processed frames per second.

Other methods: `calibrate(roi)` (see below), `setOptions({sensitivity, mirror, smoothing, width, height, lostAfterMs})`,
`getOptions()`, `getParams()`, `setParams(partial)`, `resetParams()`, `getState()`, `stop()`,
`debugDraw(ctx2d, w, h)` (mirrored frame + detection box + score line, for the calibration screen and
the setup panel). `MugTracker.listCameras()` resolves `[{deviceId, label}]` (labels appear after the
first permission grant). The pure function `MugTracker.detect(imageData, params)` is usable anywhere,
including Node; its result object is reused between calls.

The worker is used when `useWorker` is true and `Worker` exists; if the worker file fails to load the
tracker silently falls back to inline detection (`getOptions().usingWorker` tells which is active).
The worker URL is derived from the `tracker.js` script URL (`js/tracker-worker.js`); pass `workerUrl`
to `create` when the files are served from somewhere else. Frames are skipped, never queued, when the
worker is still busy.

## Algorithm

Per frame, on the downscaled RGBA image (one pass over the pixels, union-find labelling, zero
allocations after warm-up):

1. **Masks.** A pixel is *red* when `R > redMin`, `R - max(G,B) > redDelta` and `R > redRatio * max(G,B)`
   (the ratio test rejects skin, wood and orange, which pass a plain difference test). A pixel is *white*
   when `min(R,G,B) > whiteMin` and `max - min < whiteSpread`. Integral images of the white and red masks
   are built in the same pass so any rectangle's white/red count is O(1) later.
2. **Components.** Red pixels are labelled with 8-connected union-find; the second pass accumulates area
   and bounding box per component. The 48 largest become candidates.
3. **Merging.** Candidates whose boxes are within `mergeGapFrac` of the frame width (3 px at 160) are
   merged on a copy, so both the fragments and their union are scored. A logo split by a finger wins as
   the union; a logo next to a red shirt wins on its own.
4. **Scoring.** Each candidate with area in `[minAreaFrac, maxAreaFrac]` of the frame and a box no wider
   than `maxBoxFrac` of the width is scored:
   * **white ring (0.55)** — fraction of white pixels in the ring made by growing the box by `ringExpand`
     (60%, at least `ringMin` = 2 px), measured per side with the worst side dropped (a hand or the
     "CHOCOLATE DRINK" line on one side does not hide the mug body on the other three; a side cut off by
     the frame edge is never the dropped one). Red in the 2 px border right around the box means the
     candidate is a piece of something bigger (clothing, backdrop) and is subtracted with
     `redRingPenalty`; above 25% the candidate is discarded.
   * **aspect (0.12)** — the oval is wider than tall: 1 within `[aspectMin, aspectMax]` = `[1.0, 2.2]`,
     slivers (< 0.45) and bars (> 4.5) are discarded.
   * **area (0.08)** — near the calibrated `refAreaFrac`, or simply "not tiny" before calibration.
   * **fill (0.08)** — ring + letters fill 25–78% of the box; solid blobs score lower.
   * **inner white (0.08)** — the central half of the box contains white between the letters; a solid
     red object has none (only judged on boxes of 60 px or more).
   * **temporal (0.09)** — closeness to the previous detection (`temporalRange`).
   
   The weights make a red blob with no white around it top out at 0.45, below any reachable threshold,
   so red clothing or a red backdrop alone can never be "the mug". The best candidate is returned when
   its score reaches `threshold`.

`sensitivity` (0..1, default 0.5) maps to `threshold = 0.47 + 0.16 * (1 - sensitivity)` (0.63 .. 0.47).

## Calibration

`await tracker.calibrate({x, y, w, h})` (ROI normalised in screen space, default the central
0.4 x 0.6 area) samples 15 frames in which a logo is found inside the ROI with deliberately loose
thresholds, collects histograms of R, R - max(G,B) and R / max(G,B) over the red pixels of the logo and
of min(R,G,B) and max - min over the white pixels around it, and sets:

* `redMin` = 0.7 x 15th percentile of R, `redDelta` = 0.5 x 15th percentile of the difference,
  `redRatio` = 0.6 x 15th percentile of the ratio (clamped 1.8..4);
* `whiteMin` = 0.85 x 15th percentile of min(R,G,B), `whiteSpread` = 1.3 x 85th percentile of the spread + 12
  (clamped 40..90);
* `refAreaFrac` = median logo area, `minAreaFrac` = 0.2 x that, `maxAreaFrac` = 6 x that.

It resolves `{ok, samples, params}` (`ok:false` with `reason: 'logo-not-found' | 'no-frames'` after 90
frames / 5 s without enough samples). Parameters are saved in `localStorage['kk_tracker_params']` and
loaded by `create`; `resetParams()` goes back to `MugTracker.defaultParams`.

Calibrate with the mug held where players will stand (1.5–2.5 m), logo facing the camera, after the
venue lighting is final. Recalibrate if the lights change.

## Running the tests

```bash
node tests/tracker/detect.test.js        # synthetic accuracy + false positives + benchmark, ~2 s
node tests/tracker/detect.test.js -v     # also lists the failing seeds
node tests/tracker/e2e.js                # Chromium + fake camera, ~40 s (renders fake-mug.y4m if missing)
node tests/tracker/e2e.js --headed       # watch it
python3 tests/tracker/make-fake-video.py # just render the clip
```

Both scripts exit 1 on failure. `detect.test.js` asserts found rate >= 95% and mean |x error| <= 0.03 on
200 frames at 160x90 and 200 at 320x180 (random backgrounds including red and white, red/white clothing,
40% finger occlusion), false positives <= 2% on 100 frames of red clothing without a mug, and < 2 ms per
160x90 frame. `e2e.js` asserts >= 90% found, correlation > 0.9 between the tracked x and the sine the clip
was rendered with (phase fitted, frequency fixed), a plausible amplitude, mirroring, the worker path,
calibration success and persistence, and that `stop()`/`start()` work.

Current numbers (this environment): 100% / 100% found, mean |dx| 0.003, 1% false positives, 0.2 ms per
160x90 frame and 0.6 ms per 320x180 frame in Node; in Chromium 30 fps processed, 100% found, correlation
1.000 in worker, inline and 320x180 modes.

To try a real camera: serve the repo (`python3 -m http.server 8080`) and open
`http://localhost:8080/tests/tracker/harness.html?worker=1&w=160&h=90` (needs localhost or https for
`getUserMedia`). It shows `debugDraw` and the live state.

## Tuning for the venue

* **Logo size.** At 160x90 the logo of a mug 2.5 m from a typical webcam is only 4–5 px wide, which is
  at the limit (`minAreaFrac` 0.0004 = 6 px). If players stand far away, use `width: 320, height: 180`
  (0.6 ms per frame, still cheap on the kiosk) or zoom/crop the camera. Calibration at the real distance
  sets `refAreaFrac` and the area window, which also sharpens rejection of other red things.
* **Lighting.** Calibrate under the final lights; strong warm light pushes the mug's white towards
  yellow (raise `whiteSpread`), dim light lowers R of the logo (lower `redMin`). If the camera's auto
  white balance makes the logo orange-ish, lower `redRatio` to 1.8 (calibration does this when it sees it).
* **Backgrounds.** A red backdrop is fine (the mug body separates the logo from it). Avoid a plain
  white wall directly behind the players: a solid red object of logo size on a white wall (a cap, a cup)
  is "a red blob surrounded by white" and will be detected when nothing better is in view. The temporal
  bonus and `lostAfterMs` make the game stick to the mug once it has been found.
* **Clothing.** Red clothing and white clothing are handled; a red print of logo size on a white shirt
  is the one lookalike this signal cannot separate from the mug. Shape (aspect, fill, inner white) and
  calibration size help; raising `sensitivity` lowers the threshold, lowering it demands a cleaner match.
* **Smoothing and loss.** `smoothing` 0.35 keeps the cup responsive at 30 fps; raise it for a calmer cup.
  `lostAfterMs` 600 keeps the cup in place over a short occlusion; after that `found` goes false (show a
  "show the mug" hint) while `x` keeps the last value.
* **Mirror.** Keep `mirror: true` for a camera facing the player; set it false for a camera behind them.
* **Diagnostics.** `tracker.getState()` and `debugDraw` show the detection; `redArea` and `whiteRatio`
  in the state tell whether the red mask or the white ring is the weak link (`whiteRatio` well below 0.6
  with the mug in view means `whiteMin`/`whiteSpread` are too strict for the light; `redArea` 0 means the
  red thresholds are).

## Limitations

* Single mug: the best-scoring candidate is reported; two mugs in view resolve to one (temporal
  proximity keeps it on the first one).
* No depth; the logo must face the camera (a mug turned 90 degrees shows no logo and is lost after
  `lostAfterMs`).
* Logo-sized solid red objects surrounded by white (see above).
