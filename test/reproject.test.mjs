// Panorama reprojection: direction-known checks for the projection kernel.
//
// The module renders the cubemap through a selectable camera using the same
// repaired sampler as cube->equirect. These tests pin down:
//   * rays are orthonormal cameras (rectilinear) or correct lon/lat maps;
//   * a direction-encoded cubemap decodes back to the requested ray;
//   * a smooth field round-trips without a seam step;
//   * seam polylines project where geometry says the cube edges are.

import { suite, test, assert } from './harness.mjs';
import { FACES, dirToAngles, dirToFaceUV } from '../src/geometry.js';
import {
  PROJECTION_IDS,
  cameraBasis,
  rayForPixel,
  projectDirection,
  renderReprojection,
  measureReprojection,
  evaluateReprojection,
  REPROJECTION_LIMITS,
  seamPolylines,
  makeDirectionFaces,
  makeAnalyticFaces,
} from '../src/reproject.js';
import { ImageDataF } from '../src/resample.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function angleBetween(a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.max(-1, Math.min(1, d))) * RAD;
}

suite('reprojection');

test('camera basis is orthonormal and forward matches yaw/pitch', () => {
  for (const [yaw, pitch] of [[0, 0], [2.1, 0.6], [-1.2, -1.3], [Math.PI, 1.5]]) {
    const { C, R, U } = cameraBasis(yaw, pitch);
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    assert.ok(Math.abs(dot(C, R)) < 1e-12, `C.R ${dot(C, R)}`);
    assert.ok(Math.abs(dot(C, U)) < 1e-12, `C.U ${dot(C, U)}`);
    assert.ok(Math.abs(dot(R, U)) < 1e-12, `R.U ${dot(R, U)}`);
    assert.ok(Math.abs(Math.hypot(...C) - 1) < 1e-12);
    // Right-handed image frame: R x U points along the view direction.
    const cross = [R[1] * U[2] - R[2] * U[1], R[2] * U[0] - R[0] * U[2], R[0] * U[1] - R[1] * U[0]];
    assert.ok(dot(cross, C) > 0, 'camera frame is not right-handed');
    assert.ok(Math.abs(C[1] - Math.sin(pitch)) < 1e-9, `pitch component ${C[1]}`);
  }
});

test('rectilinear rays follow the pinhole model and hit the centre ray', () => {
  const W = 320;
  const H = 180;
  const yaw = 0.7;
  const pitch = -0.35;
  const fovDeg = 70;
  const { C } = cameraBasis(yaw, pitch);
  const centre = rayForPixel('rectilinear', (W - 1) / 2, (H - 1) / 2, W, H, { yaw, pitch, fovDeg });
  assert.ok(angleBetween(centre, C) < 1e-6, `centre ray ${angleBetween(centre, C)}`);
  // The vertical fov is exactly fovDeg between the top and bottom edge rays.
  const top = rayForPixel('rectilinear', W / 2 - 0.5, 0, W, H, { yaw, pitch, fovDeg });
  const bottom = rayForPixel('rectilinear', W / 2 - 0.5, H - 1, W, H, { yaw, pitch, fovDeg });
  const span = Math.acos(Math.max(-1, Math.min(1, top[0] * bottom[0] + top[1] * bottom[1] + top[2] * bottom[2]))) * RAD;
  // Pixel centres, so the extremes are one pixel short of the full fov.
  assert.ok(span < fovDeg && span > fovDeg - (fovDeg / H) * 2, `vertical span ${span}`);
});

test('equirectangular rays use the documented pixel-centre convention', () => {
  const W = 360;
  const H = 180;
  for (const [px, py] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [123, 45]]) {
    const dir = rayForPixel('equirectangular', px, py, W, H, { yaw: 0, pitch: 0 });
    const { theta, phi } = dirToAngles(...dir);
    const wantLon = -Math.PI + (2 * Math.PI * (px + 0.5)) / W;
    const wantLat = Math.PI / 2 - (Math.PI * (py + 0.5)) / H;
    assert.ok(Math.abs(theta - wantLon) < 1e-12, `lon ${theta} vs ${wantLon}`);
    assert.ok(Math.abs(phi - wantLat) < 1e-12, `lat ${phi} vs ${wantLat}`);
  }
});

test('projectDirection inverts rayForPixel for both projections', () => {
  const W = 200;
  const H = 120;
  for (const projection of PROJECTION_IDS) {
    for (const [yaw, pitch, fovDeg] of [[0, 0, 75], [1.3, 0.5, 55], [-2.2, -0.9, 100]]) {
      for (const px of [3, W / 2 - 0.5, W - 8]) {
        for (const py of [2, H / 2 - 0.5, H - 5]) {
          const dir = rayForPixel(projection, px, py, W, H, { yaw, pitch, fovDeg });
          // Equirectangular rays clamp latitude at the poles by design, so a
          // view panned past +-90 latitude is not a bijection there.
          if (projection === 'equirectangular') {
            const baseLat = Math.PI / 2 - (Math.PI * (py + 0.5)) / H;
            if (Math.abs(baseLat + pitch) > Math.PI / 2 - 1e-9) continue;
          }
          const p = projectDirection(projection, dir, W, H, { yaw, pitch, fovDeg });
          assert.ok(p.visible && p.inFrame, `${projection} pixel ${px},${py} not visible`);
          assert.ok(Math.abs(p.px - px) < 1e-6, `${projection} px ${p.px} vs ${px}`);
          assert.ok(Math.abs(p.py - py) < 1e-6, `${projection} py ${p.py} vs ${py}`);
        }
      }
    }
  }
});

test('equirectangular latitude clamps at the poles instead of overflowing', () => {
  const W = 200;
  const H = 120;
  // A large upward pitch pushes the top rows past +90 latitude.
  const top = rayForPixel('equirectangular', W / 2 - 0.5, 0, W, H, { yaw: 0, pitch: 1.0 });
  const { phi } = dirToAngles(...top);
  assert.ok(phi <= Math.PI / 2 + 1e-12, `latitude ${phi} exceeds the pole`);
  assert.ok(phi >= Math.PI / 2 - 1e-6, `top row should clamp to the pole, got ${phi}`);
});

test('direction-encoded cubemap decodes back to the requested ray', () => {
  const N = 128;
  const faces = makeDirectionFaces(N);
  for (const projection of PROJECTION_IDS) {
    const W = 96;
    const H = 54;
    const view = { projection, yaw: 0.9, pitch: 0.4, fovDeg: 80, width: W, height: H };
    const img = renderReprojection(faces, view);
    let worst = 0;
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const want = rayForPixel(projection, px, py, W, H, view);
        const o = (py * W + px) * 3;
        const got = [img.data[o] / 127.5 - 1, img.data[o + 1] / 127.5 - 1, img.data[o + 2] / 127.5 - 1];
        const len = Math.hypot(...got);
        worst = Math.max(worst, angleBetween(got.map((c) => c / len), want));
      }
    }
    assert.ok(worst < 0.3, `${projection} direction error ${worst.toFixed(4)}°`);
  }
});

test('uniform cube renders uniform under both projections and any rotation', () => {
  const N = 32;
  const faces = Array.from({ length: 6 }, () => new ImageDataF(N, N, 3, new Float32Array(N * N * 3).fill(64)));
  for (const projection of PROJECTION_IDS) {
    for (const [yaw, pitch] of [[0, 0], [2.5, 1.1], [-1.7, -1.5]]) {
      const img = renderReprojection(faces, { projection, width: 40, height: 24, yaw, pitch, fovDeg: 90 });
      let min = Infinity;
      let max = -Infinity;
      for (const v of img.data) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      assert.ok(max - min < 1e-4, `${projection} ${yaw},${pitch}: ${min}..${max}`);
    }
  }
});

test('smooth-field reprojection has no seam step and passes the documented limits', () => {
  for (const projection of PROJECTION_IDS) {
    for (const [yaw, pitch, fovDeg] of [[0, 0, 75], [2.4, 0.7, 60], [-1.1, -1.2, 110]]) {
      const m = measureReprojection({ faceSize: 96, projection, yaw, pitch, fovDeg });
      assert.ok(m.direction.maxAngleDeg <= REPROJECTION_LIMITS.maxDirectionErrorDeg, `${projection} dir ${m.direction.maxAngleDeg}`);
      assert.ok(m.seam.excess <= REPROJECTION_LIMITS.maxSeamExcess, `${projection} seam excess ${m.seam.excess}`);
      assert.ok(m.seamPosition.points > 0, 'no seam points measured');
      assert.ok(m.seamPosition.maxRoundTripDeg <= REPROJECTION_LIMITS.maxSeamPositionErrorDeg, `${projection} seam pos ${m.seamPosition.maxRoundTripDeg}`);
      const verdict = evaluateReprojection(m);
      assert.deepEqual(verdict, { ok: true, reasons: [] }, `${projection} ${JSON.stringify(m)}`);
    }
  }
});

test('evaluateReprojection rejects a bad measurement instead of defaulting to ok', () => {
  assert.equal(evaluateReprojection(null).ok, false);
  const bad = {
    direction: { maxAngleDeg: 5 },
    seam: { excess: 2 },
    seamPosition: { maxRoundTripDeg: 0.01, points: 1 },
  };
  const verdict = evaluateReprojection(bad);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reasons.length, 3);
  // A NaN must not read as a pass.
  const nan = {
    direction: { maxAngleDeg: NaN },
    seam: { excess: 0 },
    seamPosition: { maxRoundTripDeg: 0, points: 1 },
  };
  assert.equal(evaluateReprojection(nan).ok, false);
});

test('seam polylines lie on cube edges and project inside the camera', () => {
  const lines = seamPolylines();
  assert.equal(lines.length, 12, '12 undirected cube edges');
  for (const line of lines) {
    for (const dir of line.dirs) {
      const hit = dirToFaceUV(...dir);
      const edge = Math.max(Math.abs(hit.u), Math.abs(hit.v));
      assert.ok(Math.abs(edge - 1) < 1e-12, `edge lies at ${edge}`);
    }
  }
  // Every seam point in a wide view projects back to the same direction.
  const W = 240;
  const H = 135;
  const view = { yaw: 0.4, pitch: 0.3, fovDeg: 120 };
  let count = 0;
  for (const line of lines) {
    for (const dir of line.dirs) {
      const p = projectDirection('rectilinear', dir, W, H, view);
      if (!p.inFrame) continue;
      const back = rayForPixel('rectilinear', p.px, p.py, W, H, view);
      assert.ok(angleBetween(back, dir) < 1e-5, `seam point moved ${angleBetween(back, dir)}`);
      count++;
    }
  }
  assert.ok(count > 20, `only ${count} seam points in frame`);
});

test('analytic faces expose the direction the patch expects', () => {
  const faces = makeAnalyticFaces(16);
  const N = 16;
  for (let f = 0; f < 6; f++) {
    for (const [i, j] of [[0, 0], [N - 1, N - 1], [7, 8]]) {
      const u = -1 + (2 * (i + 0.5)) / N;
      const v = -1 + (2 * (j + 0.5)) / N;
      const frame = FACES[f];
      const d = frame.F.map((c, k) => c + u * frame.R[k] + v * frame.D[k]);
      const len = Math.hypot(...d);
      const want = [128 + 80 * (d[0] / len), 128 + 80 * (d[1] / len), 128 + 80 * (d[2] / len)];
      const o = (j * N + i) * 3;
      for (let c = 0; c < 3; c++) {
        assert.ok(Math.abs(faces[f].data[o + c] - want[c]) < 1e-5, `face ${f} texel ${i},${j} ch ${c}`);
      }
    }
  }
});
