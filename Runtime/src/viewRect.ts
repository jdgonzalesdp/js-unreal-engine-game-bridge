/** The game view's rectangle inside the window, for the mirror's camera.
 *
 *  The page's camera owns only its canvas, which need not fill the window
 *  (PrepViz keeps a right rail, and its POV mode physically shrinks the
 *  canvas to the shot camera's frame aspect). Unreal renders the whole
 *  window, so the mirror needs the expanded full-window frustum whose
 *  canvas sub-rectangle equals the page frustum — three.js setViewOffset
 *  run in reverse — plus where the page centre falls in window NDC, for
 *  the projection's off-centre offset. Without it the mirror drew the
 *  page VFov across the full window aspect and clicks missed by the
 *  rectangle's offset (measured 2026-11-17: canvas 1782x1189 in a
 *  2114x1189 window, picking aspect 1.499 against a 1.778 render). */

export interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CameraViewOffset {
  enabled?: boolean;
  fullWidth?: number;
  fullHeight?: number;
  offsetX?: number;
  offsetY?: number;
  width?: number;
  height?: number;
}

/** The canvas rectangle narrowed by a camera view offset (three setViewOffset), in the same CSS pixels. */
export function composeViewRect(canvas: ViewRect, view?: CameraViewOffset | null): ViewRect {
  if (!view?.enabled || !(Number(view.fullWidth) > 0) || !(Number(view.fullHeight) > 0)) return canvas;
  const sx = canvas.w / Number(view.fullWidth), sy = canvas.h / Number(view.fullHeight);
  return {
    x: canvas.x + Number(view.offsetX ?? 0) * sx,
    y: canvas.y + Number(view.offsetY ?? 0) * sy,
    w: Number(view.width ?? view.fullWidth) * sx,
    h: Number(view.height ?? view.fullHeight) * sy,
  };
}

export interface FullWindowFrustum {
  /** Vertical FOV (degrees) of the expanded full-window frustum. */
  vfovDeg: number;
  /** Orthographic half-height of the expanded full-window frustum. */
  orthoHalfH: number;
  /** The page centre in window NDC: x right, y up, window spans -1..1. */
  centerX: number;
  centerY: number;
}

/** The full-window frustum whose `rect` sub-rectangle is the page frustum
 *  (`vfovDeg` perspective, or `orthoHalfH` orthographic half-height).
 *  Null when the rectangle or window has no area. A full-window rect
 *  returns the page frustum unchanged with a zero centre. */
export function fullWindowFrustum(rect: ViewRect, winW: number, winH: number, vfovDeg: number, orthoHalfH: number): FullWindowFrustum | null {
  if (!(rect.w > 0) || !(rect.h > 0) || !(winW > 0) || !(winH > 0)) return null;
  const scaleY = winH / rect.h;
  const half = (vfovDeg * Math.PI) / 360;
  const fullVfov = vfovDeg > 0 ? (2 * Math.atan(Math.tan(half) * scaleY) * 180) / Math.PI : 0;
  return {
    vfovDeg: fullVfov,
    orthoHalfH: orthoHalfH * scaleY,
    centerX: (rect.x + rect.w / 2 - winW / 2) / (winW / 2),
    centerY: (winH / 2 - (rect.y + rect.h / 2)) / (winH / 2),
  };
}
