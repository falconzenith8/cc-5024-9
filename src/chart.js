// Calibration chart: a pure function of direction with closed-form expected
// colours. It is used both as a human-readable diagnostic image and as the
// analytic ground truth for orientation / filtering tests.
//
// Contents:
//   * 6 face plates with unique colours and face labels (+X..-Z) drawn upright
//     in that face's stored image orientation, plus a face number digit.
//   * A longitude/latitude graticule every 15 degrees, labelled by colour
//     (prime meridian yellow, equator orange).
//   * A low-frequency latitude/longitude checker for visual orientation.
//   * High-frequency checker quads at known places, including across the
//     +-180 seam and in both polar caps, for filter / aliasing tests.
//   * Per-plate orientation markers: a white disc toward image-up and a dark
//     disc toward image-right. They make flips and rotations unambiguous.
//
// The plates leave their exact centre untouched (label is above centre,
// markers off-centre), so the colour at the six pure axis directions is the
// plate colour. Tests assert that mapping independently.

import { FACES, anglesToDir, dirToAngles, dirToFaceUV } from './geometry.js';

export const FACE_COLORS = Object.freeze([
  [230, 60, 60],   // +X red
  [60, 170, 230],  // -X cyan
  [80, 190, 90],   // +Y green
  [225, 160, 50],  // -Y orange
  [90, 90, 220],   // +Z blue
  [200, 70, 200],  // -Z magenta
]);

export const PLATE_UV_HALF = Math.tan(0.30);

const DEG = Math.PI / 180;

const LABELS = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];

// High-frequency checker quads, positioned away from the face plates and
// away from the graticule lines (so a quad's analytic mean is well defined).
export const CHECKER_QUADS = Object.freeze([
  { lon: 47.2, lat: 36.7, halfLon: 5, halfLat: 5, cellDeg: 1.2 },
  { lon: -133.3, lat: -21.1, halfLon: 5, halfLat: 5, cellDeg: 1.2 },
  { lon: 121.4, lat: 63.2, halfLon: 4, halfLat: 4, cellDeg: 1.0 },
  { lon: -58.7, lat: -66.3, halfLon: 4, halfLat: 4, cellDeg: 1.0 },
  { lon: 180, lat: 41.3, halfLon: 4, halfLat: 6, cellDeg: 1.0 },
]);

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function owningFaceUV(x, y, z) {
  // Delegate to the authoritative mapping so the chart's plate orientation
  // cannot drift from the stored face convention (the -Z image uses
  // v = -y/az, unlike the naive reading of the -Z camera).
  return dirToFaceUV(x, y, z);
}

function drawPlate(face, u, v) {
  const h = PLATE_UV_HALF;
  const fc = FACE_COLORS[face];

  // Label occupies the upper-middle of the plate. Draw the characters from
  // thick line segments in plate coordinates so they stay legible at any face
  // resolution and are visibly upright in the stored (image-right, image-down)
  // orientation. Each glyph spans `gw` wide and `gh` tall with stroke `sw`.
  const label = LABELS[face];
  const plateW = 2 * h;
  const labelW = plateW * 0.5;
  const labelH = plateW * 0.22;
  const labelTop = -plateW * 0.3;
  const gw = labelW / 2; // two characters
  const totalGap = gw * 0.32;
  const len = label.length;
  const span = len * gw + (len - 1) * totalGap;
  const startX = -span / 2;
  for (let ci = 0; ci < len; ci++) {
    const gx0 = startX + ci * (gw + totalGap);
    const glyph = label[ci];
    const stroke = Math.min(gw, labelH) * 0.2;
    const ink = glyphInk(glyph, u, v, gx0, labelTop, gw, labelH, stroke);
    if (ink) return face < 2 ? [250, 250, 250] : [20, 20, 24];
  }

  // Face number digit, lower-left, upright in image orientation.
  const digit = String(face);
  const dW = plateW * 0.14;
  const dH = plateW * 0.22;
  const dx = -plateW * 0.33;
  const dy = plateW * 0.16;
  if (glyphInk(digit, u, v, dx, dy, dW, dH, Math.min(dW, dH) * 0.16)) return [250, 250, 250];

  // Orientation markers at the image-up and image-right plate edges. Placed
  // outside the label box so they never overwrite a glyph: white disc near
  // image-up, dark disc near image-right. An upside-down or mirrored face
  // moves these relative to the label immediately.
  if (Math.hypot(u - 0, v + 0.8 * h) < 0.1 * h) return [255, 255, 255];
  if (Math.hypot(u - 0.8 * h, v - 0) < 0.1 * h) return [18, 18, 22];

  // Keyline.
  const edge = Math.max(Math.abs(u), Math.abs(v));
  if (edge > 0.965 * h) return [20, 20, 24];
  if (edge > 0.9 * h) return [245, 245, 245];

  return [fc[0], fc[1], fc[2]];
}

/**
 * Ink test for one glyph centred at (x0 + w/2, y0 + h/2) in plate uv space.
 * Glyphs are built from thick axis-aligned and diagonal strokes.
 */
function glyphInk(glyph, u, v, x0, y0, w, h, stroke) {
  const x1 = x0 + w;
  const y1 = y0 + h;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const inside = u >= x0 && u <= x1 && v >= y0 && v <= y1;
  if (!inside) return false;
  const seg = (ax, ay, bx, by) => pointSegmentDistance(u, v, ax, ay, bx, by) <= stroke / 2;
  if (glyph === '+') {
    return seg(x0, cy, x1, cy) || seg(cx, y0, cx, y1);
  }
  if (glyph === '-') {
    return seg(x0, cy, x1, cy);
  }
  if (glyph === '0') {
    return (
      seg(x0, y0, x1, y0) || seg(x1, y0, x1, y1) ||
      seg(x1, y1, x0, y1) || seg(x0, y1, x0, y0) ||
      seg(x0, y1, x1, y0)
    );
  }
  if (glyph === '1') {
    return seg(cx, y0, cx, y1) || seg(cx - w * 0.25, y0 + h * 0.2, cx, y0);
  }
  if (glyph === '2') {
    return (
      seg(x0, y0 + h * 0.2, cx, y0) || seg(cx, y0, x1, y0 + h * 0.2) ||
      seg(x1, y0 + h * 0.2, x1, cy) || seg(x1, cy, x0, y1) ||
      seg(x0, y1, x1, y1)
    );
  }
  if (glyph === '3') {
    return (
      seg(x0, y0, x1, y0) || seg(x1, y0, x1, y1) || seg(x1, y1, x0, y1) ||
      seg(x0, cy, x1, cy)
    );
  }
  if (glyph === '4') {
    return seg(x0, y0, x0, cy) || seg(x0, cy, x1, cy) || seg(x1, y0, x1, y1);
  }
  if (glyph === '5') {
    return (
      seg(x1, y0, x0, y0) || seg(x0, y0, x0, cy) || seg(x0, cy, x1, cy) ||
      seg(x1, cy, x1, y1) || seg(x1, y1, x0, y1)
    );
  }
  if (glyph === 'X') {
    return seg(x0, y0, x1, y1) || seg(x1, y0, x0, y1);
  }
  if (glyph === 'Y') {
    return (
      seg(x0, y0, cx, cy) || seg(x1, y0, cx, cy) || seg(cx, cy, cx, y1)
    );
  }
  if (glyph === 'Z') {
    return (
      seg(x0, y0, x1, y0) || seg(x1, y0, x0, y1) || seg(x0, y1, x1, y1)
    );
  }
  return false;
}

function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

/**
 * Chart colour for a unit direction, in 0..255.
 */
export function chartColor(x, y, z) {
  const { theta, phi } = dirToAngles(x, y, z);
  const thetaDeg = theta / DEG;
  const phiDeg = phi / DEG;
  const cosPhi = Math.hypot(x, z);

  // Face plates. Plates are calibration patches and stay free of graticule
  // lines so the colour at each pure axis direction is exactly FACE_COLORS.
  const hit = owningFaceUV(x, y, z);
  const insidePlate = Math.abs(hit.u) <= PLATE_UV_HALF && Math.abs(hit.v) <= PLATE_UV_HALF;
  if (insidePlate) return drawPlate(hit.face, hit.u, hit.v);

  // Base: smooth gradient plus a 7.5 degree longitude/latitude checker.
  const latT = (phiDeg + 90) / 180;
  const cellLon = Math.floor((thetaDeg + 180) / 7.5);
  const cellLat = Math.floor((phiDeg + 90) / 7.5);
  const checker = ((cellLon + cellLat) & 1) === 0;
  const base = [34 + 52 * latT, 78 + 54 * latT, 116 + 36 * latT];
  let col = checker
    ? [base[0] + 34, base[1] + 30, base[2] + 26]
    : base;

  // Polar high-frequency checker. It lives in the cap ring outside the pole
  // plate, where equirect source rows are very wide: a point sampler aliases
  // badly, while a footprint filter must resolve the ring mean. The pattern is
  // a null-frequency 3D checker in direction space.
  if ((hit.face === 2 || hit.face === 3) && Math.max(Math.abs(hit.u), Math.abs(hit.v)) > 0.62) {
    const step = 0.02;
    const cell = Math.floor(x / step) + Math.floor(y / step) + Math.floor(z / step);
    col = ((cell & 1) === 0) ? [244, 244, 244] : [12, 12, 14];
  }

  // High-frequency checker quads at known positions.
  for (const q of CHECKER_QUADS) {
    const dLon = ((thetaDeg - q.lon + 540) % 360) - 180;
    const dLat = phiDeg - q.lat;
    if (Math.abs(dLon) < q.halfLon && Math.abs(dLat) < q.halfLat) {
      const cl = Math.floor((dLon + 180) / q.cellDeg);
      const cb = Math.floor((dLat + 180) / q.cellDeg);
      col = ((cl + cb) & 1) === 0 ? [246, 246, 246] : [10, 10, 12];
    }
  }

  // Graticule every 15 degrees.
  const lonCell = ((theta / (15 * DEG)) % 1 + 1) % 1;
  const latCell = ((phi / (15 * DEG)) % 1 + 1) % 1;
  const lonDist = Math.min(lonCell, 1 - lonCell) * 15 * DEG;
  const latDist = Math.min(latCell, 1 - latCell) * 15 * DEG;
  const lineHalf = 0.75 * DEG;
  const onLon = 1 - smoothstep(lineHalf * 0.6, lineHalf, lonDist);
  const onLat = 1 - smoothstep(lineHalf * 0.6, lineHalf, latDist);
  // Skip the pole-adjacent line noise where all meridians converge.
  if (onLon && cosPhi > 0.02) col = mix(col, [12, 12, 16], 0.75);
  if (onLat) col = mix(col, [12, 12, 16], 0.75);

  // Special lines: prime meridian and equator.
  const prime = Math.min(Math.abs(thetaDeg), Math.abs(Math.abs(thetaDeg) - 360));
  if (prime < 1.1) col = mix(col, [255, 210, 40], 0.85);
  if (Math.abs(phiDeg) < 1.1) col = mix(col, [255, 120, 20], 0.85);

  return col;
}

export function chartColorAtDir(d) {
  return chartColor(d[0], d[1], d[2]);
}

export function chartColorAtEquirect(px, py, W, H) {
  const theta = -Math.PI + (2 * Math.PI * (px + 0.5)) / W;
  const phi = Math.PI / 2 - (Math.PI * (py + 0.5)) / H;
  return chartColor(...anglesToDir(theta, phi));
}

/** Render the equirectangular chart as an 8-bit RGB image. */
export function renderChartEquirect(W, H) {
  const data = new Uint8Array(W * H * 3);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const c = chartColorAtEquirect(px, py, W, H);
      const o = (py * W + px) * 3;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
    }
  }
  return { width: W, height: H, channels: 3, data };
}

export function chartColorAtCubeTexel(face, i, j, N) {
  const a = FACES[face];
  const u = -1 + (2 * (i + 0.5)) / N;
  const v = -1 + (2 * (j + 0.5)) / N;
  const d = [
    a.F[0] + u * a.R[0] + v * a.D[0],
    a.F[1] + u * a.R[1] + v * a.D[1],
    a.F[2] + u * a.R[2] + v * a.D[2],
  ];
  const len = Math.hypot(d[0], d[1], d[2]);
  return chartColor(d[0] / len, d[1] / len, d[2] / len);
}
