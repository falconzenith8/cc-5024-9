#!/usr/bin/env node
// Command-line tool for equirectangular <-> cubemap conversion.
//
// Usage:
//   node bin/cli.mjs equirect-to-cube <input.png> <outDir> --size 1024 [--filter area|bilinear]
//   node bin/cli.mjs cube-to-equirect <facesDir> <out.png> [--width 4096] [--height 2048]
//   node bin/cli.mjs build-sample <outDir> [--size 512] [--source-width 2048]
//   node bin/cli.mjs info <facesDir>
//
// Every conversion writes/reads a cubemap.json metadata file next to the six
// face PNGs (or next to the equirect output). See docs/MAPPING.md.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { encodePNG, decodePNG } from '../src/png.js';
import { FACE_NAMES } from '../src/geometry.js';
import {
  ImageDataF,
  equirectToCube,
  cubeToEquirect,
  toUint8,
  compareImages,
  compareImagesWeighted,
} from '../src/resample.js';
import {
  renderChartEquirect,
  chartColorAtCubeTexel,
} from '../src/chart.js';
import { writeManifest, readManifest, FACE_FILES } from '../src/manifest.js';

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function readImage(file) {
  const buf = fs.readFileSync(file);
  const png = decodePNG(buf);
  return ImageDataF.fromUint8(png.width, png.height, png.channels, png.data);
}

function writeImage(file, image) {
  const u8 = toUint8(image);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePNG({ width: u8.width, height: u8.height, channels: u8.channels, data: u8.data }));
  return file;
}

function equirectToCubeCommand(args) {
  const [input, outDir] = args.positional;
  if (!input || !outDir) fail('usage: cli.mjs equirect-to-cube <input.png> <outDir> --size N');
  const N = Number(args.flags.size ?? 1024);
  if (!Number.isInteger(N) || N < 4) fail('--size must be an integer >= 4');
  const filter = args.flags.filter ?? 'area';
  const source = readImage(input);
  if (source.width !== source.height * 2) {
    console.warn(`warning: source is ${source.width}x${source.height}; equirect is normally 2:1`);
  }
  const started = Date.now();
  const faces = equirectToCube(source, N, { filter });
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  for (let f = 0; f < 6; f++) {
    const file = path.join(outDir, FACE_FILES[f]);
    writeImage(file, faces[f]);
    files.push({ face: f, name: FACE_NAMES[f], file: path.basename(file) });
  }
  // Measure source fidelity: convert back and compare with the source image.
  const back = cubeToEquirect(faces, source.width, source.height);
  const metrics = compareImages(back, source);
  const weighted = compareImagesWeighted(back, source, source.width, source.height);
  const elapsedMs = Date.now() - started;
  writeManifest(outDir, {
    direction: 'equirect-to-cube',
    faceSize: N,
    filter,
    source: {
      file: path.basename(input),
      width: source.width,
      height: source.height,
      channels: source.channels,
    },
    files,
    metrics: { roundTrip: metrics, roundTripSolidAngle: weighted },
    elapsedMs,
  });
  console.log(`wrote ${outDir} (${N}x${N} x6) in ${elapsedMs} ms`);
  console.log(`round-trip (informational): PSNR ${metrics.psnrDb.toFixed(2)} dB, MAE ${metrics.mae.toFixed(3)}/255`);
  return 0;
}

function readCubemap(dir) {
  const manifest = readManifest(dir);
  const size = manifest.faceSize;
  const faces = [];
  for (let f = 0; f < 6; f++) {
    const file = path.join(dir, manifest.files[f].file);
    const img = readImage(file);
    if (img.width !== size || img.height !== size) {
      fail(`${file} is ${img.width}x${img.height}, manifest says ${size}x${size}`);
    }
    faces.push(img);
  }
  return { faces, manifest };
}

function cubeToEquirectCommand(args) {
  const [facesDir, outFile] = args.positional;
  if (!facesDir || !outFile) fail('usage: cli.mjs cube-to-equirect <facesDir> <out.png>');
  const { faces, manifest } = readCubemap(facesDir);
  const N = manifest.faceSize;
  const W = Number(args.flags.width ?? N * 4);
  const H = Number(args.flags.height ?? W / 2);
  if (!(W > 0 && H > 0) || W !== H * 2) fail('--width/--height must be a positive 2:1 pair');
  const started = Date.now();
  const out = cubeToEquirect(faces, W, H, {
    maxSamples: Number(args.flags.maxSamples ?? 6),
  });
  writeImage(outFile, out);
  const elapsedMs = Date.now() - started;
  const metaFile = outFile.replace(/\.png$/i, '') + '.json';
  fs.writeFileSync(
    metaFile,
    JSON.stringify(
      {
        format: 'equirectangular-panorama',
        direction: 'cube-to-equirect',
        width: W,
        height: H,
        source: { cubemap: path.basename(facesDir), faceSize: N },
        mapping: manifest.mapping,
        elapsedMs,
        note: 'Reconstructed from a resampled cubemap; loss relative to the original source is quantified when both directions are run through the test harness.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`wrote ${outFile} (${W}x${H}) in ${elapsedMs} ms`);
  console.log(`metadata: ${metaFile}`);
  return 0;
}

function buildSampleCommand(args) {
  const [outDir = 'output/sample'] = args.positional;
  const N = Number(args.flags.size ?? 512);
  const W = Number(args.flags['source-width'] ?? N * 4);
  const H = W / 2;
  const filter = args.flags.filter ?? 'area';
  fs.mkdirSync(path.join(outDir, 'faces'), { recursive: true });

  const chart = renderChartEquirect(W, H);
  const chartFile = path.join(outDir, 'chart-equirect.png');
  fs.writeFileSync(chartFile, encodePNG(chart));
  console.log(`wrote ${chartFile}`);

  const src = ImageDataF.fromUint8(W, H, 3, chart.data);
  const started = Date.now();
  const faces = equirectToCube(src, N, { filter });
  fs.mkdirSync(path.join(outDir, 'faces'), { recursive: true });
  for (let f = 0; f < 6; f++) {
    const file = path.join(outDir, 'faces', FACE_FILES[f]);
    writeImage(file, faces[f]);
  }
  const back = cubeToEquirect(faces, W, H);
  const backFile = path.join(outDir, 'reconstructed-equirect.png');
  writeImage(backFile, back);
  const metrics = compareImages(back, src);
  const weighted = compareImagesWeighted(back, src, W, H);

  // Per-face analytic deviation (chart is a pure function of direction).
  const perFace = [];
  for (let f = 0; f < 6; f++) {
    const gt = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = chartColorAtCubeTexel(f, i, j, N);
        const o = (j * N + i) * 3;
        gt[o] = c[0];
        gt[o + 1] = c[1];
        gt[o + 2] = c[2];
      }
    }
    perFace.push({
      face: f,
      name: FACE_NAMES[f],
      vsAnalyticChart: compareImages(faces[f], new ImageDataF(N, N, 3, gt)),
    });
  }

  writeManifest(path.join(outDir, 'faces'), {
    direction: 'equirect-to-cube',
    faceSize: N,
    filter,
    source: { file: 'chart-equirect.png', width: W, height: H, channels: 3 },
    files: FACE_FILES.map((file, face) => ({ face, name: FACE_NAMES[face], file })),
    metrics: {
      roundTrip: metrics,
      roundTripSolidAngle: weighted,
      vsAnalyticChart: perFace,
      note: 'Round-trip loss is real: the cube->equirect pass integrates over cube texels, so high-frequency detail above the cube rate is removed. No byte-for-byte identity is claimed.',
    },
  });
  fs.writeFileSync(path.join(outDir, 'roundtrip.json'), JSON.stringify({ metrics, weighted }, null, 2) + '\n');
  console.log(`wrote ${outDir}/faces/*.png and metadata in ${Date.now() - started} ms`);
  console.log(`chart round-trip PSNR ${metrics.psnrDb.toFixed(2)} dB, MAE ${metrics.mae.toFixed(3)}/255`);
  return 0;
}

function infoCommand(args) {
  const [dir] = args.positional;
  if (!dir) fail('usage: cli.mjs info <facesDir>');
  const manifest = readManifest(dir);
  console.log(JSON.stringify(manifest, null, 2));
  return 0;
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional.shift();
try {
  if (command === 'equirect-to-cube') process.exitCode = equirectToCubeCommand({ positional, flags });
  else if (command === 'cube-to-equirect') process.exitCode = cubeToEquirectCommand({ positional, flags });
  else if (command === 'build-sample') process.exitCode = buildSampleCommand({ positional, flags });
  else if (command === 'info') process.exitCode = infoCommand({ positional, flags });
  else {
    console.error('commands: equirect-to-cube | cube-to-equirect | build-sample | info');
    process.exitCode = 1;
  }
} catch (err) {
  fail(err.message);
}
