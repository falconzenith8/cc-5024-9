#!/usr/bin/env node
// Before/after evidence for the meridian and pole boundary fixes.
//
// Usage:
//   node scripts/boundary-evidence.mjs <before-src-dir> <after-src-dir> [out.json]
//
// Each directory must contain resample.js + geometry.js. The "before" tree is
// the kernel prior to the meridian/pole repair, the "after" directory is the
// current src/. Every probe is a direction-known pattern with a closed-form
// expectation, so a difference is attributable to the kernel, not the content.
//
// Output is committed as output/sample/boundary-evidence.json; the numbers are
// also asserted by test/boundary.test.mjs on the repaired kernel.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [beforeDir, afterDir, outFile] = process.argv.slice(2);
if (!beforeDir || !afterDir) {
  console.error('usage: boundary-evidence.mjs <before-src-dir> <after-src-dir> [out.json]');
  process.exit(2);
}

async function load(dir) {
  const base = pathToFileURL(path.resolve(dir)).href + '/';
  return {
    ...(await import(base + 'resample.js')),
    ...(await import(base + 'geometry.js')),
  };
}

async function probe(mod) {
  const { equirectToCubeFace, cubeToEquirect, sampleCubeDirection, ImageDataF, compareImages } = mod;
  const { equirectPixelToDir, dirToAngles, texelDirection } = mod;
  const out = {};

  // A. Even-N pole corner: four longitude quadrants must land in four texels.
  {
    const N = 16;
    const W = 2048;
    const H = 1024;
    const quads = [
      { lo: 180, hi: 270 },
      { lo: 270, hi: 360 },
      { lo: 0, hi: 90 },
      { lo: 90, hi: 180 },
    ];
    const rows = [];
    for (const q of quads) {
      const d = new Float32Array(W * H * 3);
      for (let py = 0; py < H; py++) {
        for (let px = 0; px < W; px++) {
          const { theta } = dirToAngles(...equirectPixelToDir(px, py, W, H));
          const lon = ((theta * 180) / Math.PI + 360) % 360;
          const v = lon >= q.lo && lon < q.hi ? 255 : 0;
          const o = (py * W + px) * 3;
          d[o] = d[o + 1] = d[o + 2] = v;
        }
      }
      const face = equirectToCubeFace(new ImageDataF(W, H, 3, d), 2, N, { filter: 'area' });
      rows.push(
        [
          [N / 2 - 1, N / 2 - 1],
          [N / 2, N / 2 - 1],
          [N / 2 - 1, N / 2],
          [N / 2, N / 2],
        ].map(([i, j]) => +face.data[(j * N + i) * 3].toFixed(1)),
      );
    }
    out.poleQuadrant = {
      rows,
      hotPerRow: rows.map((r) => r.filter((v) => v > 240).length),
      // An ideal quadrant pattern is a permutation of 255 and 0. Anything in
      // between is leakage from a folded wedge, e.g. the pre-fix 253.8/1.2.
      maxLeak: Math.max(...rows.flat().map((v) => Math.min(v, 255 - v))),
    };
  }

  // B. Polar cap rows: a lit north cap must reach the +Y pole texels.
  {
    const N = 17;
    const W = 2048;
    const H = 1024;
    const rowsTop = 8;
    const d = new Float32Array(W * H * 3);
    for (let py = 0; py < rowsTop; py++) {
      for (let px = 0; px < W; px++) {
        const o = (py * W + px) * 3;
        d[o] = d[o + 1] = d[o + 2] = 255;
      }
    }
    const face = equirectToCubeFace(new ImageDataF(W, H, 3, d), 2, N, { filter: 'area' });
    const centre = (N - 1) / 2;
    out.polarCap = {
      faceSize: N,
      rowsTop,
      centreTexel: +face.data[(Math.round(centre) * N + Math.round(centre)) * 3].toFixed(2),
    };
  }

  // C. Smooth-field round trip: PSNR, max error, and error at the seam/pole.
  {
    const W = 512;
    const H = 256;
    const N = 64;
    const field = (x, y, z) => [128 + 70 * x, 128 + 60 * y, 128 + 50 * z];
    const d = new Float32Array(W * H * 3);
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const c = field(...equirectPixelToDir(px, py, W, H));
        const o = (py * W + px) * 3;
        d[o] = c[0];
        d[o + 1] = c[1];
        d[o + 2] = c[2];
      }
    }
    const src = new ImageDataF(W, H, 3, d);
    const faces = [0, 1, 2, 3, 4, 5].map((f) => equirectToCubeFace(src, f, N, { filter: 'area' }));
    const back = cubeToEquirect(faces, W, H);
    const m = compareImages(back, src);
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
        const seamDeg = Math.abs((Math.abs(theta) - Math.PI) * 180) / Math.PI;
        const poleDeg = 90 - Math.abs((phi * 180) / Math.PI);
        if (seamDeg < 3) seamMax = Math.max(seamMax, e);
        if (poleDeg < 3) poleMax = Math.max(poleMax, e);
      }
    }
    out.smoothFieldRoundTrip = {
      psnrDb: +m.psnrDb.toFixed(2),
      mae: +m.mae.toFixed(3),
      maxAbs: +m.maxAbs.toFixed(3),
      seamBandMax: +seamMax.toFixed(3),
      poleBandMax: +poleMax.toFixed(3),
    };
  }

  // D. Cross-face sampling of a smooth analytic field: analytic max error.
  {
    const N = 64;
    const field = (x, y, z) => [100 + 120 * x, 100 + 120 * y, 100 + 120 * z];
    const faces = [];
    for (let f = 0; f < 6; f++) {
      const d = new Float32Array(N * N * 3);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const c = field(...texelDirection(f, i, j, N));
          const o = (j * N + i) * 3;
          d[o] = c[0];
          d[o + 1] = c[1];
          d[o + 2] = c[2];
        }
      }
      faces.push(new ImageDataF(N, N, 3, d));
    }
    let maxErr = 0;
    let seamErr = 0;
    for (let latDeg = -85; latDeg <= 85; latDeg += 5) {
      for (let lonDeg = -180; lonDeg < 180; lonDeg += 1) {
        const th = (lonDeg * Math.PI) / 180;
        const ph = (latDeg * Math.PI) / 180;
        const cp = Math.cos(ph);
        const dir = [cp * Math.sin(th), Math.sin(ph), cp * Math.cos(th)];
        const want = field(...dir);
        const got = sampleCubeDirection(faces, ...dir);
        const e = Math.max(...got.map((v, k) => Math.abs(v - want[k])));
        maxErr = Math.max(maxErr, e);
        const nearEdge =
          [45, 135, -45, -135].some((L) => Math.abs(lonDeg - L) < 1) &&
          [0, 45, -45].some((L) => Math.abs(latDeg - L) < 1);
        if (nearEdge) seamErr = Math.max(seamErr, e);
      }
    }
    out.crossFaceSampling = { analyticMaxErr: +maxErr.toFixed(3), nearEdgeMaxErr: +seamErr.toFixed(3) };
  }

  return out;
}

const before = await probe(await load(beforeDir));
const after = await probe(await load(afterDir));
const report = {
  format: 'boundary-evidence',
  note: 'Direction-known probes run against the pre-fix and repaired kernels. Zero/default values are real measurements, not placeholders.',
  probes: {
    poleQuadrant: 'four longitude quadrants over a lit north cap, even N (pole on a texel corner)',
    polarCap: 'only the first 8 north-cap rows lit; centre pole texel must see them (odd N)',
    smoothFieldRoundTrip: 'analytic linear-in-direction field through equirect->cube->equirect',
    crossFaceSampling: 'analytic linear-in-direction field sampled with sampleCubeDirection',
  },
  before,
  after,
};
const text = JSON.stringify(report, null, 2) + '\n';
if (outFile) {
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, text);
  console.log(`wrote ${outFile}`);
} else {
  process.stdout.write(text);
}
