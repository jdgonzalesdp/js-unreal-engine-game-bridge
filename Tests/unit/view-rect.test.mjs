// The expanded full-window frustum for a canvas that does not fill the window (Runtime/src/viewRect.ts).
// Unreal renders the whole window while the page camera owns only its canvas rectangle, so the mirror renders
// a wider frustum whose canvas sub-rectangle is the page frustum, shifted off-centre onto the rectangle.
// The window/canvas numbers are the ones measured in Unreal on 2026-11-17 (PrepViz with its right rail open:
// picking missed across the whole canvas because the render used the window aspect, not the canvas aspect).
import test from 'node:test';
import assert from 'node:assert/strict';
import {composeViewRect, fullWindowFrustum} from '../../Runtime/src/viewRect.ts';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('a full-window canvas keeps the page frustum and a centred projection', () => {
  const f = fullWindowFrustum({x: 0, y: 0, w: 2114, h: 1189}, 2114, 1189, 53.7, 12);
  close(f.vfovDeg, 53.7, 1e-9);
  close(f.orthoHalfH, 12);
  close(f.centerX, 0);
  close(f.centerY, 0);
});

test('the 2026-11-17 rail layout: the sub-rectangle of the expanded frustum is the page frustum', () => {
  // Canvas 1782x1189 at the window's left in a 2114x1189 window; page VFov 53.6968 (aspect 1.4987).
  const rect = {x: 0, y: 0, w: 1782, h: 1189};
  const f = fullWindowFrustum(rect, 2114, 1189, 53.6968, 0);
  // Heights agree, so the vertical stays; the centre shifts left by the rail's half width in NDC.
  close(f.vfovDeg, 53.6968, 1e-9);
  close(f.centerX, (891 - 1057) / 1057, 1e-12);
  close(f.centerY, 0);
  // Project both ways with an independent pinhole model: a ray at page NDC (nx, ny) through the page
  // frustum must land on the same window pixel as the same ray through the expanded frustum.
  const pageTanY = Math.tan((53.6968 * Math.PI) / 360), pageTanX = pageTanY * (rect.w / rect.h);
  const fullTanY = Math.tan((f.vfovDeg * Math.PI) / 360), fullTanX = fullTanY * (2114 / 1189);
  for (const [nx, ny] of [[-1, -1], [0, 0], [1, 1], [0.5, -0.25], [-0.75, 0.9]]) {
    const rayX = nx * pageTanX, rayY = ny * pageTanY;
    const pxFromPage = rect.x + ((nx + 1) / 2) * rect.w;
    const pyFromPage = rect.y + ((1 - ny) / 2) * rect.h;
    const fullNdcX = rayX / fullTanX + f.centerX, fullNdcY = rayY / fullTanY + f.centerY;
    close(((fullNdcX + 1) / 2) * 2114, pxFromPage, 1e-6);
    close(((1 - fullNdcY) / 2) * 1189, pyFromPage, 1e-6);
  }
});

test('a POV-style frame (shorter than the window) expands the vertical and shifts the centre', () => {
  // A 2.39:1 frame letterboxed in the canvas: 1782x746 centred vertically in 2114x1189 with a 40 px top stack.
  const rect = {x: 166, y: 261, w: 1782, h: 746};
  const f = fullWindowFrustum(rect, 2114, 1189, 40, 5);
  close(f.orthoHalfH, 5 * (1189 / 746), 1e-12);
  assert.ok(f.vfovDeg > 40);
  close(Math.tan((f.vfovDeg * Math.PI) / 360), Math.tan((40 * Math.PI) / 360) * (1189 / 746), 1e-12);
  close(f.centerX, 0, 1e-12);
  close(f.centerY, (1189 / 2 - (261 + 373)) / (1189 / 2), 1e-12);
});

test('no area, no frustum', () => {
  assert.equal(fullWindowFrustum({x: 0, y: 0, w: 0, h: 10}, 100, 100, 50, 1), null);
  assert.equal(fullWindowFrustum({x: 0, y: 0, w: 10, h: 10}, 0, 100, 50, 1), null);
});

test('a camera view offset narrows the canvas rectangle', () => {
  const canvas = {x: 100, y: 50, w: 800, h: 600};
  assert.deepEqual(composeViewRect(canvas, null), canvas);
  assert.deepEqual(composeViewRect(canvas, {enabled: false, fullWidth: 800, fullHeight: 600, offsetX: 10, offsetY: 10, width: 5, height: 5}), canvas);
  assert.deepEqual(
    composeViewRect(canvas, {enabled: true, fullWidth: 1600, fullHeight: 1200, offsetX: 400, offsetY: 300, width: 800, height: 600}),
    {x: 300, y: 200, w: 400, h: 300});
});
