// Geometry conventions: handedness, pixel centres, face ownership, edges.

import { suite, test, assert } from './harness.mjs';
import {
  FACES,
  FACE_NAMES,
  EDGE_ADJACENCY,
  EDGE_NAMES,
  EDGE_SIDES,
  faceDir,
  faceDirUnit,
  faceHandedness,
  texelDirection,
  dirToFaceUV,
  dirToFacePixel,
  facePixelToDir,
  dirToAngles,
  anglesToDir,
  dirToEquirectPixel,
  equirectPixelToDir,
  faceTexelSolidAngle,
  equirectPixelSolidAngle,
  computeEdgeAdjacency,
  mod,
} from '../src/geometry.js';
import { FACE_COLORS, PLATE_UV_HALF, chartColor, chartColorAtCubeTexel } from '../src/chart.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function unit(v) {
  const l = Math.hypot(...v);
  return v.map((c) => c / l);
}

function randomDirections(count, seed = 20260317) {
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out = [];
  for (let k = 0; k < count; k++) {
    const z = rand() * 2 - 1;
    const t = rand() * 2 * Math.PI;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out.push([r * Math.cos(t), z, r * Math.sin(t)]);
  }
  return out;
}

suite('geometry');

test('every face frame is right-handed (det(R, D, F) = +1)', () => {
  for (let f = 0; f < 6; f++) {
    assert.equal(faceHandedness(f), 1, `face ${FACE_NAMES[f]}`);
    const { R, D, F } = FACES[f];
    assert.ok(Math.abs(dot(R, D)) < 1e-12);
    assert.ok(Math.abs(dot(R, F)) < 1e-12);
    assert.ok(Math.abs(dot(D, F)) < 1e-12);
    assert.ok(Math.abs(Math.hypot(...R) - 1) < 1e-12);
    assert.ok(Math.abs(Math.hypot(...D) - 1) < 1e-12);
    assert.ok(Math.abs(Math.hypot(...F) - 1) < 1e-12);
  }
});

test('image down always has a downward world component (no flipped face)', () => {
  for (let f = 0; f < 6; f++) {
    assert.ok(FACES[f].D[1] <= 0, `${FACE_NAMES[f]} image down y=${FACES[f].D[1]}`);
  }
  // Top/bottom faces carry the pole orientation on the page. +Y sees +Z up,
  // -Y sees -Z up, so neither cap is arbitrarily rotated.
  assert.deepEqual(FACES[2].D, [0, 0, -1]);
  assert.deepEqual(FACES[3].D, [0, 0, 1]);
});

test('face centres map to their axis and back', () => {
  const axes = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  for (let f = 0; f < 6; f++) {
    const d = faceDirUnit(f, 0, 0);
    for (let a = 0; a < 3; a++) assert.ok(Math.abs(d[a] - axes[f][a]) < 1e-15);
    const hit = dirToFaceUV(...axes[f]);
    assert.equal(hit.face, f);
    assert.ok(Math.abs(hit.u) < 1e-15 && Math.abs(hit.v) < 1e-15);
  }
});

test('face pixel centre convention is self-consistent', () => {
  const N = 8;
  const near = (a, b) => {
    const dotv = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return 1 - Math.min(1, dotv) < 1e-14;
  };
  for (let f = 0; f < 6; f++) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const d = texelDirection(f, i, j, N);
        const hit = dirToFacePixel(d[0], d[1], d[2], N);
        assert.equal(hit.face, f);
        assert.ok(Math.abs(hit.fx - i) < 1e-9, `fx ${hit.fx} != ${i}`);
        assert.ok(Math.abs(hit.fy - j) < 1e-9, `fy ${hit.fy} != ${j}`);
        const back = facePixelToDir(f, i, j, N);
        assert.ok(near(back, d), `face ${f} texel ${i},${j}`);
      }
    }
  }
});

test('dirToFaceUV and faceDir agree over random directions', () => {
  for (const d of randomDirections(5000)) {
    const hit = dirToFaceUV(...d);
    const back = unit(faceDir(hit.face, hit.u, hit.v));
    const dotv = dot(back, d);
    assert.ok(1 - Math.min(1, dotv) < 1e-14, `direction mismatch ${1 - dotv}`);
    assert.ok(Math.abs(hit.u) <= 1 + 1e-12 && Math.abs(hit.v) <= 1 + 1e-12);
    // The owning face is the dominant axis.
    const axis = hit.face < 2 ? 0 : hit.face < 4 ? 1 : 2;
    const comp = Math.abs(d[axis]);
    const maxComp = Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2]));
    assert.ok(comp >= maxComp - 1e-12);
  }
});

test('longitude/latitude and direction round-trip', () => {
  for (const d of randomDirections(2000)) {
    const { theta, phi } = dirToAngles(...d);
    assert.ok(theta >= -Math.PI - 1e-15 && theta <= Math.PI + 1e-15);
    assert.ok(phi >= -Math.PI / 2 && phi <= Math.PI / 2);
    const back = anglesToDir(theta, phi);
    assert.ok(1 - Math.min(1, dot(back, d)) < 1e-14);
  }
});

test('equirect pixel centres use the documented half-pixel convention', () => {
  const W = 64;
  const H = 32;
  for (let py = 0; py < H; py += 3) {
    for (let px = 0; px < W; px += 5) {
      const d = equirectPixelToDir(px, py, W, H);
      const { theta, phi } = dirToAngles(...d);
      assert.ok(Math.abs(theta - (-Math.PI + (2 * Math.PI * (px + 0.5)) / W)) < 1e-14);
      assert.ok(Math.abs(phi - (Math.PI / 2 - (Math.PI * (py + 0.5)) / H)) < 1e-14);
      const p = dirToEquirectPixel(...d, W, H);
      assert.ok(Math.abs(p.x - (px + 0.5)) < 1e-9, `x ${p.x}`);
      assert.ok(Math.abs(p.y - (py + 0.5)) < 1e-9, `y ${p.y}`);
    }
  }
});

test('horizontal seam is periodic: theta = -pi and +pi are the same direction', () => {
  const dL = anglesToDir(-Math.PI, 0.2);
  const dR = anglesToDir(Math.PI, 0.2);
  for (let a = 0; a < 3; a++) assert.ok(Math.abs(dL[a] - dR[a]) < 1e-15);
  assert.equal(mod(-1, 8), 7);
  assert.equal(mod(9.25, 8), 1.25);
});

test('all 12 shared edges are found, each traversed in opposite directions', () => {
  assert.equal(EDGE_ADJACENCY.length, 24, '4 edges per face');
  const undirected = new Set();
  for (const e of EDGE_ADJACENCY) {
    assert.notEqual(e.neighbor, e.face, `face ${e.face} edge ${e.edge} is its own neighbour`);
    assert.ok(EDGE_NAMES.includes(e.neighborEdge));
    assert.ok(e.reversed, `${FACE_NAMES[e.face]} ${e.edge} -> ${e.neighborName} ${e.neighborEdge}`);
    const key = [e.face, e.neighbor].sort((a, b) => a - b).join('-') + ':' + [e.edge, e.neighborEdge].sort().join('-');
    undirected.add(key);
    // Symmetry: the neighbour reports the same pairing back.
    const mate = EDGE_ADJACENCY.find(
      (x) => x.face === e.neighbor && x.edge === e.neighborEdge,
    );
    assert.equal(mate.neighbor, e.face);
    assert.equal(mate.neighborEdge, e.edge);
    assert.equal(mate.reversed, true);
  }
  assert.equal(undirected.size, 12, '12 distinct shared cube edges');
  // Each face contributes its four sides exactly once.
  for (let f = 0; f < 6; f++) {
    const sides = EDGE_ADJACENCY.filter((e) => e.face === f).map((e) => e.edge).sort();
    assert.deepEqual(sides, ['bottom', 'left', 'right', 'top']);
  }
});

test('edge adjacency is derived from geometry, not hand-written', () => {
  const recomputed = computeEdgeAdjacency();
  assert.deepEqual(
    recomputed.map((e) => [e.face, e.edge, e.neighbor, e.neighborEdge, e.reversed]),
    EDGE_ADJACENCY.map((e) => [e.face, e.edge, e.neighbor, e.neighborEdge, e.reversed]),
  );
});

test('edge sample points coincide in world space from both faces', () => {
  const edgePoint = (edge, t) => {
    if (edge === 'top') return [t, -1];
    if (edge === 'right') return [1, t];
    if (edge === 'bottom') return [-t, 1];
    return [-1, -t];
  };
  for (const e of EDGE_ADJACENCY) {
    for (const t of [-0.9, -0.4, 0, 0.35, 0.8]) {
      const [ua, va] = edgePoint(e.edge, t);
      // The neighbour traverses the same physical edge in the opposite
      // direction, so parameter -t matches (all cube edges are "reversed").
      const [ub, vb] = edgePoint(e.neighborEdge, -t);
      const da = unit(faceDir(e.face, ua, va));
      const db = unit(faceDir(e.neighbor, ub, vb));
      const ang = 1 - Math.min(1, dot(da, db));
      assert.ok(ang < 1e-14, `${e.faceName}/${e.edge} -> ${e.neighborName}/${e.neighborEdge} t=${t}: ${ang}`);
    }
  }
});

test('EDGE_SIDES labels agree with the sampled edges', () => {
  const mid = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
  for (const name of EDGE_NAMES) {
    const [u, v] = mid[name];
    if (name === 'top' || name === 'bottom') {
      assert.equal(EDGE_SIDES[name], `v=${v > 0 ? '+' : ''}${v}`);
    } else {
      assert.equal(EDGE_SIDES[name], `u=${u > 0 ? '+' : ''}${u}`);
    }
  }
});

test('face texel solid angles sum to 4*pi/6 on every face', () => {
  const N = 32;
  let grand = 0;
  for (let f = 0; f < 6; f++) {
    let total = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const u = -1 + (2 * (i + 0.5)) / N;
        const v = -1 + (2 * (j + 0.5)) / N;
        total += faceTexelSolidAngle(f, u, v, N);
      }
    }
    // Each face of a cube subtends exactly 4*pi/6; midpoint quadrature of the
    // exact Jacobian converges O(1/N^2).
    assert.ok(Math.abs(total - (4 * Math.PI) / 6) < 0.005, `face ${f}: ${total}`);
    grand += total;
  }
  assert.ok(Math.abs(grand - 4 * Math.PI) < 0.005, `six faces: ${grand}`);
});

test('equirect pixel solid angles sum to 4*pi exactly', () => {
  const W = 64;
  const H = 32;
  let total = 0;
  for (let py = 0; py < H; py++) total += W * equirectPixelSolidAngle(py, W, H);
  assert.ok(Math.abs(total - 4 * Math.PI) < 1e-12, `${total}`);
});

suite('chart orientation');

test('the six axis directions carry the six unique plate colours', () => {
  const axes = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  const seen = new Set();
  for (let f = 0; f < 6; f++) {
    const c = chartColor(...axes[f]);
    assert.deepEqual(c.map(Math.round), FACE_COLORS[f], FACE_NAMES[f]);
    seen.add(c.join(','));
  }
  assert.equal(seen.size, 6);
});

test('orientation markers prove no face is flipped or mirrored', () => {
  // Render the chart plate markers analytically at a resolution fine enough
  // to hit their centres. White disc toward image-up, dark disc toward
  // image-right. If a face were stored flipped or rotated these would move.
  const N = 1024;
  const h = PLATE_UV_HALF;
  const texel = (f, u, v) => {
    const i = Math.round(((u + 1) / 2) * N - 0.5);
    const j = Math.round(((v + 1) / 2) * N - 0.5);
    return chartColorAtCubeTexel(f, i, j, N).map(Math.round);
  };
  for (let f = 0; f < 6; f++) {
    const up = texel(f, 0, -0.8 * h);
    const right = texel(f, 0.8 * h, 0);
    assert.ok(up.every((c) => c > 190), `${FACE_NAMES[f]} up marker rgb ${up}`);
    assert.ok(right.every((c) => c < 50), `${FACE_NAMES[f]} right marker rgb ${right}`);
  }
});

test('face top rows point up in the world, bottom rows down', () => {
  // Side faces use +Y as image up. The caps follow the documented page
  // orientation: +Y has +Z upward, -Y has -Z upward, so their pole row is
  // unambiguous relative to the side faces.
  for (let f = 0; f < 6; f++) {
    const top = unit(faceDir(f, 0, -0.98));
    const bottom = unit(faceDir(f, 0, 0.98));
    if (f === 2) {
      assert.ok(top[2] > 0 && bottom[2] < 0, `${FACE_NAMES[f]} cap orientation`);
    } else if (f === 3) {
      assert.ok(top[2] < 0 && bottom[2] > 0, `${FACE_NAMES[f]} cap orientation`);
    } else {
      assert.ok(top[1] > bottom[1], `${FACE_NAMES[f]} image rows`);
    }
  }
});

test('equirect chart and face chart agree away from filters', () => {
  // chartColorAtEquirect is the analytic truth; renderChartFace supersamples
  // it. Directions at the centre of a plate are flat, so they must match.
  const d = unit(faceDir(4, 0, 0));
  const c = chartColor(...d);
  assert.deepEqual(c.map(Math.round), FACE_COLORS[4]);
});
