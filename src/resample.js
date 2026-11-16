// Pixel-domain resampling between an equirectangular image and a six-face
// cubemap. Both directions use the geometry in geometry.js so that texel
// centres, face orientation and edge matching cannot drift apart.
//
// FILTERING
//   equirect -> cube: for every face texel the exact 2x2 Jacobian of the
//     equirectangular pixel coordinate with respect to the face texel is
//     computed. When the mapped footprint is smaller than about one source
//     pixel the sampler uses bilinear reconstruction; otherwise the source
//     is integrated over the footprint parallelogram (horizontal box
//     integrals via per-row prefix sums, periodic across the ±pi seam). This
//     keeps the filter footprint proportional to the real sampling rate, so
//     pole rows (where one cube texel covers hundreds of source columns) are
//     averaged over their whole longitude arc instead of point-sampled.
//   cube -> equirect: every output pixel estimates its footprint in cube
//     texels from the direction Jacobian and averages a stratified grid of
//     directions over the pixel cell, each sampled bilinearly from whichever
//     face owns it. This crosses face borders correctly and filters the
//     (normally mild) minification.
//
// COLOUR SPACE
//   Filtering is performed on the stored 8-bit values (normally sRGB-encoded),
//   not in linear light. This matches common panorama tooling and keeps the
//   pixel values predictable for the calibration charts; it is stated in the
//   metadata as `filterSpace: "encoded"`.
//
// All data arrays are interleaved with `channels` components. Conversion
// returns Float32 data in 0..255; quantisation to bytes happens only when
// writing PNGs, so tests and round-trip metrics see the full filter output.

import { FACES, dirToFaceUV, dirToEquirectPixel, faceDirUnit, mod } from './geometry.js';

export class ImageDataF {
  constructor(width, height, channels, data) {
    this.width = width;
    this.height = height;
    this.channels = channels;
    this.data = data;
  }

  static fromUint8(width, height, channels, data) {
    return new ImageDataF(width, height, channels, Float32Array.from(data));
  }

  clone() {
    return new ImageDataF(this.width, this.height, this.channels, Float32Array.from(this.data));
  }
}

export function toUint8(image) {
  const out = new Uint8Array(image.data.length);
  for (let i = 0; i < out.length; i++) {
    const v = image.data[i];
    out[i] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
  }
  return { width: image.width, height: image.height, channels: image.channels, data: out };
}

// ---------------------------------------------------------------------------
// Bilinear primitives

/**
 * Bilinear sample where (x, y) are continuous pixel-edge coordinates: pixel
 * (0,0) covers [0,1]x[0,1]. Periodic in x when wrapX, clamped in y.
 */
export function bilinearAt(data, W, H, C, x, y, wrapX) {
  const fx = x - 0.5;
  const fy = y - 0.5;
  let x0 = Math.floor(fx);
  const tx = fx - x0;
  let y0 = Math.floor(fy);
  const ty = fy - y0;
  let x1 = x0 + 1;
  let y1 = y0 + 1;
  if (wrapX) {
    x0 = mod(x0, W);
    x1 = mod(x1, W);
  } else {
    x0 = Math.min(W - 1, Math.max(0, x0));
    x1 = Math.min(W - 1, Math.max(0, x1));
  }
  y0 = Math.min(H - 1, Math.max(0, y0));
  y1 = Math.min(H - 1, Math.max(0, y1));
  const i00 = (y0 * W + x0) * C;
  const i10 = (y0 * W + x1) * C;
  const i01 = (y1 * W + x0) * C;
  const i11 = (y1 * W + x1) * C;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  const out = new Array(C);
  for (let c = 0; c < C; c++) {
    out[c] = data[i00 + c] * w00 + data[i10 + c] * w10 + data[i01 + c] * w01 + data[i11 + c] * w11;
  }
  return out;
}

export function sampleEquirectBilinear(src, x, y) {
  return bilinearAt(src.data, src.width, src.height, src.channels, x, y, true);
}

// ---------------------------------------------------------------------------
// Prefix sums for periodic horizontal box integration

class RowIntegrator {
  constructor(image, maxCachedRows = 96) {
    this.W = image.width;
    this.H = image.height;
    this.C = image.channels;
    this.image = image;
    this.maxCachedRows = maxCachedRows;
    this.cache = new Map();
    // Whole-row sums let wide (polar) intervals be evaluated in O(1) plus
    // two edge partial sums instead of summing thousands of columns.
    this.rowSums = new Float64Array(image.height * image.channels);
    const { data, width: W, channels: C } = image;
    for (let y = 0; y < image.height; y++) {
      const base = y * W * C;
      for (let x = 0; x < W; x++) {
        for (let c = 0; c < C; c++) this.rowSums[y * C + c] += data[base + x * C + c];
      }
    }
  }

  rowPrefix(y) {
    let prefix = this.cache.get(y);
    if (prefix) return prefix;
    if (this.cache.size >= this.maxCachedRows) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    const { W, C, image } = this;
    prefix = new Float32Array((W + 1) * C);
    const base = y * W * C;
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < C; c++) {
        prefix[(x + 1) * C + c] = prefix[x * C + c] + image.data[base + x * C + c];
      }
    }
    this.cache.set(y, prefix);
    return prefix;
  }

  /** Sum of pixel areas in [0, x) for a row, x in [0, W]. */
  partial(y, x) {
    const W = this.W;
    const C = this.C;
    const out = new Array(C);
    if (x <= 0) {
      out.fill(0);
      return out;
    }
    if (x >= W) {
      for (let c = 0; c < C; c++) out[c] = this.rowSums[y * C + c];
      return out;
    }
    const i = Math.floor(x);
    const f = x - i;
    const prefix = this.rowPrefix(y);
    const base = y * W * C;
    for (let c = 0; c < C; c++) {
      out[c] = prefix[i * C + c] + f * this.image.data[base + i * C + c];
    }
    return out;
  }

  /** Periodic integral from 0 to an arbitrary real x. */
  integral(y, x) {
    const W = this.W;
    const k = Math.floor(x / W);
    const xr = x - k * W;
    const part = this.partial(y, xr);
    if (k === 0) return part;
    const C = this.C;
    for (let c = 0; c < C; c++) part[c] += k * this.rowSums[y * C + c];
    return part;
  }

  /** Mean value over a periodic interval [x0, x1] (pixel values). */
  intervalMean(y, x0, x1, out) {
    const len = x1 - x0;
    if (len <= 0) return false;
    const a = this.integral(y, x0);
    const b = this.integral(y, x1);
    for (let c = 0; c < this.C; c++) out[c] = (b[c] - a[c]) / len;
    return true;
  }
}

// ---------------------------------------------------------------------------
// equirect -> cube

function clipPolygonY(poly, value, keepAbove) {
  const out = [];
  const inside = (p) => (keepAbove ? p.y >= value - 1e-12 : p.y <= value + 1e-12);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ain = inside(a);
    const bin = inside(b);
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (value - a.y) / (b.y - a.y);
      out.push({ x: a.x + t * (b.x - a.x), y: value });
    }
  }
  return out;
}

/**
 * Projected equirect footprint of one face texel. The texel boundary is
 * sampled in direction space (8 points per edge), each sample mapped to
 * continuous source image coordinates and unwrapped across the +-180 seam.
 *
 * A boundary vertex that lies exactly on a pole has no longitude (its
 * horizontal direction components are zero, so atan2 returns an arbitrary 0).
 * Unwrapping such a vertex like any other would place the footprint apex at
 * the wrong meridian and, for the four texels that meet at an even-N pole
 * corner, fold the quarter-ring wedge into a bogus 90..180 degree span. We
 * therefore drop the degenerate longitude and replace the polar vertex with
 * the two adjacent boundary longitudes at the pole row, which is the true
 * sector boundary in equirect space.
 */
function texelFootprintPolygon(face, i, j, N, W, H) {
  const u = -1 + (2 * (i + 0.5)) / N;
  const v = -1 + (2 * (j + 0.5)) / N;
  const half = 1 / N;
  const n = faceTexelDir(face, i, j, N);
  const center = dirToEquirectPixel(n[0], n[1], n[2], W, H);
  const cx = center.x;
  const cy = center.y;
  const K = 8;
  const samples = [];
  const corners = [
    [u - half, v - half],
    [u + half, v - half],
    [u + half, v + half],
    [u - half, v + half],
  ];
  for (let e = 0; e < 4; e++) {
    const a = corners[e];
    const b = corners[(e + 1) % 4];
    for (let k = 0; k < K; k++) {
      const t = k / K;
      const uu = a[0] + (b[0] - a[0]) * t;
      const vv = a[1] + (b[1] - a[1]) * t;
      const d = faceDirUnitLocal(face, uu, vv);
      const p = dirToEquirectPixel(d[0], d[1], d[2], W, H);
      samples.push({
        x: cx + mod(p.x - cx + W / 2, W) - W / 2,
        y: p.y,
        polar: Math.hypot(d[0], d[2]) < 1e-12,
      });
    }
  }
  const poly = [];
  for (let k = 0; k < samples.length; k++) {
    const s = samples[k];
    if (!s.polar) {
      poly.push(s);
      continue;
    }
    // Replace the pole vertex with the longitudes of the nearest non-polar
    // vertices on either side: the footprint boundary reaches the pole along
    // two meridians, so in equirect space its top edge is the interval
    // between them at y = 0.
    let prev = null;
    let next = null;
    for (let d = 1; d < samples.length && prev === null; d++) {
      const q = samples[(k - d + samples.length) % samples.length];
      if (!q.polar) prev = q;
    }
    for (let d = 1; d < samples.length && next === null; d++) {
      const q = samples[(k + d) % samples.length];
      if (!q.polar) next = q;
    }
    if (prev && next) {
      poly.push({ x: prev.x, y: s.y, polar: true });
      poly.push({ x: next.x, y: s.y, polar: true });
    } else {
      poly.push({ x: cx, y: s.y, polar: true });
    }
  }
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const p of poly) {
    if (p.x < xMin) xMin = p.x;
    if (p.x > xMax) xMax = p.x;
    if (p.y < yMin) yMin = p.y;
    if (p.y > yMax) yMax = p.y;
  }
  // The +-Y texel that contains the pole direction covers all longitudes.
  // For odd N the pole is the texel centre; for even N it is a shared
  // corner and the four adjacent texels are quarter-ring wedges instead.
  const ringRows = (face === 2 || face === 3) && Math.abs(u) < half && Math.abs(v) < half;
  // A pole-containing texel covers every latitude between the pole and its
  // lowest boundary row. The sampled boundary alone starts at the first
  // latitude ring inside the texel, which would silently drop the polar cap
  // rows (including the pole row itself) from the average.
  if (ringRows) {
    if (face === 2) yMin = 0;
    else yMax = H;
  }
  return {
    poly,
    cx,
    cy,
    xSpan: xMax - xMin,
    ySpan: yMax - yMin,
    yMin,
    yMax,
    ringRows,
  };
}

function faceDirUnitLocal(face, u, v) {
  return faceDirUnit(face, u, v);
}

/**
 * Solid-angle-weighted average of the source over a projected texel footprint.
 *
 * The footprint is decomposed into source pixel rows. For each row we take the
 * exact horizontal mean over the clipped longitude interval (periodic in
 * longitude, using cached prefix sums) and weight it by the exact spherical
 * band solid angle sin(phiTop) - sin(phiBottom) of the covered part of the
 * row. This makes filter weights track the real sampling density: polar
 * texels, whose footprint can span all longitudes at nearly constant
 * latitude, are averaged over the full ring; corner texels combine two
 * longitude intervals per latitude band correctly.
 */
function integrateFootprint(integrator, footprint, W, H) {
  const C = integrator.C;
  const yMin = Math.max(0, footprint.yMin);
  const yMax = Math.min(H, footprint.yMax);
  if (!(yMax > yMin)) {
    return sampleEquirectBilinear(integrator.image, footprint.cx, footprint.cy);
  }
  const acc = new Array(C).fill(0);
  let weightSum = 0;
  const mean = new Array(C);
  const row0 = Math.floor(yMin);
  const row1 = Math.ceil(yMax);
  const dPhi = Math.PI / H;
  // A texel that contains the pole direction covers every longitude for the
  // latitudes it spans, so each row is a full ring. For even N the pole sits
  // on a texel corner and the four adjacent texels instead cover quarter-ring
  // wedges, which the per-row clipping below handles normally.
  const ringRows = footprint.ringRows;
  for (let r = row0; r < row1; r++) {
    const bandTop = Math.max(yMin, r);
    const bandBottom = Math.min(yMax, r + 1);
    if (bandBottom - bandTop <= 1e-9) continue;
    const phiTop = Math.PI / 2 - r * dPhi;
    // Solid angle of the covered part of this latitude band.
    const bandWeight = Math.max(
      0,
      Math.sin(phiTop - (bandTop - r) * dPhi) - Math.sin(phiTop - (bandBottom - r) * dPhi),
    );
    if (bandWeight <= 0) continue;
    if (ringRows) {
      integrator.intervalMean(r, 0, W, mean);
      for (let c = 0; c < C; c++) acc[c] += mean[c] * bandWeight;
      weightSum += bandWeight;
      continue;
    }
    let clipped = clipPolygonY(footprint.poly, bandTop, true);
    if (clipped.length === 0) continue;
    clipped = clipPolygonY(clipped, bandBottom, false);
    if (clipped.length === 0) continue;
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const p of clipped) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
    }
    if (!(x1 > x0)) continue;
    if (x1 - x0 > W) {
      x0 = 0;
      x1 = W;
    }
    const covered = Math.min(W, x1 - x0) / W;
    if (covered <= 1e-9) continue;
    integrator.intervalMean(r, x0, x1, mean);
    const w = bandWeight * covered;
    for (let c = 0; c < C; c++) acc[c] += mean[c] * w;
    weightSum += w;
  }
  if (weightSum <= 1e-12) {
    return sampleEquirectBilinear(integrator.image, footprint.cx, footprint.cy);
  }
  for (let c = 0; c < C; c++) acc[c] /= weightSum;
  return acc;
}

/** Sample the equirect source for one face texel with adaptive filtering. */
export function sampleSourceForTexel(src, integrator, face, i, j, N) {
  const W = src.width;
  const H = src.height;
  const fp = texelFootprintPolygon(face, i, j, N, W, H);
  if (fp.xSpan <= 1.35 && fp.ySpan <= 1.35) {
    return sampleEquirectBilinear(src, fp.cx, fp.cy);
  }
  return integrateFootprint(integrator, fp, W, H);
}

/**
 * Convert one cube face. Returns Float32 ImageDataF (channels preserved).
 */
export function equirectToCubeFace(src, face, N, options = {}) {
  const filter = options.filter ?? 'area';
  if (filter !== 'area' && filter !== 'bilinear') {
    throw new Error(`equirectToCubeFace: unknown filter "${filter}"`);
  }
  const C = src.channels;
  const integrator = filter === 'bilinear' ? null : new RowIntegrator(src);
  const out = new Float32Array(N * N * C);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let rgb;
      if (filter === 'bilinear') {
        const n = faceTexelDir(face, i, j, N);
        const p = dirToEquirectPixel(n[0], n[1], n[2], src.width, src.height);
        rgb = sampleEquirectBilinear(src, p.x, p.y);
      } else {
        rgb = sampleSourceForTexel(src, integrator, face, i, j, N);
      }
      const o = (j * N + i) * C;
      for (let c = 0; c < C; c++) out[o + c] = rgb[c];
    }
  }
  return new ImageDataF(N, N, C, out);
}

function faceTexelDir(face, i, j, N) {
  const u = -1 + (2 * (i + 0.5)) / N;
  const v = -1 + (2 * (j + 0.5)) / N;
  return faceDirUnit(face, u, v);
}

/** Convert all six faces. */
export function equirectToCube(src, N, options = {}) {
  const faces = [];
  for (let f = 0; f < 6; f++) {
    faces.push(equirectToCubeFace(src, f, N, options));
    options.onFace?.(f, faces[f]);
  }
  return faces;
}

// ---------------------------------------------------------------------------
// cube -> equirect

/** Bilinear sample from one face image, clamped inside the face. */
export function sampleFaceBilinear(faceImg, x, y) {
  const data = faceImg.data;
  const W = faceImg.width;
  const H = faceImg.height;
  const C = faceImg.channels;
  const fx = Math.min(W - 1, Math.max(0, x));
  const fy = Math.min(H - 1, Math.max(0, y));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const x1 = Math.min(W - 1, x0 + 1);
  const y1 = Math.min(H - 1, y0 + 1);
  const i00 = (y0 * W + x0) * C;
  const i10 = (y0 * W + x1) * C;
  const i01 = (y1 * W + x0) * C;
  const i11 = (y1 * W + x1) * C;
  const out = new Array(C);
  for (let c = 0; c < C; c++) {
    out[c] =
      data[i00 + c] * (1 - tx) * (1 - ty) +
      data[i10 + c] * tx * (1 - ty) +
      data[i01 + c] * (1 - tx) * ty +
      data[i11 + c] * tx * ty;
  }
  return out;
}

/**
 * Bilinear sample of the cubemap for an arbitrary direction.
 *
 * A face's bilinear stencil reaches half a texel beyond its border. Sampling
 * only the owning face would clamp those taps to the border texel, which is
 * one-sided and leaves a visible step at every cube edge. Instead each tap is
 * evaluated where it physically lies: taps inside the owning face are its
 * texels, and a tap that falls up to one texel outside is projected onto the
 * face plane, re-owned by the neighbouring face through the same
 * `dirToFaceUV` mapping and sampled there. The reconstructed surface is
 * therefore the owning face's grid extended by a one-texel apron of its
 * neighbours, which is continuous across every seam by construction.
 */
export function sampleCubeDirection(faces, x, y, z) {
  const N = faces[0].width;
  const C = faces[0].channels;
  const hit = dirToFaceUV(x, y, z);
  const f = FACES[hit.face];
  const denom = Math.max(f.F[0] * x + f.F[1] * y + f.F[2] * z, 1e-12);
  const u = (f.R[0] * x + f.R[1] * y + f.R[2] * z) / denom;
  const v = (f.D[0] * x + f.D[1] * y + f.D[2] * z) / denom;
  const fx = ((u + 1) * N) / 2 - 0.5;
  const fy = ((v + 1) * N) / 2 - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const v00 = sampleTap(faces, hit.face, x0, y0);
  const v10 = sampleTap(faces, hit.face, x0 + 1, y0);
  const v01 = sampleTap(faces, hit.face, x0, y0 + 1);
  const v11 = sampleTap(faces, hit.face, x0 + 1, y0 + 1);
  const out = new Array(C);
  for (let c = 0; c < C; c++) {
    out[c] =
      v00[c] * (1 - tx) * (1 - ty) +
      v10[c] * tx * (1 - ty) +
      v01[c] * (1 - tx) * ty +
      v11[c] * tx * ty;
  }
  return out;
}

/**
 * Value of one bilinear tap of `face`'s grid. Indices may be -1 or N, i.e. up
 * to one texel outside the stored image; such a tap is mapped to the
 * neighbouring face by direction, not clamped.
 */
function sampleTap(faces, face, i, j) {
  const N = faces[0].width;
  if (i >= 0 && i < N && j >= 0 && j < N) {
    const img = faces[face];
    const o = (j * N + i) * img.channels;
    const out = new Array(img.channels);
    for (let c = 0; c < img.channels; c++) out[c] = img.data[o + c];
    return out;
  }
  const u = -1 + (2 * (i + 0.5)) / N;
  const v = -1 + (2 * (j + 0.5)) / N;
  const dir = faceDirUnit(face, u, v);
  const hit = dirToFaceUV(dir[0], dir[1], dir[2]);
  const target = faces[hit.face];
  const fx = ((hit.u + 1) * target.width) / 2 - 0.5;
  const fy = ((hit.v + 1) * target.height) / 2 - 0.5;
  return sampleFaceBilinear(target, fx, fy);
}

/**
 * Estimate how many cube texels an equirect pixel spans, using the direction
 * Jacobian at the pixel centre and the owning face's projection.
 */
function equirectPixelFootprint(faces, theta, phi, dTheta, dPhi) {
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const n = [cp * st, sp, cp * ct];
  const dNdT = [cp * ct, 0, -cp * st];
  const dNdP = [-sp * st, cp, -sp * ct];
  const hit = dirToFaceUV(n[0], n[1], n[2]);
  const f = FACES[hit.face];
  const N = faces[hit.face].width;
  const denom = Math.max(f.F[0] * n[0] + f.F[1] * n[1] + f.F[2] * n[2], 1e-9);
  const du = (dir) => (f.R[0] * dir[0] + f.R[1] * dir[1] + f.R[2] * dir[2]) / denom;
  const dv = (dir) => (f.D[0] * dir[0] + f.D[1] * dir[1] + f.D[2] * dir[2]) / denom;
  const duT = Math.abs(du(dNdT)) * dTheta / 2;
  const duP = Math.abs(du(dNdP)) * dPhi / 2;
  const dvT = Math.abs(dv(dNdT)) * dTheta / 2;
  const dvP = Math.abs(dv(dNdP)) * dPhi / 2;
  // Full window extent in texels (u,v in [-1,1] -> N/2 texels per unit).
  const fullU = (duT + duP) * (N / 2) * 2;
  const fullV = (dvT + dvP) * (N / 2) * 2;
  return { fullU, fullV, face: hit.face, n };
}

export function cubeToEquirect(faces, W, H, options = {}) {
  const C = faces[0].channels;
  for (const f of faces) {
    if (f.width !== f.height) throw new Error('cubeToEquirect: faces must be square');
    if (f.channels !== C) throw new Error('cubeToEquirect: channel counts differ');
  }
  const out = new Float32Array(W * H * C);
  const dTheta = (2 * Math.PI) / W;
  const dPhi = Math.PI / H;
  const maxSamples = options.maxSamples ?? 6;
  const sinTheta = new Float64Array(W);
  const cosTheta = new Float64Array(W);
  for (let px = 0; px < W; px++) {
    const theta = -Math.PI + 2 * Math.PI * ((px + 0.5) / W);
    sinTheta[px] = Math.sin(theta);
    cosTheta[px] = Math.cos(theta);
  }
  for (let py = 0; py < H; py++) {
    const phi = Math.PI / 2 - Math.PI * ((py + 0.5) / H);
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    // Supersample count from the equatorial worst case in this row.
    const fp = equirectPixelFootprint(faces, 0, phi, dTheta, dPhi);
    const s = Math.max(1, Math.min(maxSamples, Math.ceil(Math.max(fp.fullU, fp.fullV) * 1.25 + 0.25)));
    const deltaTheta = new Float64Array(s);
    const sinDT = new Float64Array(s);
    const cosDT = new Float64Array(s);
    for (let sx = 0; sx < s; sx++) {
      deltaTheta[sx] = ((sx + 0.5) / s - 0.5) * dTheta;
      sinDT[sx] = Math.sin(deltaTheta[sx]);
      cosDT[sx] = Math.cos(deltaTheta[sx]);
    }
    const phiS = new Float64Array(s);
    for (let sy = 0; sy < s; sy++) phiS[sy] = phi + ((sy + 0.5) / s - 0.5) * dPhi;
    for (let px = 0; px < W; px++) {
      const st = sinTheta[px];
      const ct = cosTheta[px];
      const acc = new Array(C).fill(0);
      let wSum = 0;
      for (let sy = 0; sy < s; sy++) {
        const p = phiS[sy];
        const cps = Math.cos(p);
        const sps = Math.sin(p);
        const cosW = Math.max(0, cps);
        for (let sx = 0; sx < s; sx++) {
          // sin(theta+dt), cos(theta+dt) via angle addition.
          const x = cps * (st * cosDT[sx] + ct * sinDT[sx]);
          const z = cps * (ct * cosDT[sx] - st * sinDT[sx]);
          const rgb = sampleCubeDirection(faces, x, sps, z);
          for (let c = 0; c < C; c++) acc[c] += rgb[c] * cosW;
          wSum += cosW;
        }
      }
      const o = (py * W + px) * C;
      for (let c = 0; c < C; c++) out[o + c] = acc[c] / wSum;
    }
    options.onRow?.(py);
  }
  return new ImageDataF(W, H, C, out);
}

// ---------------------------------------------------------------------------
// Metrics

export function compareImages(a, b) {
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) {
    throw new Error('compareImages: dimension mismatch');
  }
  const C = a.channels;
  const n = a.width * a.height;
  let sumSq = 0;
  let sumAbs = 0;
  let maxAbs = 0;
  let count = 0;
  const errors = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    let pixelSq = 0;
    for (let c = 0; c < C; c++) {
      const d = a.data[p * C + c] - b.data[p * C + c];
      const ad = Math.abs(d);
      sumSq += d * d;
      sumAbs += ad;
      if (ad > maxAbs) maxAbs = ad;
      pixelSq += d * d;
      count++;
    }
    errors[p] = Math.sqrt(pixelSq / C);
  }
  const mse = sumSq / count;
  const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  const sorted = Array.from(errors).sort((x, y) => x - y);
  const pct = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    width: a.width,
    height: a.height,
    channels: C,
    mse,
    rmse: Math.sqrt(mse),
    mae: sumAbs / count,
    maxAbs,
    psnrDb: psnr,
    pixelRmseMedian: pct(0.5),
    pixelRmseP95: pct(0.95),
    pixelRmseP99: pct(0.99),
  };
}

/** Solid-angle weighted version of compareImages (accounts for pole density). */
export function compareImagesWeighted(a, b, W, H) {
  const C = a.channels;
  let sumSq = 0;
  let weight = 0;
  for (let py = 0; py < H; py++) {
    const dPhi = Math.PI / H;
    const phiTop = Math.PI / 2 - py * dPhi;
    const band = Math.sin(phiTop) - Math.sin(phiTop - dPhi);
    const rowWeight = band;
    for (let px = 0; px < W; px++) {
      const p = py * W + px;
      for (let c = 0; c < C; c++) {
        const d = a.data[p * C + c] - b.data[p * C + c];
        sumSq += d * d * rowWeight;
      }
      weight += rowWeight * C;
    }
  }
  const mse = sumSq / weight;
  return {
    mse,
    rmse: Math.sqrt(mse),
    psnrDb: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse),
  };
}
