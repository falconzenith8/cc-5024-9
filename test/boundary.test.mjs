// Boundary regressions for the two places where direction is ambiguous:
// the periodic +/-180 meridian and the poles.
//
// Every test below uses a pattern that is a known function of direction, so
// the expected value at a texel is computable rather than "whatever the
// filter happened to produce". They fail on the pre-fix code:
//
//  * even-N poles sit on a texel corner; atan2(0,0) gave that corner an
//    arbitrary longitude and the footprint unwrap folded the quarter-ring
//    wedge into a bogus 90..180 degree span, so one quadrant leaked into
//    another;
//  * the pole texel's sampled boundary starts one latitude ring inside the
//    texel, so the polar cap rows (including the pole row) were dropped;
//  * bilinear edge sampling clamped stencil taps instead of continuing onto
//    the neighbouring face, leaving a hard step on every cube seam.

import { suite, test, assert } from './harness.mjs';
import {
  FACES,
  texelDirection,
  equirectPixelToDir,
  dirToAngles,
} from '../src/geometry.js';
import {
  ImageDataF,
  equirectToCubeFace,
  cubeToEquirect,
  sampleCubeDirection,
  compareImages,
} from '../src/resample.js';

const DEG = 180 / Math.PI;

/** Image whose value is pattern(direction) sampled at equirect pixel centres. */
function patternImage(W, H, pattern) {
  const data = new Float32Array(W * H * 3);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const c = pattern(...equirectPixelToDir(px, py, W, H));
      const o = (py * W + px) * 3;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
    }
  }
  return new ImageDataF(W, H, 3, data);
}

function wrappedLongitude(x, y, z) {
  const { theta } = dirToAngles(x, y, z);
  return (((theta * DEG) % 360) + 360) % 360; // 0..360, seam at 0 = +180
}

function texelAngles(face, i, j, N) {
  const d = texelDirection(face, i, j, N);
  const { theta, phi } = dirToAngles(...d);
  return { lon: theta * DEG, lat: phi * DEG };
}

/** Four texels that touch an even-N pole (the pole is their shared corner). */
function poleTexels(N) {
  const a = N / 2 - 1;
  return [[a, a], [a + 1, a], [a, a + 1], [a + 1, a + 1]];
}

suite('boundary: meridian and poles');

test('polar footprints are a single quadrant, not a folded half-ring (even N)', () => {
  // White exactly on one 90-degree longitude quadrant, black elsewhere. Each
  // pole-adjacent texel covers exactly one such quadrant, so the four texels
  // must form a permutation: one lit, three dark, for every quadrant. Before
  // the fix two texels carried a quarter of the wrong quadrant.
  const N = 16;
  const W = 2048;
  const H = 1024;
  const quads = [
    [180, 270],
    [270, 360],
    [0, 90],
    [90, 180],
  ];
  const probe = poleTexels(N);
  for (const [lo, hi] of quads) {
    const src = patternImage(W, H, (x, y, z) => {
      const lon = wrappedLongitude(x, y, z);
      const v = lon >= lo && lon < hi ? 255 : 0;
      return [v, v, v];
    });
    const face = equirectToCubeFace(src, 2, N, { filter: 'area' });
    const values = probe.map(([i, j]) => face.data[(j * N + i) * 3]);
    const lit = values.filter((v) => v > 240).length;
    const partial = values.filter((v) => v > 10 && v < 225).length;
    assert.equal(lit, 1, `quadrant ${lo}..${hi}: ${values.map((v) => v.toFixed(1))}`);
    assert.equal(partial, 0, `quadrant ${lo}..${hi} leaks across a pole texel: ${values.map((v) => v.toFixed(1))}`);
  }
});

test('south pole follows the same quadrant mapping as the north pole', () => {
  const N = 16;
  const W = 2048;
  const H = 1024;
  const probe = poleTexels(N);
  for (const [lo, hi] of [[180, 270], [0, 90]]) {
    const src = patternImage(W, H, (x, y, z) => {
      const lon = wrappedLongitude(x, y, z);
      const v = lon >= lo && lon < hi ? 255 : 0;
      return [v, v, v];
    });
    const face = equirectToCubeFace(src, 3, N, { filter: 'area' });
    const values = probe.map(([i, j]) => face.data[(j * N + i) * 3]);
    assert.equal(values.filter((v) => v > 240).length, 1, `south quadrant ${lo}..${hi}: ${values}`);
    assert.equal(values.filter((v) => v > 10 && v < 225).length, 0, `south quadrant ${lo}..${hi}: ${values}`);
  }
});

test('polar texels average the correct longitude quadrant, not a folded one', () => {
  // A longitude ramp wraps continuously at the seam. Each pole-adjacent texel
  // is exactly one 90-degree quadrant, so its mean is the quadrant midpoint.
  // The pre-fix pole-corner fold shifted the two texels whose footprint
  // wrapped across the seam by ~0.28 levels; the correct values are within
  // 0.02 of the analytic mean.
  const N = 16;
  const W = 2048;
  const H = 1024;
  const src = patternImage(W, H, (x, y, z) => {
    const lon = wrappedLongitude(x, y, z);
    const v = (255 * lon) / 360;
    return [v, v, v];
  });
  const face = equirectToCubeFace(src, 2, N, { filter: 'area' });
  for (const [i, j] of poleTexels(N)) {
    const { lon } = texelAngles(2, i, j, N);
    const quadrantStart = Math.floor(((lon % 360) + 360) % 360 / 90) * 90;
    const want = (255 * (quadrantStart + 45)) / 360;
    const got = face.data[(j * N + i) * 3];
    assert.ok(Math.abs(got - want) < 0.05, `texel ${i},${j} lon ${lon.toFixed(1)}: got ${got.toFixed(2)} want ${want.toFixed(2)}`);
  }
});

test('polar cap rows above the first latitude ring reach the pole texels', () => {
  // For odd N the pole is a texel centre, but the sampled texel boundary
  // starts at the first latitude ring inside the texel (~row 9 of 1024).
  // Using that as the footprint extent silently drops every row between it
  // and the pole, including row 0. Paint only those dropped rows: the pole
  // texel must see them. The pre-fix code returned exactly 0 here.
  const N = 17;
  const W = 2048;
  const H = 1024;
  const rowsTop = 8;
  const src = patternImage(W, H, () => [0, 0, 0]);
  for (let py = 0; py < rowsTop; py++) {
    for (let px = 0; px < W; px++) {
      const o = (py * W + px) * 3;
      src.data[o] = src.data[o + 1] = src.data[o + 2] = 255;
    }
  }
  const face = equirectToCubeFace(src, 2, N, { filter: 'area' });
  const c = face.data[(((N - 1) / 2) * N + (N - 1) / 2) * 3];
  assert.ok(c > 15, `central pole texel ignored the polar cap: ${c.toFixed(1)}`);
  assert.ok(c < 40, `central pole texel over-weighted the cap: ${c.toFixed(1)}`);
});

test('even-N pole-adjacent texels also see the polar cap', () => {
  // The four texels around an even-N pole share the pole corner; their
  // quarter-ring wedges must include the cap rows as well.
  const N = 16;
  const W = 2048;
  const H = 1024;
  const rowsTop = 8;
  const src = patternImage(W, H, () => [0, 0, 0]);
  for (let py = 0; py < rowsTop; py++) {
    for (let px = 0; px < W; px++) {
      const o = (py * W + px) * 3;
      src.data[o] = src.data[o + 1] = src.data[o + 2] = 255;
    }
  }
  const face = equirectToCubeFace(src, 2, N, { filter: 'area' });
  for (const [i, j] of poleTexels(N)) {
    const c = face.data[(j * N + i) * 3];
    assert.ok(c > 5 && c < 30, `pole texel ${i},${j} cap contribution ${c.toFixed(1)}`);
  }
});

test('odd-N pole texel is a full ring average (no seam dependence)', () => {
  // For odd N the pole is a texel centre. A source split hard at the +/-180
  // meridian must average to the mean of both halves, regardless of which
  // side of the seam the degenerate point sample would land on.
  const N = 17;
  const W = 512;
  const H = 256;
  const src = patternImage(W, H, (x, y, z) => {
    const lon = wrappedLongitude(x, y, z);
    const v = lon < 180 ? 0 : 255;
    return [v, v, v];
  });
  const face = equirectToCubeFace(src, 2, N, { filter: 'area' });
  const c = face.data[(((N - 1) / 2) * N + (N - 1) / 2) * 3];
  assert.ok(Math.abs(c - 127.5) < 2, `odd-N pole ring ${c.toFixed(2)}`);
});

test('equirect column 0 and column W-1 are adjacent at every latitude', () => {
  // A longitude ramp that is continuous across the seam: the two edge
  // columns must continue into each other through the wrap, not clamp.
  const W = 256;
  const H = 128;
  const src = patternImage(W, H, (x, y, z) => {
    const lon = wrappedLongitude(x, y, z);
    return [lon, 0, 0];
  });
  const faces = [0, 1, 2, 3, 4, 5].map((f) => equirectToCubeFace(src, f, 32, { filter: 'area' }));
  const back = cubeToEquirect(faces, W, H);
  let worst = 0;
  for (let py = 1; py < H - 1; py++) {
    const a = back.data[(py * W + 0) * 3];
    const b = back.data[(py * W + W - 1) * 3];
    // Expected longitude step across the seam is one source column, i.e.
    // 360/W, allowing for the resampling.
    worst = Math.max(worst, Math.abs(a - b) - 360 / W);
  }
  assert.ok(worst < 12, `seam discontinuity ${worst.toFixed(2)} levels above one column`);
});

test('cube->equirect sampling crosses a face edge without a one-sided step', () => {
  // Faces store a linear function of direction sampled at texel centres. A
  // correct sampler reconstructs that function everywhere, including half a
  // texel either side of a cube edge. The old clamp showed a ~0.7 level
  // excess step; the extension-grid sampler stays within the interpolation
  // error of the analytic field.
  const N = 64;
  const field = (x, y, z) => [100 + 120 * x, 100 + 120 * y, 100 + 120 * z];
  const faces = [];
  for (let f = 0; f < 6; f++) {
    const data = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = field(...texelDirection(f, i, j, N));
        const o = (j * N + i) * 3;
        data[o] = c[0];
        data[o + 1] = c[1];
        data[o + 2] = c[2];
      }
    }
    faces.push(new ImageDataF(N, N, 3, data));
  }
  let worst = 0;
  let worstAt = null;
  for (let latDeg = -85; latDeg <= 85; latDeg += 5) {
    for (let lonDeg = -180; lonDeg < 180; lonDeg += 2) {
      const th = (lonDeg * Math.PI) / 180;
      const ph = (latDeg * Math.PI) / 180;
      const cp = Math.cos(ph);
      const dir = [cp * Math.sin(th), Math.sin(ph), cp * Math.cos(th)];
      const want = field(...dir);
      const got = sampleCubeDirection(faces, ...dir);
      const err = Math.max(...got.map((v, k) => Math.abs(v - want[k])));
      if (err > worst) {
        worst = err;
        worstAt = { lonDeg, latDeg };
      }
    }
  }
  assert.ok(worst < 0.2, `worst reconstruction error ${worst.toFixed(3)} at ${JSON.stringify(worstAt)}`);
});

test('seam step on the analytic field matches the analytic gradient', () => {
  // Walking across the +X right edge (x=z) of a field that varies with x/z,
  // the sampled difference between two points half a texel apart must equal
  // the analytic difference. "Copy the edge pixel" would give zero; a
  // one-sided clamp gives a step larger than the gradient allows.
  const N = 64;
  const field = (x, y, z) => [100 + 120 * x, 100 + 120 * y, 100 + 120 * z];
  const faces = [];
  for (let f = 0; f < 6; f++) {
    const data = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = field(...texelDirection(f, i, j, N));
        const o = (j * N + i) * 3;
        data[o] = c[0];
        data[o + 1] = c[1];
        data[o + 2] = c[2];
      }
    }
    faces.push(new ImageDataF(N, N, 3, data));
  }
  const at = (offsetTexels) => {
    const u = 1 - offsetTexels * (2 / N);
    const dir = [1, 0, u].map((c, k) => c / Math.hypot(1, 0, u));
    return { got: sampleCubeDirection(faces, ...dir)[0], want: field(...dir)[0] };
  };
  const left = at(-0.5);
  const right = at(0.5);
  const sampledStep = right.got - left.got;
  const analyticStep = right.want - left.want;
  assert.ok(Math.abs(sampledStep - analyticStep) < 0.1, `step ${sampledStep.toFixed(3)} vs analytic ${analyticStep.toFixed(3)}`);
});

test('round-trip on a smooth direction field keeps seam and pole bands small', () => {
  // End-to-end: encode a direction-linear field, round trip it, and check the
  // worst error within 3 degrees of the meridian seam and of each pole. This
  // is the quantified "direction error and seam difference" regression.
  const W = 512;
  const H = 256;
  const N = 64;
  const field = (x, y, z) => [128 + 70 * x, 128 + 60 * y, 128 + 50 * z];
  const src = patternImage(W, H, field);
  const faces = [0, 1, 2, 3, 4, 5].map((f) => equirectToCubeFace(src, f, N, { filter: 'area' }));
  const back = cubeToEquirect(faces, W, H);
  const m = compareImages(back, src);
  assert.ok(m.psnrDb > 45, `PSNR ${m.psnrDb.toFixed(2)}`);
  assert.ok(m.maxAbs < 0.5, `max abs ${m.maxAbs.toFixed(3)}`);
  let seamMax = 0;
  let poleMax = 0;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const { theta, phi } = dirToAngles(...equirectPixelToDir(px, py, W, H));
      const o = (py * W + px) * 3;
      const e = Math.max(
        Math.abs(back.data[o] - src.data[o]),
        Math.abs(back.data[o + 1] - src.data[o + 1]),
        Math.abs(back.data[o + 2] - src.data[o + 2]),
      );
      const seamDeg = Math.abs((Math.abs(theta) - Math.PI) * DEG);
      const poleDeg = 90 - Math.abs(phi * DEG);
      if (seamDeg < 3) seamMax = Math.max(seamMax, e);
      if (poleDeg < 3) poleMax = Math.max(poleMax, e);
    }
  }
  assert.ok(seamMax < 0.4, `seam band max ${seamMax.toFixed(3)}`);
  assert.ok(poleMax < 0.2, `pole band max ${poleMax.toFixed(3)}`);
});

test('every face edge keeps the analytic field continuous from both sides', () => {
  // Sweep all 24 face edges at several positions and compare the sampler just
  // inside each face with the analytic value. A flipped or mirrored neighbour
  // (or a clamped stencil) would show up as a large error on one side.
  const N = 48;
  const field = (x, y, z) => [128 + 80 * x, 128 + 80 * y, 128 + 80 * z];
  const faces = [];
  for (let f = 0; f < 6; f++) {
    const data = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = field(...texelDirection(f, i, j, N));
        const o = (j * N + i) * 3;
        data[o] = c[0];
        data[o + 1] = c[1];
        data[o + 2] = c[2];
      }
    }
    faces.push(new ImageDataF(N, N, 3, data));
  }
  let worst = 0;
  for (let f = 0; f < 6; f++) {
    const frame = FACES[f];
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      for (let k = 1; k < 8; k++) {
        const t = -1 + (2 * k) / 8;
        const inset = 1 / N;
        let u;
        let v;
        if (edge === 'top') { u = t; v = -1 + inset; }
        else if (edge === 'right') { u = 1 - inset; v = t; }
        else if (edge === 'bottom') { u = -t; v = 1 - inset; }
        else { u = -1 + inset; v = -t; }
        const raw = frame.F.map((c, i) => c + u * frame.R[i] + v * frame.D[i]);
        const len = Math.hypot(...raw);
        const dir = raw.map((c) => c / len);
        const want = field(...dir);
        const got = sampleCubeDirection(faces, ...dir);
        const err = Math.max(...got.map((c, i) => Math.abs(c - want[i])));
        worst = Math.max(worst, err);
      }
    }
  }
  assert.ok(worst < 0.6, `worst edge-inset error ${worst.toFixed(3)}`);
});
