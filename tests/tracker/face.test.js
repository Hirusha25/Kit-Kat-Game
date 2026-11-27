// A bright face must not read as the mug: a reddish nose / lips on skin is "red on light" but skin is
// warm (R well above G) while the mug's white is neutral. Synthetic faces at both detector sizes, several
// skin tones and lighting, in lock-on mode (the permissive "show your mug" parameters) and with defaults.
// Run: node tests/tracker/face.test.js
var T = require('../../js/tracker.js');
var acquire = T.acquireParams(T.defaultParams); acquire.threshold = 0.56;
var plain = Object.assign({}, T.defaultParams, { threshold: 0.56 });

function face(W, H, skin, noseRed, lipRed) {
  var data = new Uint8ClampedArray(W * H * 4), cx = W / 2, cy = H / 2, rx = W * 0.14, ry = H * 0.42;
  for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
    var i = (y * W + x) * 4, c = [92, 18, 24]; // dark red room behind
    var dx = (x - cx) / rx, dy = (y - cy) / ry;
    if (dx * dx + dy * dy < 1) {
      var shade = 1 - 0.25 * Math.max(0, dx);  // lit from the left
      c = [skin[0] * shade, skin[1] * shade, skin[2] * shade];
      var nx = (x - cx) / (rx * 0.22), ny = (y - (cy + ry * 0.08)) / (ry * 0.16);   // nose tip
      if (nx * nx + ny * ny < 1) c = noseRed;
      var lx = (x - cx) / (rx * 0.42), ly = (y - (cy + ry * 0.42)) / (ry * 0.09); // lips
      if (lx * lx + ly * ly < 1) c = lipRed;
    }
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  return { data: data, width: W, height: H };
}
var skins = [[236, 196, 176], [222, 176, 150], [205, 155, 125], [245, 215, 200]];
var noses = [[214, 120, 110], [200, 96, 92], [226, 132, 124]];
var lips = [[198, 84, 92], [210, 100, 108]];
var fails = 0, n = 0;
[[160, 90], [320, 180]].forEach(function (sz) {
  skins.forEach(function (sk) { noses.forEach(function (no) { lips.forEach(function (li) {
    var img = face(sz[0], sz[1], sk, no, li);
    [['lock-on', acquire], ['defaults', plain]].forEach(function (m) {
      n++; var r = T.detect(img, m[1]);
      if (r.found) { fails++; console.log('  FAIL ' + sz.join('x') + ' ' + m[0] + ': face skin ' + sk.join(',') + ' nose ' + no.join(',') + ' found as the mug at (' + r.x.toFixed(2) + ', ' + r.y.toFixed(2) + ') score ' + r.score.toFixed(2)); }
    });
  }); }); });
});
console.log('synthetic faces: ' + (n - fails) + ' of ' + n + ' correctly rejected');
if (fails) process.exit(1);
console.log('ALL PASSED');
