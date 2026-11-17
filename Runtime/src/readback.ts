/** Pixel reads of what a renderer drew, as WebGL answers them in the same call: readRenderTargetPixels, and a
 *  renderer's canvas read as an image (canvasRead.ts). Unreal draws the scene the game drew there, from the camera it
 *  used, with the game view's post-processing, and the host hands the picture back at once (JsgbCapture.cpp).
 *
 *  A render target can hold a picture made in steps (a post-processing chain: a scene, then full-screen passes that
 *  read it). Each draw notes the scene behind it: a scene drawn is its own source, and a pass takes the source of the
 *  render target texture it reads, or else the last scene drawn. A small read of what passes computed (a light meter's
 *  one pixel) is no picture: Unreal runs those passes instead (passRun.ts). */
import {lastFrame, post, liveRenderers} from './renderer';
import {frameCount} from './frameCount';
import {media, type Pixels} from './media';
import {sceneFrame, exportingFrame} from './sceneFrame';
import {recordDraw} from './passGraph';
import {prewarmPass} from './passProgram';
import {runPassRead} from './passRun';

type Obj = Record<string, any>;
type Source = {scene: Obj; camera: Obj; linear: boolean; target: Obj | null};

/** Extensions a browser that renders and reads float targets reports (an export checks EXT_color_buffer_float). */
export const READBACK_EXTENSIONS = new Set(['EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'EXT_float_blend', 'OES_texture_float_linear']);
/** Reads smaller than this are what passes computed (a light meter's reduced target), never a picture: Unreal runs
 *  the passes (passRun.ts), or the buffer stays as it was. */
const MIN_READ = 1024;

const sources = new WeakMap<object, Source>();
const textureTargets = new WeakMap<object, Obj>();
const screens = new WeakMap<object, Source>();
let lastScene: Source | null = null;
/** The game's view and post settings before a draw of another camera into a render target took the view's place
 *  (renderer.ts makes the latest perspective draw the view). Kept for the animation frame it was taken in. */
let liveView: {scene: Obj; camera: Obj; renderer: unknown; linear: boolean; pointScale: number; post: Record<string, number>; frame: number} | null = null;
const busy = exportingFrame;

const quadOf = (o: Obj): Obj | null => o.isMesh ? o : o.isScene && o.children?.length === 1 && o.children[0].isMesh ? o.children[0] : null;
/** A full-screen pass: a quad or triangle with a shader material, alone or alone in a scene; or a group drawn alone. */
function isPass(o: Obj): boolean {
  const q = quadOf(o);
  if (!q) return !o.isScene;
  const m = q.material, count = q.geometry?.attributes?.position?.count ?? 99;
  return !!(m?.isShaderMaterial || m?.isRawShaderMaterial) && count <= 6;
}
function traced(o: Obj): Source | null {
  const u = (quadOf(o) ?? o).material?.uniforms as Record<string, {value?: Obj}> | undefined;
  if (!u) return null;
  for (const k in u) {
    const v = u[k]?.value;
    if (!v?.isTexture) continue;
    const t = textureTargets.get(v), s = t && sources.get(t);
    if (s) return s;
  }
  return null;
}

/** Called by UnrealRenderer.render before anything else, for every renderer and draw. */
export function noteDraw(renderer: Obj, target: Obj | null, scene: Obj, camera: Obj) {
  if (!scene || busy()) return;
  const real = !!scene.isScene && !isPass(scene);
  const quad = real ? null : quadOf(scene);
  recordDraw(target, scene, camera, real, quad); // passGraph.ts: what passRun.ts runs for a small read
  if (target && quad?.material?.isShaderMaterial) prewarmPass(quad.material);
  const src: Source | null = real ? {scene, camera, linear: !!target, target} : traced(scene) ?? lastScene;
  if (real) lastScene = src;
  if (target?.texture) { textureTargets.set(target.texture, target); if (src) sources.set(target, src); }
  else if (!target && src) screens.set(renderer, src);
  if (liveView && liveView.frame !== frameCount.animation) liveView = null;
  if (!real) return;
  if (liveView && liveView.scene === scene && liveView.camera === camera) { liveView = null; return; }
  if (target?.texture && !liveView && lastFrame.scene && (lastFrame.scene !== scene || lastFrame.camera !== camera)) {
    liveView = {scene: lastFrame.scene as Obj, camera: lastFrame.camera as Obj, renderer: lastFrame.renderer, linear: lastFrame.linear, pointScale: lastFrame.pointScale, post: {...post}, frame: frameCount.animation};
  }
}

/** Puts the game's view back after a draw into a render target took its place, and keeps that target from taking it
 *  again (a post-processing chain made for exports draws into the same target each time). */
function restoreLive(src: Source | null) {
  const v = liveView;
  if (!v) return;
  if (src?.target?.texture && src.camera !== v.camera) src.target.texture.__jsgbRead = true;
  if (lastFrame.scene === v.scene && lastFrame.camera === v.camera) return;
  lastFrame.scene = v.scene; lastFrame.camera = v.camera; lastFrame.renderer = v.renderer; lastFrame.linear = v.linear; lastFrame.pointScale = v.pointScale;
  Object.assign(post, v.post);
}

type Shot = {width: number; height: number; float: boolean; bytes: Uint8Array; floats: Float32Array};
/** Unreal's picture of a scene from a camera: the scene goes out as a frame of its own, complete, and the host draws
 *  it now. The game's view comes back with the next frame. */
function capture(src: Source, width: number, height: number, float: boolean): Shot | null {
  const m = media();
  if (!m?.captureView || busy() || width < 1 || height < 1) return null;
  const frame = sceneFrame(src.scene, src.camera, src.linear);
  if (!frame) return null;
  const [f, n, i, ni] = frame;
  const out = m.captureView(f, n, i, ni, width, height, float);
  if (!out || out.byteLength < 8) return null;
  const [w, h] = new Int32Array(out, 0, 2);
  const shot: Shot = {width: w, height: h, float, bytes: new Uint8Array(0), floats: new Float32Array(0)};
  if (float) shot.floats = new Float32Array(out, 8, Math.min(w * h * 4, (out.byteLength - 8) >> 2));
  else shot.bytes = new Uint8Array(out, 8, Math.min(w * h * 4, out.byteLength - 8));
  return shot;
}

function toHalf(v: number): number {
  const f = new Float32Array([v]), x = new Uint32Array(f.buffer)[0];
  const sign = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 112, mant = x & 0x7fffff;
  if (e <= 0) return sign; if (e >= 31) return sign | 0x7c00;
  return sign | (e << 10) | (mant >>> 13);
}

/** readRenderTargetPixels: true when the buffer got Unreal's picture of what was drawn into the target. */
export function readTargetPixels(target: Obj, x: number, y: number, w: number, h: number, out: ArrayLike<number> | undefined): boolean {
  if (!target || !out || busy()) return false;
  const ran = runPassRead(target, x, y, w, h, out, w * h < MIN_READ);
  if (ran !== undefined) return ran;
  if (w * h < MIN_READ) return false;
  const src = sources.get(target);
  restoreLive(src ?? null);
  if (!src) return false;
  const float = out instanceof Float32Array || out instanceof Uint16Array;
  const shot = capture(src, target.width | 0, target.height | 0, float);
  if (!shot) return false;
  const W = shot.width, H = shot.height, dst = out as unknown as Float32Array, half = out instanceof Uint16Array;
  for (let row = 0; row < h; row++) {
    const sy = H - 1 - (y + row); // WebGL gives the bottom row first
    if (sy < 0 || sy >= H) continue;
    for (let col = 0; col < w; col++) {
      const sx = x + col; if (sx < 0 || sx >= W) continue;
      const s = (sy * W + sx) * 4, o = (row * w + col) * 4;
      for (let c = 0; c < 4; c++) {
        const v = float ? shot.floats[s + c] : shot.bytes[s + c];
        dst[o + c] = half ? toHalf(v) : v;
      }
    }
  }
  return true;
}

const canvasShots = new WeakMap<object, {key: string; pixels: Pixels}>();
/** The canvas of one of the page's renderers: whether a canvas is one (a WebGL canvas has no 2D context). */
export const rendererOf = (canvas: unknown): Obj | undefined => canvas ? liveRenderers().find(r => (r as Obj).domElement === canvas) as Obj | undefined : undefined;
/** What a renderer's canvas shows, at the canvas's size, rows from the top: the game's view for the renderer Unreal
 *  shows, else the last scene that renderer drew on its canvas. */
export function readCanvasPixels(canvas: Obj): Pixels | null {
  const r = rendererOf(canvas);
  if (!r) return null;
  restoreLive(null);
  const src = r === lastFrame.renderer && lastFrame.scene ? {scene: lastFrame.scene as Obj, camera: lastFrame.camera as Obj, linear: lastFrame.linear, target: null} : screens.get(r);
  if (!src) return null;
  const width = Math.max(1, canvas.width | 0), height = Math.max(1, canvas.height | 0);
  const key = `${r.info?.render?.frame}|${width}x${height}`, hit = canvasShots.get(canvas);
  if (hit?.key === key) return hit.pixels;
  const shot = capture(src, width, height, false);
  if (!shot) return null;
  const data = new Uint8ClampedArray(shot.bytes.length); data.set(shot.bytes);
  const pixels = {width: shot.width, height: shot.height, data};
  canvasShots.set(canvas, {key, pixels});
  return pixels;
}
