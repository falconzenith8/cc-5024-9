// Panorama reprojection.
//
// Renders the cubemap under a selectable camera projection. Every output pixel
// becomes a unit direction and is sampled through the *same* kernel that
// cube->equirect uses (`sampleCubeDirection` in resample.js), so the UI cannot
// show a view that disagrees with the repaired seam/pole arithmetic.
//
// Two projections are provided:
//   rectilinear    pinhole camera; yaw/pitch rotate it, fov sets the vertical
//                  field of view. This is the "look around the sphere" view.
//   equirectangular full 360x180 panorama; yaw shifts longitude, pitch shifts
//                  latitude.
//
// The module also renders direction-known calibration cubemaps and measures:
//   * direction error  - how far the decoded direction of a reprojected pixel
//     is from the ray the projection asked for;
//   * seam difference  - the worst reconstruction error for rays within 1.5
//     cube texels of a face edge, next to the interior error as a reference.
// Both are computed, never defaulted: a missing or non-finite measurement
// throws, so a regression cannot pass by leaving a metric at zero.
//
// No Node APIs are used here, so the browser imports this file directly.

import {
  EDGE_ADJACENCY,
  FACES,
  anglesToDir,
  cross,
  normalize,
  dirToAngles,
  dirToFaceUV,
  faceDirUnit,
} from './geometry.js';
import { ImageDataF, sampleCubeDirection } from './resample.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export const PROJECTIONS = Object.freeze([
  {
    id: 'rectilinear',
    name: 'Rectilinear (perspective)',
    description: 'pinhole camera; drag to rotate yaw/pitch, fov changes zoom',
    usesFov: true,
  },
  {
    id: 'equirectangular',
    name: 'Equirectangular',
    description: 'full 360x180 panorama; drag shifts longitude/latitude',
    usesFov: false,
  },
]);

export const PROJECTION_IDS = Object.freeze(PROJECTIONS.map((p) => p.id));

function assertProjection(projection) {
  if (!PROJECTION_IDS.includes(projection)) {
    throw new Error(`unknown projection "${projection}"`);
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function wrapAngle(a) {
  return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
}

/**
 * Orthonormal camera basis for a rectilinear view. `C` is forward, `R` image
 * right, `U` image up. At the poles the yaw still fixes the roll.
 */
export function cameraBasis(yaw, pitch) {
  const p = clamp(pitch, -Math.PI / 2 + 1e-6, Math.PI / 2 - 1e-6);
  const C = anglesToDir(yaw, p);
  let R = cross([0, 1, 0], C);
  if (Math.hypot(...R) < 1e-9) R = [1, 0, 0];
  R = normalize(R);
  const U = cross(C, R);
  return { C, R, U };
}

/**
 * Unit direction of the centre of output pixel (px, py). px/py are continuous
 * pixel-centre coordinates; integer values sit on texel centres.
 */
export function rayForPixel(projection, px, py, W, H, options = {}) {
  assertProjection(projection);
  const { yaw = 0, pitch = 0, fovDeg = 75 } = options;
  if (projection === 'equirectangular') {
    const lon = -Math.PI + (2 * Math.PI * (px + 0.5)) / W + yaw;
    const lat = clamp(Math.PI / 2 - (Math.PI * (py + 0.5)) / H + pitch, -Math.PI / 2, Math.PI / 2);
    return anglesToDir(lon, lat);
  }
  const { C, R, U } = cameraBasis(yaw, pitch);
  const focal = 1 / Math.tan(Math.max(1, Math.min(179, fovDeg)) * DEG / 2);
  const aspect = W / H;
  const sx = (2 * (px + 0.5)) / W - 1;
  const sy = 1 - (2 * (py + 0.5)) / H;
  return normalize([
    C[0] * focal + R[0] * sx * aspect + U[0] * sy,
    C[1] * focal + R[1] * sx * aspect + U[1] * sy,
    C[2] * focal + R[2] * sx * aspect + U[2] * sy,
  ]);
}

/**
 * Continuous output pixel for a direction, plus whether it is in front of the
 * camera and inside the image. Used to draw seam lines from geometry.
 */
export function projectDirection(projection, dir, W, H, options = {}) {
  assertProjection(projection);
  const { yaw = 0, pitch = 0, fovDeg = 75 } = options;
  const unit = normalize(dir);
  if (projection === 'equirectangular') {
    const { theta, phi } = dirToAngles(...unit);
    const lon = wrapAngle(theta - yaw);
    const lat = phi - pitch;
    const px = ((lon + Math.PI) / (2 * Math.PI)) * W - 0.5;
    const py = ((Math.PI / 2 - lat) / Math.PI) * H - 0.5;
    const visible = lat >= -Math.PI / 2 - 1e-12 && lat <= Math.PI / 2 + 1e-12;
    return { px, py, visible, inFrame: visible && px >= -0.5 && px <= W - 0.5 && py >= -0.5 && py <= H - 0.5 };
  }
  const { C, R, U } = cameraBasis(yaw, pitch);
  const t = unit[0] * C[0] + unit[1] * C[1] + unit[2] * C[2];
  if (t <= 1e-9) return { px: NaN, py: NaN, visible: false, inFrame: false };
  const focal = 1 / Math.tan(Math.max(1, Math.min(179, fovDeg)) * DEG / 2);
  const aspect = W / H;
  const lx = (unit[0] * R[0] + unit[1] * R[1] + unit[2] * R[2]) / t;
  const ly = (unit[0] * U[0] + unit[1] * U[1] + unit[2] * U[2]) / t;
  const sx = (lx * focal) / aspect;
  const sy = ly * focal;
  const px = ((sx + 1) / 2) * W - 0.5;
  const py = ((1 - sy) / 2) * H - 0.5;
  return { px, py, visible: true, inFrame: px >= -0.5 && px <= W - 0.5 && py >= -0.5 && py <= H - 0.5 };
}

function validateFaces(faces) {
  if (!Array.isArray(faces) || faces.length !== 6) {
    throw new Error('reprojection requires exactly six cube faces');
  }
  const N = faces[0].width;
  for (let f = 0; f < 6; f++) {
    const img = faces[f];
    if (!img || img.width !== N || img.height !== N) {
      throw new Error(`face ${f} is not ${N}x${N}`);
    }
    if (img.channels !== faces[0].channels) {
      throw new Error('face channel counts differ');
    }
  }
  return N;
}

/** Render the cubemap through the selected projection with the patched kernel. */
export function renderReprojection(faces, options) {
  const { projection = 'rectilinear', width, height, yaw = 0, pitch = 0, fovDeg = 75 } = options ?? {};
  assertProjection(projection);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('reprojection width/height must be positive integers');
  }
  const N = validateFaces(faces);
  const C = faces[0].channels;
  const out = new Float32Array(width * height * C);
  const view = { yaw, pitch, fovDeg };
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const dir = rayForPixel(projection, px, py, width, height, view);
      const rgb = sampleCubeDirection(faces, dir[0], dir[1], dir[2]);
      const o = (py * width + px) * C;
      for (let c = 0; c < C; c++) out[o + c] = rgb[c];
    }
  }
  return new ImageDataF(width, height, C, out);
}

/**
 * The 12 cube edges as polylines of world directions, deduplicated from the
 * 24 directed entries. Seam overlays are drawn from this geometry, not from
 * the image, so they land where the projection says the cube edges are.
 */
export function seamPolylines(samplesPerEdge = 9) {
  const seen = new Set();
  const lines = [];
  for (const e of EDGE_ADJACENCY) {
    const key = [Math.min(e.face, e.neighbor), Math.max(e.face, e.neighbor), ...[e.edge, e.neighborEdge].sort()].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    const dirs = [];
    for (let k = 0; k < samplesPerEdge; k++) {
      const t = -1 + (2 * k) / (samplesPerEdge - 1);
      const [u, v] = edgeUV(e.edge, t);
      const frame = FACES[e.face];
      const d = normalize([
        frame.F[0] + u * frame.R[0] + v * frame.D[0],
        frame.F[1] + u * frame.R[1] + v * frame.D[1],
        frame.F[2] + u * frame.R[2] + v * frame.D[2],
      ]);
      dirs.push(d);
    }
    lines.push({ face: e.face, neighbor: e.neighbor, edge: e.edge, dirs });
  }
  return lines;
}

function edgeUV(edge, t) {
  if (edge === 'top') return [t, -1];
  if (edge === 'right') return [1, t];
  if (edge === 'bottom') return [-t, 1];
  return [-1, -t];
}

/** Unit-direction faces: each texel stores its own direction, mapped to 0..255. */
export function makeDirectionFaces(N) {
  const faces = [];
  for (let f = 0; f < 6; f++) {
    const data = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const u = -1 + (2 * (i + 0.5)) / N;
        const v = -1 + (2 * (j + 0.5)) / N;
        const d = faceDirUnit(f, u, v);
        const o = (j * N + i) * 3;
        data[o] = (d[0] + 1) * 127.5;
        data[o + 1] = (d[1] + 1) * 127.5;
        data[o + 2] = (d[2] + 1) * 127.5;
      }
    }
    faces.push(new ImageDataF(N, N, 3, data));
  }
  return faces;
}

function decodeDirection(r, g, b) {
  return normalize([r / 127.5 - 1, g / 127.5 - 1, b / 127.5 - 1]);
}

/** A smooth, direction-known field stored at texel centres (no quantisation). */
export function makeAnalyticFaces(N, field) {
  const fn = field ?? ((x, y, z) => [128 + 80 * x, 128 + 80 * y, 128 + 80 * z]);
  const faces = [];
  for (let f = 0; f < 6; f++) {
    const data = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const u = -1 + (2 * (i + 0.5)) / N;
        const v = -1 + (2 * (j + 0.5)) / N;
        const c = fn(...faceDirUnit(f, u, v));
        const o = (j * N + i) * 3;
        data[o] = c[0];
        data[o + 1] = c[1];
        data[o + 2] = c[2];
      }
    }
    faces.push(new ImageDataF(N, N, 3, data));
  }
  return faces;
}

function angleBetween(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(clamp(dot, -1, 1)) * RAD;
}

/**
 * Objective checks for one reprojection setting. Runs the patched kernel on
 * direction-known calibration cubemaps, so the result is independent of the
 * content of the panorama being viewed.
 *
 * Throws if any measurement is non-finite; callers must surface that as a
 * failure instead of substituting a default.
 */
export function measureReprojection(options = {}) {
  const {
    faceSize = 96,
    projection = 'rectilinear',
    yaw = 0,
    pitch = 0,
    fovDeg = 75,
    probeWidth = 64,
    probeHeight = 36,
    seamWidth = 192,
    seamHeight = 108,
  } = options;
  assertProjection(projection);
  const view = { projection, yaw, pitch, fovDeg };

  // 1) Direction error: render direction-encoded faces, decode each pixel and
  //    compare with the ray the projection requested.
  const dirFaces = makeDirectionFaces(faceSize);
  const dirImg = renderReprojection(dirFaces, { ...view, width: probeWidth, height: probeHeight });
  let maxAngle = 0;
  let sumAngle = 0;
  let count = 0;
  for (let py = 0; py < probeHeight; py++) {
    for (let px = 0; px < probeWidth; px++) {
      const want = rayForPixel(projection, px, py, probeWidth, probeHeight, view);
      const o = (py * probeWidth + px) * 3;
      const got = decodeDirection(dirImg.data[o], dirImg.data[o + 1], dirImg.data[o + 2]);
      const a = angleBetween(got, want);
      if (!Number.isFinite(a)) throw new Error('reprojection direction measurement is not finite');
      maxAngle = Math.max(maxAngle, a);
      sumAngle += a;
      count++;
    }
  }

  // 2) Seam difference: render a smooth direction-known field and compare each
  //    pixel with its analytic value. Rays within 1.5 texels of a cube edge
  //    are the seam band; everything else is the interior reference.
  const field = (x, y, z) => [128 + 80 * x, 128 + 80 * y, 128 + 80 * z];
  const analyticFaces = makeAnalyticFaces(faceSize, field);
  const seamImg = renderReprojection(analyticFaces, { ...view, width: seamWidth, height: seamHeight });
  const nearEdgeLimit = 1 - 1.5 * (2 / faceSize);
  let maxNearEdge = 0;
  let maxInterior = 0;
  for (let py = 0; py < seamHeight; py++) {
    for (let px = 0; px < seamWidth; px++) {
      const dir = rayForPixel(projection, px, py, seamWidth, seamHeight, view);
      const want = field(...dir);
      const o = (py * seamWidth + px) * 3;
      const err = Math.max(
        Math.abs(seamImg.data[o] - want[0]),
        Math.abs(seamImg.data[o + 1] - want[1]),
        Math.abs(seamImg.data[o + 2] - want[2]),
      );
      if (!Number.isFinite(err)) throw new Error('reprojection seam measurement is not finite');
      const hit = dirToFaceUV(...dir);
      const nearEdge = Math.max(Math.abs(hit.u), Math.abs(hit.v)) >= nearEdgeLimit;
      if (nearEdge) maxNearEdge = Math.max(maxNearEdge, err);
      else maxInterior = Math.max(maxInterior, err);
    }
  }

  // 3) Seam position: project each cube-edge direction, then ask the projection
  //    for the ray at that pixel. The round-trip error proves the drawn seam
  //    lines come from the same camera model as the rendered sphere.
  let maxSeamPositionError = 0;
  let seamPoints = 0;
  for (const line of seamPolylines()) {
    for (const dir of line.dirs) {
      const p = projectDirection(projection, dir, seamWidth, seamHeight, view);
      if (!p.visible || !p.inFrame) continue;
      const back = rayForPixel(projection, p.px, p.py, seamWidth, seamHeight, view);
      maxSeamPositionError = Math.max(maxSeamPositionError, angleBetween(back, dir));
      seamPoints++;
    }
  }

  const result = {
    projection,
    faceSize,
    settings: { yaw, pitch, fovDeg, probeWidth, probeHeight, seamWidth, seamHeight },
    direction: {
      maxAngleDeg: maxAngle,
      meanAngleDeg: sumAngle / count,
      pixels: count,
    },
    seam: {
      maxNearEdgeErr: maxNearEdge,
      maxInteriorErr: maxInterior,
      excess: maxNearEdge - maxInterior,
      nearEdgeLimit,
    },
    seamPosition: {
      maxRoundTripDeg: maxSeamPositionError,
      points: seamPoints,
    },
  };
  for (const v of [
    result.direction.maxAngleDeg,
    result.direction.meanAngleDeg,
    result.seam.maxNearEdgeErr,
    result.seam.maxInteriorErr,
    result.seamPosition.maxRoundTripDeg,
  ]) {
    if (!Number.isFinite(v)) throw new Error('reprojection measurement is not finite');
  }
  if (result.seamPosition.points < 1) {
    throw new Error('reprojection seam position was not measurable (no seam in view)');
  }
  return result;
}

/**
 * Pass/fail policy shared by the CLI and the web status line. The limits are
 * absolute and documented, not per-run defaults. They are tight enough to
 * separate the repaired kernel from the pre-fix one:
 *
 *   metric                     repaired   pre-fix
 *   direction max error         < 0.03     up to 0.29 deg
 *   seam excess over interior   <= 0.05    ~0.28..0.31 levels
 *
 * A wrong seam or a direction error trips them and the caller must report the
 * failure rather than substitute a default.
 */
export const REPROJECTION_LIMITS = Object.freeze({
  maxDirectionErrorDeg: 0.1,
  maxSeamExcess: 0.12,
  maxSeamPositionErrorDeg: 0.001,
});

export function evaluateReprojection(measurement) {
  if (!measurement || !measurement.direction || !measurement.seam || !measurement.seamPosition) {
    return { ok: false, reasons: ['measurement missing'] };
  }
  const reasons = [];
  if (!(measurement.direction.maxAngleDeg <= REPROJECTION_LIMITS.maxDirectionErrorDeg)) {
    reasons.push(`direction error ${measurement.direction.maxAngleDeg.toFixed(3)}° exceeds ${REPROJECTION_LIMITS.maxDirectionErrorDeg}°`);
  }
  if (!(measurement.seam.excess <= REPROJECTION_LIMITS.maxSeamExcess)) {
    reasons.push(`seam excess ${measurement.seam.excess.toFixed(3)} exceeds ${REPROJECTION_LIMITS.maxSeamExcess}`);
  }
  if (!(measurement.seamPosition.maxRoundTripDeg <= REPROJECTION_LIMITS.maxSeamPositionErrorDeg)) {
    reasons.push(`seam position error ${measurement.seamPosition.maxRoundTripDeg.toExponential(2)}° exceeds limit`);
  }
  return { ok: reasons.length === 0, reasons };
}
