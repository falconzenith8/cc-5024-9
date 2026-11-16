# Mapping specification

This document is the contract for the pixels in `output/sample/faces/*.png`.
The same information is emitted in machine-readable form as
`faces/cubemap.json`; that file is authoritative, this document explains it.

## 1. World coordinates

Right-handed world frame:

- **+X** right, **+Y** up, **+Z** forward.
- A unit direction is described by longitude `theta = atan2(x, z)` and
  latitude `phi = asin(y)`, with `theta in [-pi, pi]`, `phi in [-pi/2, pi/2]`.
- `x = cos(phi) sin(theta)`, `y = sin(phi)`, `z = cos(phi) cos(theta)`.

## 2. Equirectangular source

Image `W x H`, normally `W = 2H`. **Continuous coordinates use pixel edges**:
pixel `(0,0)` covers `[0,1] x [0,1]` and its centre is `(0.5, 0.5)`.

```
theta(px) = -pi + 2*pi*(px+0.5)/W      column 0 starts at theta = -pi
phi(py)   =  pi/2 -   pi*(py+0.5)/H    row 0 is the north pole
```

- Longitude is **periodic**: column `W-1` is adjacent to column 0. Sampling
  integrates across the ±180° meridian by wrapping, never by clamping to a
  black border (see §5).
- Latitude is clamped at the poles.

## 3. Cube faces

Six `N x N` images. Face `i` is what an outward-looking pinhole camera at the
origin sees along its centre direction. Each face is defined by three
orthonormal world vectors:

| id | name | centre `F` | image right `R` | image down `D` |
| -- | ---- | ---------- | --------------- | -------------- |
| 0  | +X   | ( 1, 0, 0) | ( 0, 0, 1)      | ( 0,-1, 0)     |
| 1  | -X   | (-1, 0, 0) | ( 0, 0,-1)      | ( 0,-1, 0)     |
| 2  | +Y   | ( 0, 1, 0) | ( 1, 0, 0)      | ( 0, 0,-1)     |
| 3  | -Y   | ( 0,-1, 0) | ( 1, 0, 0)      | ( 0, 0, 1)     |
| 4  | +Z   | ( 0, 0, 1) | (-1, 0, 0)      | ( 0,-1, 0)     |
| 5  | -Z   | ( 0, 0,-1) | ( 1, 0, 0)      | ( 0,-1, 0)     |

**Face coordinates** `(u, v)` use `u` along `R` and `v` along `D`, both in
`[-1, 1]` at the image border. The stored direction is the normalised

```
d(u, v) = F + u*R + v*D
```

**Pixel centres**: stored pixel `(i, j)` has

```
u = -1 + 2*(i+0.5)/N
v = -1 + 2*(j+0.5)/N
```

so integer pixel indices identify texel centres, and the face border lies half
a texel outside the image.

**Handedness**: for every face `det(R, D, F) = +1` (verified in
`test/geometry.test.mjs`). The frames are right-handed and consistent, which
is what makes neighbouring faces meet without a mirrored or rotated seam.

**No face is stored upside down**: `D` always has a non-positive world-Y
component for the four side faces, so image rows increase downward. The polar
caps carry the page orientation instead: `+Y` has `+Z` pointing up in its
image, `-Y` has `-Z` pointing up. That keeps the caps aligned with the side
faces at the poles rather than rotated by an arbitrary multiple of 90°.

## 4. Edge consistency

The 12 cube edges are derived from geometry (`computeEdgeAdjacency`), not
hand-written. For each face and each of its four sides, the edge is walked in
image order:

- top: `u` from -1 to +1 at `v = -1`
- right: `v` from -1 to +1 at `u = +1`
- bottom: `u` from +1 to -1 at `v = +1`
- left: `v` from +1 to -1 at `u = -1`

The neighbour is found by probing just outside the edge and projecting the
shared directions onto the neighbour's basis. For a correctly oriented cube
**every** edge is traversed in the *opposite* direction by its two faces —
the standard cube-net orientation. All 24 face-edges (12 undirected) are
listed in `cubemap.json` with `traversal: "opposite"`.

A direction on a shared edge maps to the same world direction from both
faces; this is asserted to 1e-14 for every edge in the test suite. Since a
cube cannot be unfolded into a plane without cuts, the viewer's cube net
follows a 5-edge spanning tree; the remaining 7 edges are cuts, and the
net layout is derived from the same adjacency table (`src/net.js`).

## 5. Filtering and seams

sRGB-encoded values are filtered directly; `linearLight` is **false** in the
metadata. This matches common panorama tooling and keeps the calibration
chart's byte values predictable.

### equirect → cube (`filter: "area"`, the default)

For each face texel the exact projected footprint of the texel is computed in
equirect image space (the texel boundary is sampled in direction space and
mapped to source pixel coordinates), and the source is integrated over it:

- The footprint is decomposed into source pixel rows. Each row contributes
  with the exact spherical band solid angle
  `sin(phi_top) - sin(phi_bottom)` of the covered latitude slice, and the
  horizontal mean over the covered longitude interval.
- Longitude integration is **periodic**, via lazy per-row prefix sums, so a
  footprint that crosses the ±180° seam is integrated across the wrap. There
  is no black border and no clamped edge column.
- The `±Y` texel containing the pole covers every longitude; it is treated as
  a full ring so it is averaged over all source columns rather than
  point-sampled. For even `N` the pole sits on a texel corner and the four
  adjoining texels are quarter-ring wedges, handled by the same per-row
  clipping.
- Footprints smaller than about 1.35 source pixels fall back to bilinear
  reconstruction to avoid over-blurring.

The filter footprint therefore tracks the real sampling density: it is
narrow near the equator and wide in the polar rows, which suppresses
aliasing where one cube texel covers many source columns.

### cube → equirect

Every output pixel estimates its footprint in cube texels from the direction
Jacobian and averages a stratified grid of directions over the pixel cell.
Each direction is sampled **bilinearly through an extension grid**: the four
stencil taps are computed in the owning face's pixel coordinates, and any tap
that falls outside the face is re-projected onto the neighbouring face with
`dirToFaceUV` and bilinearly sampled there. The two faces are therefore
blended by construction across a shared edge, so a reconstructed panorama is
continuous instead of showing a hard step; no edge column is copied to mask
the seam. The supersample count is derived from the row's worst-case
footprint (capped by `--maxSamples`, default 6).

The area filter's polar handling is equally explicit. The `±Y` texel at the
pole covers all longitudes; its footprint is extended to the pole row so the
polar cap is not dropped, and a degenerate pole vertex (`atan2(0,0)`) is
unwrapped against its neighbouring non-polar vertices so a quarter-ring wedge
is not folded into a 90–180° span. These cases are pinned by
`test/boundary.test.mjs`.

## 5b. Panorama reprojection

`src/reproject.js` renders the faces under a selectable camera without adding
a second sampling implementation: every output pixel becomes a unit direction
and is passed to `sampleCubeDirection`, i.e. the repaired cube→equirect
kernel above. Two projections are defined:

- **rectilinear** — `C = anglesToDir(yaw, pitch)`, `R = normalize(cross(+Y, C))`,
  `U = cross(C, R)`, `focal = 1/tan(fov/2)`. The centre ray is exactly `C`
  and the vertical fov spans `fov` between edge rays.
- **equirectangular** — `lon = -pi + 2*pi*(px+0.5)/W + yaw`,
  `lat = clamp(pi/2 - pi*(py+0.5)/H + pitch, ∓pi/2)`; latitude clamps at the
  poles rather than overflowing.

The 12 seam polylines are the geometry edge table sampled in direction space
and projected with the same `projectDirection` used for the overlay, so a
drawn seam cannot drift from the rendered sphere. `measureReprojection`
reports three absolute quantities:

| metric | definition | limit |
| ------ | ---------- | ----- |
| direction error | max angle between the decoded direction of a direction-encoded cubemap pixel and the requested ray | 0.1° |
| seam difference | worst error within 1.5 texels of a cube edge minus the interior error | 0.12 |
| seam position | max round-trip angle of a projected seam point | 0.001° |

A measurement that is non-finite or has no seam in view throws; the CLI and
the web panel surface that as a failure. The limits are not per-run defaults:
the pre-fix kernel produces direction error up to 0.29° and seam excess
≈0.3, which trips them, while the repaired kernel stays below 0.03° and
0.05. Evidence runs are written to `output/sample/reprojection-verify.json`
by `npm run verify:reproject`.

## 6. Resampling loss (quantified)

**Cube → equirect is a resampling operation and is not byte-lossless.** The
six faces store a finite number of samples; reconstructing a panorama
re-integrates them onto a different pixel grid. Any detail above the cube
sampling rate is gone, and even well-sampled smooth content is resampled and
quantised.

The tool measures this rather than claiming losslessness. On the bundled
calibration chart (`chart-equirect.png`, 2048×1024 → six 512×512 faces →
back to 2048×1024):

| metric | value |
| ------ | ----- |
| PSNR | ≈ 23.3 dB |
| MAE | ≈ 6.1 / 255 |

That chart deliberately contains near-Nyquist checker quads and hard
graticule lines, so its round-trip PSNR is low by design; it demonstrates
that the reconstruction pipeline is really operating on pixels. On a smooth
analytic field the same pipeline measures >45 dB PSNR and <0.5/255 MAE with a
few levels of maximum error. Both numbers are written to
`faces/cubemap.json` (`metrics.roundTrip`, `metrics.roundTripSolidAngle`,
`metrics.vsAnalyticChart`) and to `output/sample/roundtrip.json`.

The test suite asserts that the loss is non-zero (no byte-for-byte identity)
and that the recorded metrics match a fresh measurement.

## 7. Metadata (`faces/cubemap.json`)

Top-level fields:

- `version`, `format`, `direction`, `engine`, `createdAt`
- `filter` — `"area"` or `"bilinear"`
- `faceSize` — `N`
- `source` — input file name and dimensions
- `files` — six entries `{ face, name, file }` in face-id order
- `mapping` — the full mapping contract (below)
- `metrics` — measured round-trip and per-face accuracy
- `elapsedMs`

`mapping` contains `world` (axes, longitude/latitude formulas, pixel-centre
convention, seam policy), `faceSize`, `faceOrder`, per-face `faces` entries
with `centreDirection` / `imageRightWorld` / `imageDownWorld` /
`uvToDirection` / `pixelCentre`, all 24 `edges` with `traversal`, the
`edgeSideBasis`, `seamPolicy`, and `filtering`. Consumers (including the web
viewer) read this file rather than hard-coding assumptions.

A `cube-to-equirect` output writes a sibling JSON with the same `mapping`
block plus the output dimensions.

## 8. Calibration chart

`chart-equirect.png` is a pure function of direction with closed-form
expected colours, used as analytic ground truth:

- six face plates with unique colours and upright face labels + numbers
- white/dark orientation discs toward image-up / image-right of each plate
- a 15° longitude/latitude graticule, prime meridian and equator highlighted
- low-frequency latitude/longitude checker
- high-frequency checker quads at known places, including across the ±180°
  seam and in both polar caps

Tests assert the six axis directions carry exactly the six plate colours in
the real PNGs, the orientation markers sit where an upright face requires,
and the chart round-trip is measurably lossy.

## 9. Tooling

```
node bin/cli.mjs equirect-to-cube <input.png> <outDir> --size N [--filter area|bilinear]
node bin/cli.mjs cube-to-equirect <facesDir> <out.png> [--width W] [--height H] [--maxSamples S]
node bin/cli.mjs build-sample <outDir> [--size N] [--source-width W]
node bin/cli.mjs info <facesDir>
node bin/cli.mjs verify-reproject [report.json] [--size N]

npm test          # geometry, filtering, seams, boundaries, round-trip, PNG, net, manifest
npm run serve     # viewer at http://localhost:4173/web/  (Panorama reprojection view)
npm run verify:web  # headless-browser acceptance checks
npm run verify:reproject  # writes output/sample/reprojection-verify.json
npm run evidence:boundary # before/after probes -> output/sample/boundary-evidence.json
```

`output/sample/reprojection-prefix-failure.json` is the same six-view
verification run against the pre-fix kernel (`test/fixtures/prefix-kernel`).
All six runs fail the absolute limits; it is kept as failure evidence and is
never overwritten by a successful run.

### Launching the UI

`npm run serve` starts a dependency-free static server on port 4173. Open
`http://localhost:4173/web/`, then:

1. Click **Panorama reprojection** in the View group.
2. Drag on the image to rotate (rectilinear) or pan (equirectangular).
3. Choose **Rectilinear** or **Equirectangular** in the Reprojection select.
4. Read **Reprojection verification** on the right: it re-runs the kernel on
   every orientation and projection change and shows the measured direction
   error, seam difference and seam-position error, or FAIL with the reason.

There is no build step; the page loads `src/*.js` as ES modules directly.

