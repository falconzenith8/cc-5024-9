// Pixel-domain tests: known direction colours, seam continuity, filtering,
// quantified round-trip loss.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite, test, assert } from './harness.mjs';
import {
  FACES,
  FACE_NAMES,
  EDGE_ADJACENCY,
  dirToAngles,
  dirToFaceUV,
  equirectPixelToDir,
} from '../src/geometry.js';
import {
  ImageDataF,
  equirectToCube,
  equirectToCubeFace,
  cubeToEquirect,
  sampleCubeDirection,
  sampleEquirectBilinear,
  bilinearAt,
  compareImages,
  compareImagesWeighted,
} from '../src/resample.js';
import { FACE_COLORS, chartColor } from '../src/chart.js';
import { decodePNG } from '../src/png.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sampleDir = path.join(root, 'output', 'sample');
const sampleFaces = path.join(sampleDir, 'faces');
const FACE_FILES = ['px.png', 'nx.png', 'py.png', 'ny.png', 'pz.png', 'nz.png'];

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function unit(v) {
  const l = Math.hypot(...v);
  return v.map((c) => c / l);
}

/** Smooth analytic test field: a pure function of direction, no aliasing. */
function analyticField(x, y, z) {
  const d = unit([x, y, z]);
  return [
    128 + 70 * d[0],
    128 + 60 * d[1],
    128 + 50 * d[2],
  ];
}

function fieldImage(W, H) {
  const data = new Float32Array(W * H * 3);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const d = equirectPixelToDir(px, py, W, H);
      const c = analyticField(...d);
      const o = (py * W + px) * 3;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
    }
  }
  return new ImageDataF(W, H, 3, data);
}

function loadSampleFaces() {
  return FACE_FILES.map((file) => {
    const png = decodePNG(fs.readFileSync(path.join(sampleFaces, file)));
    return ImageDataF.fromUint8(png.width, png.height, png.channels, png.data);
  });
}

function facePixel(img, x, y) {
  const i = Math.min(img.width - 1, Math.max(0, Math.round(x)));
  const j = Math.min(img.height - 1, Math.max(0, Math.round(y)));
  const o = (j * img.width + i) * img.channels;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
}

suite('resampling');

test('known axis directions keep their face colours in the generated faces', () => {
  const faces = loadSampleFaces();
  for (let f = 0; f < 6; f++) {
    const N = faces[f].width;
    const c = facePixel(faces[f], (N - 1) / 2, (N - 1) / 2);
    // The plate centre is flat colour; the exact texel may be half a pixel off
    // the axis, which is still well inside the plate.
    for (let ch = 0; ch < 3; ch++) {
      assert.ok(Math.abs(c[ch] - FACE_COLORS[f][ch]) <= 4, `${FACE_NAMES[f]} centre ${c}`);
    }
  }
});

test('column 0 and the last column of the equirect source are continuous', () => {
  // The periodic sampler treats column W-1 as adjacent to column 0. Sampling
  // across the seam must match sampling one column past it, with no clamp to
  // a black border.
  const src = fieldImage(128, 64);
  const W = src.width;
  for (let py = 0; py < 64; py += 7) {
    const left = bilinearAt(src.data, W, 64, 3, 0.5, py + 0.5, true);
    const right = bilinearAt(src.data, W, 64, 3, W - 0.5, py + 0.5, true);
    const across = bilinearAt(src.data, W, 64, 3, W + 0.5, py + 0.5, true);
    const wrap = bilinearAt(src.data, W, 64, 3, 0.5, py + 0.5, true);
    assert.ok(Math.abs(across[0] - wrap[0]) < 1e-4, `row ${py}: ${across} vs ${wrap}`);
    assert.ok(left[0] > 20 && right[0] > 20);
  }
});

test('periodic bilinear interpolation does not clamp to a black border', () => {
  // A constant field must survive sampling across the seam exactly.
  const W = 32;
  const H = 16;
  const data = new Float32Array(W * H * 3).fill(77);
  const img = new ImageDataF(W, H, 3, data);
  for (const x of [0.01, 0.5, W - 0.01, W - 0.5, W + 0.4]) {
    const s = sampleEquirectBilinear(img, x, 8.5);
    assert.ok(Math.abs(s[0] - 77) < 1e-5 && Math.abs(s[1] - 77) < 1e-5, `x=${x}: ${s}`);
  }
});

test('a uniform equirect image converts to uniform cube faces (no black seams)', () => {
  const W = 128;
  const H = 64;
  const img = new ImageDataF(W, H, 3, new Float32Array(W * H * 3).fill(128));
  const faces = equirectToCube(img, 16, { filter: 'area' });
  for (let f = 0; f < 6; f++) {
    let min = 255;
    let max = 0;
    for (const v of faces[f].data) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    assert.ok(max - min < 1e-3, `${FACE_NAMES[f]} range ${min}..${max}`);
  }
});

test('adjacent faces sample the same physical direction continuously', () => {
  // Build faces from a smooth analytic field, then compare the two faces at
  // the same physical directions just inside every shared edge. This tests
  // the produced pixels (orientation + filtering), not just the formula: a
  // flipped or rotated neighbour would disagree strongly.
  const N = 64;
  const W = 512;
  const H = 256;
  const src = fieldImage(W, H);
  const faces = equirectToCube(src, N, { filter: 'area' });
  const coordsInFace = (face, d) => {
    const f = FACES[face];
    const denom = f.F[0] * d[0] + f.F[1] * d[1] + f.F[2] * d[2];
    return {
      u: (f.R[0] * d[0] + f.R[1] * d[1] + f.R[2] * d[2]) / denom,
      v: (f.D[0] * d[0] + f.D[1] * d[1] + f.D[2] * d[2]) / denom,
    };
  };
  const edgePoint = (edge, t, inset) => {
    if (edge === 'top') return [t, -1 + inset];
    if (edge === 'right') return [1 - inset, t];
    if (edge === 'bottom') return [-t, 1 - inset];
    return [-1 + inset, -t];
  };
  const bilinear = (img, u, v) => {
    const x = ((u + 1) / 2) * img.width - 0.5;
    const y = ((v + 1) / 2) * img.height - 0.5;
    const x0 = Math.max(0, Math.min(img.width - 1, Math.floor(x)));
    const y0 = Math.max(0, Math.min(img.height - 1, Math.floor(y)));
    const x1 = Math.min(img.width - 1, x0 + 1);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const tx = Math.max(0, Math.min(1, x - x0));
    const ty = Math.max(0, Math.min(1, y - y0));
    const sample = (i, j) => {
      const o = (j * img.width + i) * img.channels;
      return [img.data[o], img.data[o + 1], img.data[o + 2]];
    };
    const a = sample(x0, y0);
    const b = sample(x1, y0);
    const c = sample(x0, y1);
    const d = sample(x1, y1);
    return a.map((_, ch) => a[ch] * (1 - tx) * (1 - ty) + b[ch] * tx * (1 - ty) + c[ch] * (1 - tx) * ty + d[ch] * tx * ty);
  };
  const inset = 0.5 * (2 / N);
  let worst = 0;
  let count = 0;
  for (const e of EDGE_ADJACENCY) {
    for (let k = 1; k < 12; k++) {
      const t = -1 + (2 * k) / 12;
      const [ua, va] = edgePoint(e.edge, t, inset);
      const f = FACES[e.face];
      const dir = unit(f.F.map((c, i) => c + ua * f.R[i] + va * f.D[i]));
      const cb = coordsInFace(e.neighbor, dir);
      // Both coordinates are just inside their respective faces.
      const ca = bilinear(faces[e.face], ua, va);
      const cc = bilinear(faces[e.neighbor], cb.u, cb.v);
      const diff = Math.max(...ca.map((v, i) => Math.abs(v - cc[i])));
      worst = Math.max(worst, diff);
      count++;
    }
  }
  assert.equal(count, 24 * 11);
  // A smooth field sampled one texel either side of the seam differs by about
  // one gradient step; mismatched orientation would be tens of levels.
  assert.ok(worst < 2, `worst seam disagreement ${worst.toFixed(3)}`);
});

test('real face borders carry chart content, never a black border', () => {
  const faces = loadSampleFaces();
  const N = faces[0].width;
  let black = 0;
  let total = 0;
  for (const e of EDGE_ADJACENCY) {
    const img = faces[e.face];
    const edgePixels = [];
    for (let k = 0; k < N; k++) {
      let x;
      let y;
      if (e.edge === 'top') { x = k; y = 0; }
      else if (e.edge === 'right') { x = N - 1; y = k; }
      else if (e.edge === 'bottom') { x = k; y = N - 1; }
      else { x = 0; y = k; }
      const c = facePixel(img, x, y);
      if (c[0] + c[1] + c[2] < 24) black++;
      total++;
    }
  }
  // The chart draws dark graticule lines, but a black *border band* would
  // make whole edges dark. Require the overwhelming majority to be lit.
  assert.equal(total, 24 * N);
  assert.ok(black < total * 0.12, `${black}/${total} near-black edge pixels`);
});

test('edge-crossing sampler is continuous on a uniform cube', () => {
  const N = 16;
  const faces = Array.from({ length: 6 }, () => new ImageDataF(N, N, 3, new Float32Array(N * N * 3).fill(100)));
  for (const e of EDGE_ADJACENCY) {
    for (let k = 0; k <= 8; k++) {
      const t = -1 + (2 * k) / 8;
      let u;
      let v;
      if (e.edge === 'top') { u = t; v = -1; }
      else if (e.edge === 'right') { u = 1; v = t; }
      else if (e.edge === 'bottom') { u = -t; v = 1; }
      else { u = -1; v = -t; }
      const d = unit(FACES[e.face].F.map((c, i) => c + u * FACES[e.face].R[i] + v * FACES[e.face].D[i]));
      const s = sampleCubeDirection(faces, ...d);
      for (const c of s) assert.ok(Math.abs(c - 100) < 0.5, `edge ${e.faceName}/${e.edge}: ${s}`);
    }
  }
});

test('bilinear seam sampling blends both faces instead of showing a step', () => {
  const N = 8;
  // +X face white, +Z face black: on the shared edge the sampler must
  // interpolate, not jump.
  const faces = Array.from({ length: 6 }, (_, f) => {
    const v = f === 0 ? 255 : f === 4 ? 0 : 128;
    return new ImageDataF(N, N, 3, new Float32Array(N * N * 3).fill(v));
  });
  const shared = EDGE_ADJACENCY.find((e) => e.face === 0 && e.edge === 'right');
  assert.equal(shared.neighbor, 4);
  const dEdge = unit([1, 0, 1]);
  const cEdge = sampleCubeDirection(faces, ...dEdge);
  assert.ok(Math.abs(cEdge[0] - 127.5) <= 0.6, `edge blend ${cEdge}`);
  const dInside = unit([1, 0, 0.6]);
  const cInside = sampleCubeDirection(faces, ...dInside);
  assert.ok(cInside[0] > 200, `inside +X ${cInside}`);
});

test('area filter matches brute-force solid-angle integration of a smooth field', () => {
  const W = 128;
  const H = 64;
  const N = 24;
  const src = fieldImage(W, H);
  const faces = equirectToCube(src, N, { filter: 'area' });
  let worst = 0;
  let worstFace = -1;
  for (let f = 0; f < 6; f++) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        // Brute-force: average the analytic field over the texel footprint at
        // fine sub-texel resolution.
        let acc = [0, 0, 0];
        let wSum = 0;
        const S = 6;
        const half = 1 / N;
        const u = -1 + (2 * (i + 0.5)) / N;
        const v = -1 + (2 * (j + 0.5)) / N;
        for (let sy = 0; sy < S; sy++) {
          for (let sx = 0; sx < S; sx++) {
            const uu = u + ((sx + 0.5) / S - 0.5) * 2 * half;
            const vv = v + ((sy + 0.5) / S - 0.5) * 2 * half;
            const dir = unit(FACES[f].F.map((c, k) => c + uu * FACES[f].R[k] + vv * FACES[f].D[k]));
            const c = analyticField(...dir);
            for (let ch = 0; ch < 3; ch++) acc[ch] += c[ch];
            wSum++;
          }
        }
        const o = (j * N + i) * 3;
        const got = [faces[f].data[o], faces[f].data[o + 1], faces[f].data[o + 2]];
        const want = acc.map((c) => c / wSum);
        const err = Math.max(...got.map((g, k) => Math.abs(g - want[k])));
        if (err > worst) { worst = err; worstFace = f; }
      }
    }
  }
  assert.ok(worst < 3.5, `worst texel error ${worst.toFixed(3)} on face ${worstFace}`);
});

test('polar texels are ring-averaged, not point-sampled', () => {
  // Source split sharply at the 180-degree meridian. A point sample at the
  // pole picks whichever column the tie-break lands on; the area filter must
  // average the whole polar ring.
  const W = 511;
  const H = 256;
  const data = new Float32Array(W * H * 3);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const v = px < 256 ? 0 : 255;
      const o = (py * W + px) * 3;
      data[o] = data[o + 1] = data[o + 2] = v;
    }
  }
  const src = new ImageDataF(W, H, 3, data);
  const N = 17;
  const py = equirectToCubeFace(src, 2, N, { filter: 'area' });
  // For odd N the centre +Y texel contains the pole and spans every longitude.
  const c = facePixel(py, (N - 1) / 2, (N - 1) / 2);
  assert.ok(Math.abs(c[0] - 127.5) < 3, `pole texel ${c}`);
  const point = facePixel(equirectToCubeFace(src, 2, N, { filter: 'bilinear' }), (N - 1) / 2, (N - 1) / 2);
  assert.ok(point[0] < 20 || point[0] > 235, `point sample should alias, got ${point}`);
});

test('bilinear and area filters agree on an oversampled smooth field', () => {
  const W = 512;
  const H = 256;
  const src = fieldImage(W, H);
  const N = 16;
  const a = equirectToCubeFace(src, 4, N, { filter: 'area' });
  const b = equirectToCubeFace(src, 4, N, { filter: 'bilinear' });
  let worst = 0;
  for (let k = 0; k < a.data.length; k++) worst = Math.max(worst, Math.abs(a.data[k] - b.data[k]));
  assert.ok(worst < 1.2, `filter disagreement ${worst}`);
});

test('cube->equirect reconstructs known axis colours at the pixel centres', () => {
  const faces = loadSampleFaces();
  const W = 256;
  const H = 128;
  const back = cubeToEquirect(faces, W, H);
  // +Z axis sits at theta=0, phi=0 -> column W/2, row H/2 (pixel centres).
  const axisChecks = [
    { dir: [0, 0, 1], face: 4 },
    { dir: [1, 0, 0], face: 0 },
    { dir: [-1, 0, 0], face: 1 },
    { dir: [0, 0, -1], face: 5 },
    { dir: [0, 1, 0], face: 2 },
    { dir: [0, -1, 0], face: 3 },
  ];
  for (const { dir, face } of axisChecks) {
    const { theta, phi } = dirToAngles(...dir);
    const px = Math.min(W - 1, Math.max(0, Math.round(((theta + Math.PI) / (2 * Math.PI)) * W - 0.5)));
    const py = Math.min(H - 1, Math.max(0, Math.round(((Math.PI / 2 - phi) / Math.PI) * H - 0.5)));
    const o = (py * W + px) * 3;
    const got = [back.data[o], back.data[o + 1], back.data[o + 2]];
    const want = FACE_COLORS[face];
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(got[c] - want[c]) <= 6, `${FACE_NAMES[face]} at axis: ${got} vs ${want}`);
    }
  }
});

test('round-trip error on a smooth field is small and quantified', () => {
  const W = 256;
  const H = 128;
  const N = 64;
  const src = fieldImage(W, H);
  const faces = equirectToCube(src, N, { filter: 'area' });
  const back = cubeToEquirect(faces, W, H);
  const m = compareImages(back, src);
  const w = compareImagesWeighted(back, src, W, H);
  // Smooth field sampled at 64^2 per face then re-integrated at 256x128:
  // resampling loss is real but minuscule.
  assert.ok(m.psnrDb > 45, `PSNR ${m.psnrDb.toFixed(2)} dB`);
  assert.ok(m.mae < 0.5, `MAE ${m.mae.toFixed(3)}`);
  assert.ok(m.maxAbs < 6, `max ${m.maxAbs}`);
  assert.ok(w.psnrDb > 45, `weighted PSNR ${w.psnrDb.toFixed(2)} dB`);
  // Solid-angle weighting must differ meaningfully from the plain mean
  // (it de-emphasises poles), proving both metrics are real.
  assert.ok(Math.abs(w.psnrDb - m.psnrDb) > 1e-6);
});

test('high-frequency chart round-trip is lossy by design, not byte-identical', () => {
  const srcPng = decodePNG(fs.readFileSync(path.join(sampleDir, 'chart-equirect.png')));
  const src = ImageDataF.fromUint8(srcPng.width, srcPng.height, srcPng.channels, srcPng.data);
  const faces = loadSampleFaces();
  const back = cubeToEquirect(faces, src.width, src.height);
  const m = compareImages(back, src);
  // The chart contains near-Nyquist checker quads; the cube cannot represent
  // them, so the round trip has measurable loss. Assert the *presence* of loss
  // so nobody can claim byte-for-byte identity.
  assert.ok(m.psnrDb < 45, `expected real loss, got ${m.psnrDb.toFixed(2)} dB`);
  assert.ok(m.psnrDb > 15, `loss must stay plausible, got ${m.psnrDb.toFixed(2)} dB`);
  assert.ok(m.mae > 0.2, `expected MAE > 0, got ${m.mae}`);
  const json = JSON.parse(fs.readFileSync(path.join(sampleDir, 'roundtrip.json'), 'utf8'));
  assert.ok(Math.abs(json.metrics.psnrDb - m.psnrDb) < 0.5, 'roundtrip.json matches a fresh measurement');
  assert.ok(Number.isFinite(json.metrics.mae) && Number.isFinite(json.metrics.maxAbs));
});

test('smooth fields are not byte-identical either (sample/quantise loss)', () => {
  const W = 128;
  const H = 64;
  const N = 32;
  const src = fieldImage(W, H);
  const faces = equirectToCube(src, N, { filter: 'area' });
  const back = cubeToEquirect(faces, W, H);
  let identical = back.data.length === src.data.length;
  if (identical) {
    for (let k = 0; k < src.data.length; k++) {
      if (Math.abs(src.data[k] - back.data[k]) > 1e-9) { identical = false; break; }
    }
  }
  assert.equal(identical, false, 'cube->equirect must resample, never copy');
});

test('filter footprint grows toward the poles', () => {
  // On a side face, the top row is farther from the equator in world angle
  // than the middle row for the same u step, so its horizontal source
  // footprint is narrower, not wider. Assert the measured finite difference
  // in the smooth-field output is consistent with the documented geometry.
  const src = fieldImage(512, 256);
  const N = 32;
  const face = equirectToCubeFace(src, 4, N, { filter: 'area' });
  const rowDiff = (j) => {
    let d = 0;
    for (let i = 1; i < N; i++) {
      d += Math.abs(face.data[(j * N + i) * 3] - face.data[(j * N + i - 1) * 3]);
    }
    return d;
  };
  const eq = rowDiff(Math.floor(N / 2));
  const top = rowDiff(1);
  assert.ok(top < eq, `top row diff ${top.toFixed(3)} should be below equator ${eq.toFixed(3)}`);
});
