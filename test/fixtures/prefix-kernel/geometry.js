// Spherical geometry for equirectangular <-> cube map conversion.
//
// WORLD / SOURCE CONVENTION
//   +X right, +Y up, +Z forward (right-handed).
//   Direction from longitude theta and latitude phi:
//     x = cos(phi) * sin(theta)
//     y = sin(phi)
//     z = cos(phi) * cos(theta)
//   theta in [-pi, pi] (column axis, periodic), phi in [-pi/2, pi/2].
//
// EQUIRECTANGULAR IMAGE
//   Pixel (px, py), 0 <= px < W, 0 <= py < H.
//   Continuous image coordinates use pixel edges: pixel (0,0) covers
//   [0,1] x [0,1] and its centre is (0.5, 0.5).
//     theta(px) = -pi + 2*pi*(px+0.5)/W
//     phi(py)   = pi/2 - pi*(py+0.5)/H
//   Column 0 starts at theta = -pi; horizontal sampling wraps periodically.
//   Row 0 is the north pole (phi = +pi/2); the last row is the south pole.
//
// CUBE FACES
//   Each face is an image of size N x N showing what a camera at the origin
//   looking outward along the face normal sees. The image row axis always
//   points down in world space (image `down` vector), so no face is stored
//   upside down. The image column axis is `right`. Both are unit vectors.
//
//   face id  name  centre F       right R (image +x)  down D (image +y)
//   0        +X    ( 1, 0, 0)     ( 0, 0, 1)          ( 0,-1, 0)
//   1        -X    (-1, 0, 0)     ( 0, 0,-1)          ( 0,-1, 0)
//   2        +Y    ( 0, 1, 0)     ( 1, 0, 0)          ( 0, 0,-1)
//   3        -Y    ( 0,-1, 0)     ( 1, 0, 0)          ( 0, 0, 1)
//   4        +Z    ( 0, 0, 1)     (-1, 0, 0)          ( 0,-1, 0)
//   5        -Z    ( 0, 0,-1)     ( 1, 0, 0)          ( 0,-1, 0)
//
//   For a face, image coordinates u,v in [-1,1] (u right, v down) map to the
//   unnormalised direction
//       D(u,v) = F + u*R + v*Down.
//   The stored pixel (i,j), i,j in [0,N-1], has its centre at
//       u = -1 + 2*(i+0.5)/N,  v = -1 + 2*(j+0.5)/N.
//
//   For every face det(R, Down, F) = +1 and the three vectors form a
//   right-handed frame. The edge directions of neighbouring faces therefore
//   agree exactly (up to the order in which an edge is traversed); tests
//   enumerate all 12 shared edges. The top (+Y) face has +Z upwards in its
//   image and the bottom (-Y) face has -Z upwards, so pole caps are not
//   rotated by an arbitrary amount relative to the side faces.
//
//   The side faces use +Y as image up, which is the natural "camera looking
//   outward" orientation. +Z uses -X as image right (because +X is to the
//   viewer's left when facing +Z), matching a right-handed camera frame.

export const FACES = Object.freeze([
  { id: 0, name: '+X', F: [1, 0, 0], R: [0, 0, 1], D: [0, -1, 0] },
  { id: 1, name: '-X', F: [-1, 0, 0], R: [0, 0, -1], D: [0, -1, 0] },
  { id: 2, name: '+Y', F: [0, 1, 0], R: [1, 0, 0], D: [0, 0, -1] },
  { id: 3, name: '-Y', F: [0, -1, 0], R: [1, 0, 0], D: [0, 0, 1] },
  { id: 4, name: '+Z', F: [0, 0, 1], R: [-1, 0, 0], D: [0, -1, 0] },
  { id: 5, name: '-Z', F: [0, 0, -1], R: [1, 0, 0], D: [0, -1, 0] },
]);

export const FACE_NAMES = Object.freeze(FACES.map((f) => f.name));
export const FACE_IDS = Object.freeze({ '+X': 0, '-X': 1, '+Y': 2, '-Y': 3, '+Z': 4, '-Z': 5 });

export const EDGE_NAMES = Object.freeze(['top', 'right', 'bottom', 'left']);
export const EDGE_SIDES = Object.freeze({ top: 'v=-1', right: 'u=+1', bottom: 'v=+1', left: 'u=-1' });

const EPS = 1e-12;

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function det3(a, b, c) {
  return dot(cross(a, b), c);
}

export function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < EPS) return [0, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** Unnormalised direction of face coordinates (u,v), both may leave [-1,1]. */
export function faceDir(face, u, v) {
  const f = FACES[face];
  return [
    f.F[0] + u * f.R[0] + v * f.D[0],
    f.F[1] + u * f.R[1] + v * f.D[1],
    f.F[2] + u * f.R[2] + v * f.D[2],
  ];
}

export function faceDirUnit(face, u, v) {
  return normalize(faceDir(face, u, v));
}

/** Unit direction of the centre of stored face pixel (i,j). */
export function texelDirection(face, i, j, N) {
  const u = -1 + (2 * (i + 0.5)) / N;
  const v = -1 + (2 * (j + 0.5)) / N;
  return faceDirUnit(face, u, v);
}

/**
 * Continuous face pixel coordinate (texel-centre coordinates, so integer
 * values are texel centres) for a direction.
 */
export function dirToFacePixel(x, y, z, N) {
  const hit = dirToFaceUV(x, y, z);
  return {
    ...hit,
    fx: ((hit.u + 1) * N) / 2 - 0.5,
    fy: ((hit.v + 1) * N) / 2 - 0.5,
  };
}

/** Face pixel centre -> direction. */
export function facePixelToDir(face, fx, fy, N) {
  return faceDirUnit(face, ((fx + 0.5) * 2) / N - 1, ((fy + 0.5) * 2) / N - 1);
}

/**
 * Find the owning cube face and image coordinates (u,v) for a direction.
 * The owning face is the axis with the largest absolute component. Ties are
 * resolved deterministically toward +X, +Y, +Z (then lower id), which is
 * only relevant on measure-zero edge directions.
 */
export function dirToFaceUV(x, y, z) {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  if (ax >= ay && ax >= az) {
    if (x >= 0) return { face: 0, u: z / ax, v: -y / ax };
    return { face: 1, u: -z / ax, v: -y / ax };
  }
  if (ay >= az) {
    if (y >= 0) return { face: 2, u: x / ay, v: -z / ay };
    return { face: 3, u: x / ay, v: z / ay };
  }
  if (z >= 0) return { face: 4, u: -x / az, v: -y / az };
  return { face: 5, u: x / az, v: -y / az };
}

export function dirToAngles(x, y, z) {
  const len = Math.hypot(x, y, z) || EPS;
  return {
    theta: Math.atan2(x, z),
    phi: Math.asin(Math.max(-1, Math.min(1, y / len))),
  };
}

export function anglesToDir(theta, phi) {
  const cp = Math.cos(phi);
  return [cp * Math.sin(theta), Math.sin(phi), cp * Math.cos(theta)];
}

/** Continuous equirectangular image coordinates of a direction. */
export function dirToEquirectPixel(x, y, z, W, H) {
  const { theta, phi } = dirToAngles(x, y, z);
  return {
    x: ((theta + Math.PI) / (2 * Math.PI)) * W,
    y: ((Math.PI / 2 - phi) / Math.PI) * H,
    theta,
    phi,
  };
}

export function equirectPixelToDir(px, py, W, H) {
  const theta = -Math.PI + (2 * Math.PI * (px + 0.5)) / W;
  const phi = Math.PI / 2 - (Math.PI * (py + 0.5)) / H;
  return anglesToDir(theta, phi);
}

/**
 * Derivatives of the unit direction n(u,v) of a face with respect to u and v.
 * Used for the exact source-footprint Jacobian.
 */
export function faceDirectionDerivatives(face, u, v) {
  const f = FACES[face];
  const D = faceDir(face, u, v);
  const len2 = dot(D, D);
  const len = Math.sqrt(len2);
  const inv3 = 1 / (len * len2);
  const R = f.R;
  const Dn = f.D;
  const rDot = dot(R, D);
  const dDot = dot(Dn, D);
  const dU = [
    (R[0] * len2 - D[0] * rDot) * inv3,
    (R[1] * len2 - D[1] * rDot) * inv3,
    (R[2] * len2 - D[2] * rDot) * inv3,
  ];
  const dV = [
    (Dn[0] * len2 - D[0] * dDot) * inv3,
    (Dn[1] * len2 - D[1] * dDot) * inv3,
    (Dn[2] * len2 - D[2] * dDot) * inv3,
  ];
  const n = [D[0] / len, D[1] / len, D[2] / len];
  return { n, dU, dV, D, len };
}

/**
 * Solid angle of one face texel, using the exact Jacobian of the mapping.
 * dOmega = |d n/du x d n/dv| du dv, with du = dv = 2/N.
 */
export function faceTexelSolidAngle(face, u, v, N) {
  const { dU, dV } = faceDirectionDerivatives(face, u, v);
  const c = cross(dU, dV);
  const du = 2 / N;
  const dv = 2 / N;
  return Math.hypot(c[0], c[1], c[2]) * du * dv;
}

/**
 * Solid angle of one equirectangular source pixel at row py (exact band).
 */
export function equirectPixelSolidAngle(py, W, H) {
  const dPhi = Math.PI / H;
  const phiTop = Math.PI / 2 - py * dPhi;
  const phiBottom = phiTop - dPhi;
  return (2 * Math.PI / W) * (Math.sin(phiTop) - Math.sin(phiBottom));
}

/**
 * The 12 cube edges, computed from geometry rather than hand-written.
 * For each face and edge, walk the edge in the face's image order:
 *   top    left -> right (u from -1 to 1, v=-1)
 *   right  top -> bottom (v from -1 to 1, u=+1)
 *   bottom right -> left (u from 1 to -1, v=+1)
 *   left   bottom -> top (v from 1 to -1, u=-1)
 * The result records the neighbour face and its edge, plus whether the
 * neighbour is traversed in the same (forward) or opposite (reversed)
 * direction.
 */
export function computeEdgeAdjacency() {
  const edges = [];
  const sampled = 17;
  for (let face = 0; face < 6; face++) {
    for (let e = 0; e < 4; e++) {
      const edge = EDGE_NAMES[e];
      const points = [];
      for (let k = 0; k < sampled; k++) {
        const t = -1 + (2 * k) / (sampled - 1);
        let u;
        let v;
        if (edge === 'top') { u = t; v = -1; }
        else if (edge === 'right') { u = 1; v = t; }
        else if (edge === 'bottom') { u = -t; v = 1; }
        else { u = -1; v = -t; }
        points.push({ t, u, v, dir: normalize(faceDir(face, u, v)) });
      }
      // Probe just OUTSIDE the edge: there the neighbouring face owns the
      // direction (just inside, the current face still wins the axis test).
      const probe = points[Math.floor(sampled / 2)];
      const probeDir = faceDir(
        face,
        probe.u + (edge === 'right' ? 0.02 : edge === 'left' ? -0.02 : 0),
        probe.v + (edge === 'top' ? -0.02 : edge === 'bottom' ? 0.02 : 0),
      );
      const hit = dirToFaceUV(...normalize(probeDir));
      const neighbor = hit.face;
      // Identify the neighbour edge by projecting the shared physical
      // directions onto the neighbour's basis (avoids tie-breaking at the
      // boundary, where two faces score equally).
      const nf = FACES[neighbor];
      const coords = points.map((p) => {
        const denom = dot(nf.F, p.dir);
        return { u: dot(nf.R, p.dir) / denom, v: dot(nf.D, p.dir) / denom };
      });
      let nEdge = null;
      for (const name of EDGE_NAMES) {
        if (name === 'top' && coords.every((c) => Math.abs(c.v + 1) < 1e-9)) nEdge = name;
        if (name === 'right' && coords.every((c) => Math.abs(c.u - 1) < 1e-9)) nEdge = name;
        if (name === 'bottom' && coords.every((c) => Math.abs(c.v - 1) < 1e-9)) nEdge = name;
        if (name === 'left' && coords.every((c) => Math.abs(c.u + 1) < 1e-9)) nEdge = name;
      }
      if (!nEdge) throw new Error(`edge adjacency: cannot identify neighbour edge for face ${face} ${edge}`);
      // Determine traversal direction along the neighbour edge.
      const a = coords[0];
      const b = coords[coords.length - 1];
      const nTraverse = edgeParameter(nEdge, a.u, a.v) < edgeParameter(nEdge, b.u, b.v) ? 1 : -1;
      edges.push({
        face,
        faceName: FACES[face].name,
        edge,
        side: EDGE_SIDES[edge],
        neighbor,
        neighborName: FACES[neighbor].name,
        neighborEdge: nEdge,
        neighborSide: EDGE_SIDES[nEdge],
        reversed: nTraverse === -1,
      });
    }
  }
  return edges;
}

function edgeParameter(edge, u, v) {
  // Parameter increases in the traversal order documented above.
  if (edge === 'top') return u;
  if (edge === 'right') return v;
  if (edge === 'bottom') return -u;
  return -v;
}

export const EDGE_ADJACENCY = Object.freeze(computeEdgeAdjacency());

/** Handedness proof value: det(R, Down, F). */
export function faceHandedness(face) {
  return det3(FACES[face].R, FACES[face].D, FACES[face].F);
}

/** Modulo helper that also works for non-integers and negative values. */
export function mod(a, n) {
  return ((a % n) + n) % n;
}
