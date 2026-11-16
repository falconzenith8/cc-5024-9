// File-level tests: PNG codec, foldable cube net, manifest completeness.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite, test, assert } from './harness.mjs';
import { encodePNG, decodePNG } from '../src/png.js';
import { buildCubeNet, CUBE_NET, faceToNet, netToFace } from '../src/net.js';
import {
  FACES,
  FACE_NAMES,
  EDGE_ADJACENCY,
  faceDir,
} from '../src/geometry.js';
import { readManifest, MANIFEST_FILE, FACE_FILES } from '../src/manifest.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sampleFaces = path.join(root, 'output', 'sample', 'faces');

function unit(v) {
  const l = Math.hypot(...v);
  return v.map((c) => c / l);
}

suite('png');

test('PNG round-trip preserves every byte of RGB and RGBA data', () => {
  for (const channels of [3, 4]) {
    const W = 37;
    const H = 23;
    const data = new Uint8Array(W * H * channels);
    let s = 7;
    for (let i = 0; i < data.length; i++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      data[i] = s >>> 24;
    }
    const png = encodePNG({ width: W, height: H, channels, data });
    const back = decodePNG(png);
    assert.equal(back.width, W);
    assert.equal(back.height, H);
    assert.equal(back.channels, channels);
    assert.deepEqual(Array.from(back.data), Array.from(data));
  }
});

test('PNG encoder rejects malformed input', () => {
  assert.throws(() => encodePNG({ width: 0, height: 4, channels: 3, data: new Uint8Array(0) }));
  assert.throws(() => encodePNG({ width: 2, height: 2, channels: 2, data: new Uint8Array(8) }));
  assert.throws(() => encodePNG({ width: 2, height: 2, channels: 3, data: new Uint8Array(11) }));
});

test('PNG decoder accepts the generated sample files and reports 2:1 chart', () => {
  const chart = decodePNG(fs.readFileSync(path.join(root, 'output/sample/chart-equirect.png')));
  assert.equal(chart.channels, 3);
  assert.equal(chart.width, chart.height * 2);
  for (const file of FACE_FILES) {
    const png = decodePNG(fs.readFileSync(path.join(sampleFaces, file)));
    assert.equal(png.width, png.height);
    assert.equal(png.channels, 3);
  }
});

suite('cube net');

test('net contains six tiles, one per face, with no overlaps', () => {
  assert.equal(CUBE_NET.tiles.length, 6);
  assert.deepEqual(CUBE_NET.tiles.map((t) => t.face).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  const cells = new Set();
  for (const t of CUBE_NET.tiles) {
    const key = `${t.col},${t.row}`;
    assert.ok(!cells.has(key), `tiles overlap at ${key}`);
    cells.add(key);
    assert.ok(t.col >= 0 && t.col < CUBE_NET.cols);
    assert.ok(t.row >= 0 && t.row < CUBE_NET.rows);
    assert.ok([0, 90, 180, 270].includes(t.rot), `bad rotation ${t.rot}`);
  }
});

test('every spanning-tree edge joins physically adjacent tiles on the page', () => {
  // A flat cube net can only follow a spanning tree of the cube graph; the
  // other physical edges are cuts. For every tree edge, the midpoint
  // direction must land on the same page point from both tiles. That proves
  // the chosen rotations fold correctly rather than merely look plausible.
  const tileOf = (face) => CUBE_NET.tiles[face];
  const mid = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
  assert.equal(CUBE_NET.edges.length, 5);
  for (const { a, b, sideA } of CUBE_NET.edges) {
    const [midU, midV] = mid[sideA];
    const fa = FACES[a];
    const d = unit(fa.F.map((c, i) => c + midU * fa.R[i] + midV * fa.D[i]));
    const fb = FACES[b];
    const denom = fb.F[0] * d[0] + fb.F[1] * d[1] + fb.F[2] * d[2];
    const nu = (fb.R[0] * d[0] + fb.R[1] * d[1] + fb.R[2] * d[2]) / denom;
    const nv = (fb.D[0] * d[0] + fb.D[1] * d[1] + fb.D[2] * d[2]) / denom;
    const ta = tileOf(a);
    const tb = tileOf(b);
    const pa = faceToNet(ta, midU, midV);
    const pb = faceToNet(tb, nu, nv);
    const ax = ta.col + pa.x;
    const ay = ta.row + pa.y;
    const bx = tb.col + pb.x;
    const by = tb.row + pb.y;
    const err = Math.hypot(ax - bx, ay - by);
    assert.ok(err < 1e-12, `${FACE_NAMES[a]}/${sideA} -> ${FACE_NAMES[b]}: page gap ${err}`);
  }
});

test('cut edges are the seven physical edges a flat net cannot show', () => {
  const tree = new Set(
    CUBE_NET.edges.map((e) => [e.a, e.b].sort((x, y) => x - y).join('-')),
  );
  const physical = new Set();
  for (const e of EDGE_ADJACENCY) {
    physical.add([e.face, e.neighbor].sort((x, y) => x - y).join('-'));
  }
  assert.equal(physical.size, 12);
  assert.equal(tree.size, 5);
  for (const key of tree) assert.ok(physical.has(key), `tree edge ${key} is not a cube edge`);
});

test('faceToNet and netToFace are inverse maps', () => {
  for (const t of CUBE_NET.tiles) {
    for (const [u, v] of [[0, 0], [-0.9, 0.4], [0.66, -0.33], [1, 1]]) {
      const p = faceToNet(t, u, v);
      const back = netToFace(t, p.x, p.y);
      assert.ok(Math.abs(back.u - u) < 1e-12 && Math.abs(back.v - v) < 1e-12);
    }
  }
});

test('net is rotation-only, never a mirror', () => {
  // A tile rotation is clockwise by 0/90/180/270. Applying it must preserve
  // orientation (det = +1). Detect a mirror by checking that the image of the
  // u axis turned toward the v axis stays a right-handed pair on the page.
  for (const t of CUBE_NET.tiles) {
    const o = faceToNet(t, 0, 0);
    const pu = faceToNet(t, 0.25, 0);
    const pv = faceToNet(t, 0, 0.25);
    const du = [pu.x - o.x, pu.y - o.y];
    const dv = [pv.x - o.x, pv.y - o.y];
    const cross = du[0] * dv[1] - du[1] * dv[0];
    // (u right, v down) has cross +1 on the page for an unrotated tile.
    assert.ok(cross > 0, `tile face ${t.face} appears mirrored (cross ${cross})`);
  }
});

test('buildCubeNet is deterministic and agrees with exported CUBE_NET', () => {
  const again = buildCubeNet(4);
  assert.deepEqual(again.tiles, CUBE_NET.tiles);
  assert.equal(again.cols, CUBE_NET.cols);
  assert.equal(again.rows, CUBE_NET.rows);
});

test('web/net.json matches the derived net', () => {
  const json = JSON.parse(fs.readFileSync(path.join(root, 'web', 'net.json'), 'utf8'));
  assert.equal(json.cols, CUBE_NET.cols);
  assert.equal(json.rows, CUBE_NET.rows);
  assert.deepEqual(json.tiles, CUBE_NET.tiles);
});

suite('manifest');

test('sample manifest describes all six faces, axes, edges and filtering', () => {
  const m = readManifest(sampleFaces);
  assert.equal(m.version, 1);
  assert.equal(m.direction, 'equirect-to-cube');
  assert.equal(m.files.length, 6);
  assert.deepEqual(m.mapping.faceOrder, FACE_NAMES);
  assert.equal(m.mapping.faceSize, 512);
  assert.equal(m.mapping.faces.length, 6);
  for (let f = 0; f < 6; f++) {
    const face = m.mapping.faces[f];
    assert.equal(face.name, FACE_NAMES[f]);
    assert.equal(face.file, FACE_FILES[f]);
    assert.deepEqual(face.centreDirection, FACES[f].F);
    assert.deepEqual(face.imageRightWorld, FACES[f].R);
    assert.deepEqual(face.imageDownWorld, FACES[f].D);
  }
  assert.equal(m.mapping.edges.length, 24);
  const reversed = m.mapping.edges.filter((e) => e.traversal === 'opposite').length;
  assert.equal(reversed, 24, 'all cube-net edges traverse oppositely');
  assert.equal(m.mapping.filtering.linearLight, false);
  assert.match(m.mapping.filtering.equirectToCube, /periodic/);
  assert.match(m.mapping.filtering.cubeToEquirect, /supersampling/);
  assert.match(m.mapping.seamPolicy.equirectHorizontal, /periodic/);
  assert.ok(m.files.every((f) => fs.existsSync(path.join(sampleFaces, f.file))));
});

test('manifest records measured round-trip loss and admits it is lossy', () => {
  const m = readManifest(sampleFaces);
  assert.ok(m.metrics?.roundTrip, 'roundTrip metrics present');
  assert.ok(Number.isFinite(m.metrics.roundTrip.psnrDb));
  assert.ok(m.metrics.roundTrip.mae >= 0);
  assert.ok(m.metrics.roundTripSolidAngle, 'solid-angle weighted metrics present');
  assert.match(m.metrics.note, /not.*byte|lossy|loss/i);
  assert.ok(m.metrics.vsAnalyticChart.length === 6);
});

test('manifest read rejects a missing or truncated manifest', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'output', 'tmp-manifest-'));
  try {
    assert.throws(() => readManifest(tmp), /missing/);
    fs.writeFileSync(
      path.join(tmp, MANIFEST_FILE),
      JSON.stringify({ version: 1, files: [], faceSize: 512 }),
    );
    assert.throws(() => readManifest(tmp), /six face files/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
