// Foldable cube net derived from the edge adjacency table.
//
// A cube net lays the six faces flat so that the edges drawn between adjacent
// tiles are real physical cube edges. A flat net can only follow a spanning
// tree of the cube graph: the other edges are "cuts". Because the faces are
// stored in outward-camera orientation, some tiles are rotated on the page so
// that shared edges line up; no tile is mirrored (unfolding a face is a
// rotation, never a reflection).
//
// This module enumerates spanning trees of the cube graph, places tiles with
// the rotation that puts each tree edge on the correct side, rejects layouts
// where tiles overlap, and picks the most compact one. The result is checked
// against EDGE_ADJACENCY by tests, so the net cannot silently disagree with
// the 3D mapping.
//
// Coordinates: cell (col,row), col grows right, row grows down. Tile rotation
// `rot` is clockwise in degrees. A stored face coordinate (u,v), u = image
// right, v = image down, lands on the page at Rcw(rot) * (u,v).

import { EDGE_ADJACENCY, FACES } from './geometry.js';

const SIDE_VECTOR = {
  top: [0, -1],
  right: [1, 0],
  bottom: [0, 1],
  left: [-1, 0],
};

const ROTATIONS = [0, 90, 180, 270];

function rotateCW(vec, deg) {
  const steps = ((deg / 90) % 4 + 4) % 4;
  let [x, y] = vec;
  for (let i = 0; i < steps; i++) {
    const nx = -y;
    const ny = x;
    x = nx;
    y = ny;
  }
  return [x, y];
}

function sameVec(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function rotationForSide(side, target) {
  for (const rot of ROTATIONS) {
    if (sameVec(rotateCW(SIDE_VECTOR[side], rot), target)) return rot;
  }
  return null;
}

// Undirected adjacency: physical neighbour across each side.
const ADJ = [];
for (let face = 0; face < 6; face++) ADJ.push([]);
for (const e of EDGE_ADJACENCY) {
  ADJ[e.face].push({ neighbor: e.neighbor, side: e.edge, neighborSide: e.neighborEdge });
}

// Cube graph edge list, deduplicated undirected.
const UNDIRECTED = [];
for (let a = 0; a < 6; a++) {
  for (const { neighbor, side, neighborSide } of ADJ[a]) {
    if (a < neighbor) UNDIRECTED.push({ a, b: neighbor, sideA: side, sideB: neighborSide });
  }
}

function combinations(n, k) {
  const out = [];
  const pick = (start, chosen) => {
    if (chosen.length === k) {
      out.push(chosen.slice());
      return;
    }
    for (let i = start; i < n; i++) {
      chosen.push(i);
      pick(i + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  return out;
}

/** Try to lay out the cube as a flat net along the given spanning tree. */
function tryTree(edges, root) {
  const tree = Array.from({ length: 6 }, () => []);
  for (const { a, b, sideA, sideB } of edges) {
    tree[a].push({ neighbor: b, mySide: sideA, neighborSide: sideB });
    tree[b].push({ neighbor: a, mySide: sideB, neighborSide: sideA });
  }
  const placement = new Array(6).fill(null);
  placement[root] = { col: 0, row: 0, rot: 0 };
  const occupied = new Map([[`0,0`, root]]);
  const queue = [root];

  while (queue.length) {
    const face = queue.shift();
    const p = placement[face];
    for (const link of tree[face]) {
      if (placement[link.neighbor]) continue;
      const out = rotateCW(SIDE_VECTOR[link.mySide], p.rot);
      const cell = { col: p.col + out[0], row: p.row + out[1] };
      const rot = rotationForSide(link.neighborSide, [-out[0], -out[1]]);
      if (rot === null) return null;
      const key = `${cell.col},${cell.row}`;
      if (occupied.has(key)) return null;
      occupied.set(key, link.neighbor);
      placement[link.neighbor] = { ...cell, rot };
      queue.push(link.neighbor);
    }
  }
  if (placement.some((p) => p === null)) return null;

  // Prefer nets whose cut edges also happen to line up (fewer visible seams).
  let alignedCuts = 0;
  for (const { a, b, sideA } of UNDIRECTED) {
    const pa = placement[a];
    const pb = placement[b];
    const out = rotateCW(SIDE_VECTOR[sideA], pa.rot);
    if (pb.col - pa.col === out[0] && pb.row - pa.row === out[1]) {
      const expected = rotationForSide(
        ADJ[a].find((x) => x.neighbor === b).neighborSide,
        [-out[0], -out[1]],
      );
      if (pb.rot === expected) alignedCuts++;
    }
  }

  const cells = placement.map((p) => p);
  const minCol = Math.min(...cells.map((c) => c.col));
  const minRow = Math.min(...cells.map((c) => c.row));
  const maxCol = Math.max(...cells.map((c) => c.col));
  const maxRow = Math.max(...cells.map((c) => c.row));
  return {
    placement: placement.map((p) => ({ col: p.col - minCol, row: p.row - minRow, rot: p.rot })),
    cols: maxCol - minCol + 1,
    rows: maxRow - minRow + 1,
    alignedCuts,
  };
}

export function buildCubeNet(root = 4) {
  let best = null;
  for (const combo of combinations(UNDIRECTED.length, 5)) {
    const edges = combo.map((i) => UNDIRECTED[i]);
    const layout = tryTree(edges, root);
    if (!layout) continue;
    if (!layout.placement.every((p) => p)) continue;
    // Prefer compact, cross-shaped nets (4x3 with four tiles in a row and
    // one above/below) over long 5x2 strips, then prefer maximum cut-edge
    // alignment, then the most even aspect ratio.
    const wide = Math.max(layout.cols, layout.rows);
    const tall = Math.min(layout.cols, layout.rows);
    const isCross = layout.cols === 4 && layout.rows === 3;
    const score =
      (isCross ? 0 : 1000) +
      (wide > 4 ? 200 : 0) +
      (wide - tall) * 5 +
      (layout.alignedCuts === 5 ? 0 : 30);
    if (!best || score < best.score) best = { ...layout, score, edges };
  }
  if (!best) throw new Error('net: no non-overlapping cube net found');
  const tiles = best.placement.map((p, face) => ({
    face,
    name: FACES[face].name,
    col: p.col,
    row: p.row,
    rot: p.rot,
  }));
  return { tiles, cols: best.cols, rows: best.rows, root, edges: best.edges };
}

export const CUBE_NET = buildCubeNet(4);

/** Page coordinates (x right, y down, tile spans 0..1) for stored u,v. */
export function faceToNet(tile, u, v) {
  const s = rotateCW([u, v], tile.rot);
  return { x: (s[0] + 1) / 2, y: (s[1] + 1) / 2 };
}

/** Stored face coordinates for a page point inside a tile (x,y in 0..1). */
export function netToFace(tile, x, y) {
  const s = [x * 2 - 1, y * 2 - 1];
  const uv = rotateCW(s, (360 - tile.rot) % 360);
  return { u: uv[0], v: uv[1] };
}
