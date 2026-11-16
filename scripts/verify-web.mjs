#!/usr/bin/env node
// Headless-browser acceptance checks for the viewer.
//
// Verifies that the page loads the generated PNGs and metadata, renders each
// view, locates the same direction in source and cube views, and that the
// browser-side geometry agrees with the Node implementation. Screenshots are
// written to output/screenshots for manual inspection.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'output', 'screenshots');
fs.mkdirSync(shots, { recursive: true });

const PORT = 4181;
const server = spawn(process.execPath, [path.join(root, 'bin/serve.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 700));

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1150 }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await page.goto(`http://localhost:${PORT}/web/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__viewerReady === true, null, { timeout: 20000 });
  check('no console errors', () => assert.deepEqual(consoleErrors, []));

  const info = await page.evaluate(() => {
    const s = window.__viewer.state;
    return {
      source: { w: s.source.width, h: s.source.height },
      faceSize: s.manifest.mapping.faceSize,
      faceCount: s.faces.length,
      files: s.manifest.files.map((f) => f.file),
      order: s.manifest.mapping.faceOrder,
      roundtripPsnr: s.roundtrip?.metrics?.psnrDb ?? null,
    };
  });
  check('six faces loaded', () => assert.equal(info.faceCount, 6));
  check('source is 2:1', () => assert.equal(info.source.w, info.source.h * 2));
  check('manifest face order', () => assert.deepEqual(info.order, ['+X', '-X', '+Y', '-Y', '+Z', '-Z']));
  check('face files listed', () => assert.equal(info.files.length, 6));
  check('roundtrip metrics visible', () => assert.ok(Number.isFinite(info.roundtripPsnr)));

  const pixelStats = async (selector) =>
    page.evaluate((sel) => {
      const c = document.querySelector(sel);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let nonBlack = 0;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] + d[i + 1] + d[i + 2] > 24) nonBlack++;
        if (seen.size < 6000) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      }
      return { nonBlack, total: d.length / 4, distinct: seen.size };
    }, selector);

  const sphereStats = await pixelStats('#main-canvas');
  check('source view renders image data', () => {
    assert.ok(sphereStats.nonBlack > sphereStats.total * 0.5, `${sphereStats.nonBlack}/${sphereStats.total}`);
    assert.ok(sphereStats.distinct > 200, `${sphereStats.distinct} colours`);
  });
  await page.screenshot({ path: path.join(shots, 'view-sphere.png') });

  const agreement = await page.evaluate(async () => {
    const geo = await import('/src/geometry.js');
    const v = window.__viewer;
    let maxAngleErr = 0;
    let faceMismatch = 0;
    let uvErr = 0;
    let s = 1234567;
    const rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let k = 0; k < 3000; k++) {
      const theta = (rand() * 2 - 1) * Math.PI;
      const phi = (rand() * 2 - 1) * (Math.PI / 2 - 1e-4);
      const cp = Math.cos(phi);
      const d = [cp * Math.sin(theta), Math.sin(phi), cp * Math.cos(theta)];
      const a = v.faceUVFromDir(...d);
      const b = geo.dirToFaceUV(...d);
      if (a.face !== b.face) faceMismatch++;
      uvErr = Math.max(uvErr, Math.abs(a.u - b.u), Math.abs(a.v - b.v));
      const n1 = v.faceDir(a.face, a.u, a.v);
      const n2 = geo.faceDir(b.face, b.u, b.v);
      const dot = (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]) / (Math.hypot(...n1) * Math.hypot(...n2));
      maxAngleErr = Math.max(maxAngleErr, Math.acos(Math.min(1, Math.max(-1, dot))));
    }
    return { maxAngleErr, faceMismatch, uvErr };
  });
  check('browser face ownership matches Node', () => assert.equal(agreement.faceMismatch, 0));
  check('browser face uv matches Node', () => assert.ok(agreement.uvErr < 1e-12, `uv error ${agreement.uvErr}`));
  check('browser face axes match Node', () => assert.ok(agreement.maxAngleErr < 1e-6, `angle ${agreement.maxAngleErr}`));

  const clickSphere = async (theta, phi) => {
    await page.click('[data-view="sphere"]');
    await page.waitForTimeout(80);
    const point = await page.evaluate(
      ({ theta, phi }) => {
        const c = document.getElementById('main-canvas');
        const r = c.getBoundingClientRect();
        const rect = window.__viewer.state.sourceRect;
        const x = rect.ox + ((theta + Math.PI) / (2 * Math.PI)) * rect.dw;
        const y = rect.oy + ((Math.PI / 2 - phi) / Math.PI) * rect.dh;
        return { clientX: r.left + (x / c.width) * r.width, clientY: r.top + (y / c.height) * r.height };
      },
      { theta, phi },
    );
    await page.mouse.click(point.clientX, point.clientY);
    return page.evaluate(() => ({
      theta: window.__viewer.state.selected.theta,
      phi: window.__viewer.state.selected.phi,
      face: document.getElementById('loc-face').textContent,
      source: document.getElementById('loc-source').textContent,
      faceColour: document.getElementById('loc-face-color').textContent,
    }));
  };

  const z = await clickSphere(0, 0);
  check('click +Z -> +Z face', () => assert.match(z.face, /^\+Z/));
  check('click +Z -> centre pixel', () => assert.match(z.face, /@ 256, 256/));
  check('+Z axis face colour is blue', () => assert.match(z.faceColour, /rgb\(90, 90, 220\)/));

  const xAxis = await clickSphere(Math.PI / 2, 0);
  check('click +X -> +X face', () => assert.match(xAxis.face, /^\+X/));
  const nxAxis = await clickSphere(-Math.PI / 2, 0);
  check('click -X -> -X face', () => assert.match(nxAxis.face, /^-X/));
  const yAxis = await clickSphere(0, Math.PI / 2);
  check('click north pole -> +Y face', () => assert.match(yAxis.face, /^\+Y/));
  const nyAxis = await clickSphere(0, -Math.PI / 2 + 1e-6);
  check('click south pole -> -Y face', () => assert.match(nyAxis.face, /^-Y/));
  const nzAxis = await clickSphere(Math.PI, 0);
  check('click -Z -> -Z face', () => assert.match(nzAxis.face, /^-Z/));
  check('-Z axis face colour is magenta', () => assert.match(nzAxis.faceColour, /rgb\(200, 70, 200\)/));

  await page.click('[data-view="cube"]');
  await page.waitForTimeout(100);
  const cubeStats = await pixelStats('#main-canvas');
  check('cube net renders six face images', () => assert.ok(cubeStats.distinct > 150, `${cubeStats.distinct} colours`));
  await page.screenshot({ path: path.join(shots, 'view-cube.png') });

  const clickFaceCentre = async (face) => {
    const point = await page.evaluate((face) => {
      const r = window.__viewer.state.cubeRects.find((x) => x.face === face);
      const c = document.getElementById('main-canvas');
      const br = c.getBoundingClientRect();
      return {
        clientX: br.left + ((r.x + r.w / 2) / c.width) * br.width,
        clientY: br.top + ((r.y + r.h / 2) / c.height) * br.height,
      };
    }, face);
    await page.mouse.click(point.clientX, point.clientY);
    return page.evaluate(() => ({
      face: document.getElementById('loc-face').textContent,
      theta: window.__viewer.state.selected.theta,
      phi: window.__viewer.state.selected.phi,
    }));
  };

  const centre = await clickFaceCentre(4);
  check('cube +Z centre -> +Z direction', () => {
    assert.match(centre.face, /^\+Z/);
    assert.ok(Math.abs(centre.theta) < 1e-6 && Math.abs(centre.phi) < 1e-6);
  });
  const cx = await clickFaceCentre(0);
  check('cube +X centre -> lon +90', () => {
    assert.match(cx.face, /^\+X/);
    assert.ok(Math.abs(cx.theta - Math.PI / 2) < 1e-6, `theta ${cx.theta}`);
  });
  const cy = await clickFaceCentre(2);
  check('cube +Y centre -> lat +90', () => {
    assert.match(cy.face, /^\+Y/);
    assert.ok(Math.abs(cy.phi - Math.PI / 2) < 1e-6, `phi ${cy.phi}`);
  });
  const FACE_NAMES = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
  for (let f = 0; f < 6; f++) {
    const r = await clickFaceCentre(f);
    check(`net face ${f} centre locates ${FACE_NAMES[f]}`, () => assert.ok(r.face.startsWith(FACE_NAMES[f]), r.face));
  }

  await page.click('[data-view="map"]');
  await page.waitForTimeout(120);
  const mapStats = await pixelStats('#main-canvas');
  check('direction map renders face colours', () => assert.ok(mapStats.distinct > 60, `${mapStats.distinct} colours`));
  await page.screenshot({ path: path.join(shots, 'view-map.png') });

  const mapClick = await page.evaluate(() => {
    const rect = window.__viewer.state.sourceRect;
    const c = document.getElementById('main-canvas');
    const br = c.getBoundingClientRect();
    const x = rect.ox + rect.dw * 0.75;
    const y = rect.oy + rect.dh * 0.5;
    return { clientX: br.left + (x / c.width) * br.width, clientY: br.top + (y / c.height) * br.height };
  });
  await page.mouse.click(mapClick.clientX, mapClick.clientY);
  const mapFace = await page.evaluate(() => document.getElementById('loc-face').textContent);
  check('direction map at +X quadrant locates +X', () => assert.match(mapFace, /^\+X/));

  await page.click('[data-view="sphere"]');
  await page.check('#toggle-seams');
  await page.waitForTimeout(100);
  check('seam band toggle is error-free', () => assert.deepEqual(consoleErrors, []));
  await page.screenshot({ path: path.join(shots, 'view-sphere-seam.png') });
  await page.uncheck('#toggle-seams');

  // ---------------------------------------------------------------------
  // Panorama reprojection: the view, its controls and the verification panel
  // all run on src/reproject.js + src/resample.js in the page.

  await page.click('[data-view="panorama"]');
  await page.waitForFunction(
    () => document.getElementById('reprojection-status')?.textContent.startsWith('live:'),
    null,
    { timeout: 20000 },
  );

  const pano = await page.evaluate(() => ({
    status: document.getElementById('reprojection-status').textContent,
    pass: document.getElementById('reprojection-status').classList.contains('pass'),
    fail: document.getElementById('reprojection-status').classList.contains('fail'),
    projection: document.getElementById('verify-projection').textContent,
    direction: document.getElementById('verify-direction').textContent,
    seam: document.getElementById('verify-seam').textContent,
    seamPosition: document.getElementById('verify-seam-position').textContent,
    view: document.getElementById('verify-view').textContent,
    title: document.getElementById('main-title').textContent,
    selectEnabled: !document.getElementById('reprojection-mode').disabled,
    settings: window.__viewer.state.panorama,
    verdict: window.__viewer.state.panorama.lastVerdict,
    measurement: window.__viewer.state.panorama.lastMeasure,
  }));
  check('panorama view runs the kernel and passes', () => {
    assert.ok(pano.pass && !pano.fail, pano.status);
    assert.equal(pano.verdict.ok, true);
  });
  check('verification reports absolute measured values, not blanks', () => {
    assert.match(pano.direction, /^\d+\.\d+° max over \d+ rays/);
    assert.match(pano.seam, /-?\d+\.\d+ excess/);
    assert.match(pano.seamPosition, /° over \d+ points/);
    assert.match(pano.view, /yaw 0\.00° · pitch 0\.00°/);
    assert.ok(Number.isFinite(pano.measurement?.direction.maxAngleDeg));
    assert.ok(pano.measurement?.seamPosition.points > 0);
  });
  check('projection control is active only in the panorama view', () => assert.equal(pano.selectEnabled, true));

  // The rendered picture must be the cubemap kernel's output, pixel for pixel,
  // and it must read the stored faces (not the source PNG).
  const renderCheck = await page.evaluate(async () => {
    const { sampleCubeDirection } = await import('/src/resample.js');
    const { rayForPixel } = await import('/src/reproject.js');
    const v = window.__viewer;
    const p = v.state.panorama;
    const img = v.reprojection.render();
    const ctx = img.getContext('2d');
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    let worst = 0;
    let samples = 0;
    for (const [x, y] of [[8, 8], [img.width >> 1, img.height >> 1], [img.width - 9, img.height >> 1], [img.width >> 2, img.height - 9]]) {
      const dir = rayForPixel(p.projection, x + 0.5, y + 0.5, img.width, img.height, {
        yaw: p.yaw,
        pitch: p.pitch,
        fovDeg: p.fovDeg,
      });
      const want = sampleCubeDirection(v.state.faceFloat, ...dir);
      const o = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(px[o + c] - want[c]));
      samples++;
    }
    // The view centre at yaw=0/pitch=0 looks along +Z, so the centre pixel
    // must equal the sampled stored +Z face, not a shim.
    const centre = rayForPixel(p.projection, img.width / 2, img.height / 2, img.width, img.height, {
      yaw: p.yaw,
      pitch: p.pitch,
      fovDeg: p.fovDeg,
    });
    const faceTap = sampleCubeDirection(v.state.faceFloat, ...centre);
    const co = ((img.height >> 1) * img.width + (img.width >> 1)) * 4;
    let centreDiff = 0;
    for (let c = 0; c < 3; c++) centreDiff = Math.max(centreDiff, Math.abs(px[co + c] - faceTap[c]));
    return { worst, samples, centreDiff };
  });
  check('panorama pixels are sampleCubeDirection output', () => {
    assert.ok(renderCheck.samples === 4, `${renderCheck.samples} samples`);
    assert.ok(renderCheck.worst <= 1.0, `max channel diff ${renderCheck.worst}`);
    assert.ok(renderCheck.centreDiff <= 1.0, `centre differs from stored cube sample by ${renderCheck.centreDiff}`);
  });

  // Rotating the view must change the rendered picture (proof that the drawn
  // sphere is recomputed, not a static copy of the source).
  const frames = await page.evaluate(async () => {
    const v = window.__viewer;
    const a = v.reprojection.render();
    const aData = a.getContext('2d').getImageData(0, 0, a.width, a.height).data;
    const savedYaw = v.state.panorama.yaw;
    // A non-right-angle turn: the chart is symmetric under 90° rotations, so a
    // quarter turn would legitimately leave much of the picture unchanged.
    v.state.panorama.yaw = savedYaw + 0.3;
    v.redraw();
    const b = v.reprojection.render();
    const bData = b.getContext('2d').getImageData(0, 0, b.width, b.height).data;
    let diff = 0;
    for (let i = 0; i < aData.length; i += 4) {
      if (Math.abs(aData[i] - bData[i]) + Math.abs(aData[i + 1] - bData[i + 1]) + Math.abs(aData[i + 2] - bData[i + 2]) > 12) diff++;
    }
    v.state.panorama.yaw = savedYaw;
    v.redraw();
    return { changed: diff, total: aData.length / 4 };
  });
  check('rotating the view re-renders the sphere picture', () =>
    assert.ok(frames.changed > frames.total * 0.3, `only ${frames.changed}/${frames.total} pixels changed`),
  );

  // Seam lines are drawn from seamPolylines() projected through the kernel.
  const seamCheck = await page.evaluate(async () => {
    const { seamPolylines, projectDirection } = await import('/src/reproject.js');
    const v = window.__viewer;
    const p = v.state.panorama;
    const c = document.getElementById('main-canvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let found = 0;
    let checked = 0;
    for (const line of seamPolylines()) {
      for (const dir of line.dirs) {
        const q = projectDirection(p.projection, dir, c.width, c.height, {
          yaw: p.yaw,
          pitch: p.pitch,
          fovDeg: p.fovDeg,
        });
        if (!q.visible || !q.inFrame || q.px < 4 || q.px > c.width - 5 || q.py < 4 || q.py > c.height - 5) continue;
        checked++;
        let hit = false;
        for (let oy = -3; oy <= 3 && !hit; oy++) {
          for (let ox = -3; ox <= 3 && !hit; ox++) {
            const o = ((Math.round(q.py) + oy) * c.width + Math.round(q.px) + ox) * 4;
            // The overlay is cyan-green with a dark outline, distinct from the
            // chart's orange equator and yellow prime meridian.
            if (d[o] < 90 && d[o + 1] > 200 && d[o + 2] > 150) hit = true;
          }
        }
        if (hit) found++;
      }
    }
    return { checked, found };
  });
  check('seam overlay lands where projectDirection puts the cube edges', () => {
    assert.ok(seamCheck.checked > 0, 'no seam points in frame');
    assert.ok(seamCheck.found / seamCheck.checked > 0.6, `${seamCheck.found}/${seamCheck.checked} seam points have overlay pixels`);
  });
  await page.screenshot({ path: path.join(shots, 'view-panorama.png') });

  // Dragging rotates the view, re-renders and re-measures at the new yaw.
  const canvasBox = await page.locator('#main-canvas').boundingBox();
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.5, canvasBox.y + canvasBox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.7, canvasBox.y + canvasBox.height * 0.58, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const s = window.__viewer.state.panorama;
    return s.lastMeasure && Math.abs(s.lastMeasure.settings.yaw - s.yaw) < 1e-9;
  }, null, { timeout: 20000 });
  const rotated = await page.evaluate(() => {
    const s = window.__viewer.state.panorama;
    return {
      yaw: s.yaw,
      pitch: s.pitch,
      measuredYaw: s.lastMeasure.settings.yaw,
      measuredPitch: s.lastMeasure.settings.pitch,
      status: document.getElementById('reprojection-status').textContent,
      pass: document.getElementById('reprojection-status').classList.contains('pass'),
      view: document.getElementById('verify-view').textContent,
    };
  });
  check('dragging rotates the panorama view', () => assert.ok(Math.abs(rotated.yaw) > 0.05, `yaw ${rotated.yaw}`));
  check('verification re-runs at the rotated orientation', () => {
    assert.ok(Math.abs(rotated.measuredYaw - rotated.yaw) < 1e-9);
    assert.ok(Math.abs(rotated.measuredPitch - rotated.pitch) < 1e-9);
    // The panel prints degrees; the state stores radians (signed by drag).
    assert.match(rotated.view, new RegExp(`yaw ${((rotated.yaw * 180) / Math.PI).toFixed(2)}°`));
    assert.match(rotated.view, new RegExp(`pitch ${((rotated.pitch * 180) / Math.PI).toFixed(2)}°`));
  });
  check('rotated view still passes', () => assert.ok(rotated.pass, rotated.status));
  await page.screenshot({ path: path.join(shots, 'view-panorama-rotated.png') });

  // Switching projection re-renders and re-measures through the same kernel.
  await page.selectOption('#reprojection-mode', 'equirectangular');
  await page.waitForFunction(() => {
    const s = window.__viewer.state.panorama;
    return s.projection === 'equirectangular' && s.lastMeasure?.projection === 'equirectangular';
  }, null, { timeout: 20000 });
  const equirect = await page.evaluate(() => ({
    status: document.getElementById('reprojection-status').textContent,
    pass: document.getElementById('reprojection-status').classList.contains('pass'),
    title: document.getElementById('main-title').textContent,
    projection: document.getElementById('verify-projection').textContent,
    yaw: window.__viewer.state.panorama.yaw,
    pitch: window.__viewer.state.panorama.pitch,
  }));
  check('equirectangular projection is measured, not reused', () => {
    assert.match(equirect.projection, /^equirectangular/);
    assert.match(equirect.title, /Equirectangular/);
    assert.ok(equirect.pass, equirect.status);
    assert.equal(equirect.yaw, 0);
    assert.equal(equirect.pitch, 0);
  });
  await page.screenshot({ path: path.join(shots, 'view-panorama-equirect.png') });

  // Failure feedback: a broken measurement must surface as FAIL, never as a
  // default pass. Inject a non-finite orientation, run, then recover.
  const injected = await page.evaluate(() => {
    const v = window.__viewer;
    v.reprojection.runVerification({ yaw: NaN });
    const el = document.getElementById('reprojection-status');
    const result = {
      text: el.textContent,
      fail: el.classList.contains('fail'),
      pass: el.classList.contains('pass'),
      verdict: v.state.panorama.lastVerdict,
      measurement: v.state.panorama.lastMeasure,
    };
    v.reprojection.runVerification();
    result.recovered = {
      pass: el.classList.contains('pass'),
      text: el.textContent,
      verdict: v.state.panorama.lastVerdict,
    };
    return result;
  });
  check('a failed measurement is shown as FAIL, not defaulted', () => {
    assert.equal(injected.fail, true, injected.text);
    assert.equal(injected.pass, false);
    assert.equal(injected.verdict.ok, false);
    assert.equal(injected.measurement, null);
    assert.match(injected.text, /live: FAIL/);
  });
  check('the panel recovers after the injected failure is removed', () => {
    assert.equal(injected.recovered.pass, true, injected.recovered.text);
    assert.equal(injected.recovered.verdict.ok, true);
  });

  check('no console errors after panorama checks', () => assert.deepEqual(consoleErrors, []));

  await page.screenshot({ path: path.join(shots, 'view-sphere-located.png') });
} finally {
  await browser.close();
  server.kill();
}

if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}\n${f.err.stack}`);
  console.error(`\n${failures.length} web check(s) failed`);
  process.exit(1);
}
console.log('\nall web checks passed; screenshots in output/screenshots');
