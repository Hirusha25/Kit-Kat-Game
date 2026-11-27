#!/usr/bin/env bash
# Runs every test suite. Requires node, python3 (PIL, numpy) and the preinstalled Playwright Chromium.
set -e; cd "$(dirname "$0")/.."
echo "== tracker: synthetic detector tests";  node tests/tracker/detect.test.js
echo "== tracker: photos of the real mug";    node tests/tracker/real-mug.test.js
echo "== tracker: faces are not mugs";        node tests/tracker/face.test.js
echo "== tracker: fake-camera end-to-end";    node tests/tracker/e2e.js
echo "== game: headless simulation";          node tests/game/sim.test.js
echo "== game: frame-rate benchmark";         node tests/game/bench.js
echo "== full page: fake-camera end-to-end";  node tests/e2e/game.e2e.js
echo "ALL GREEN"
