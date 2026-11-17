/** Draws into render targets, kept so Unreal can run them again when the page reads a result (passRun.ts). A page that
 *  computes with full-screen passes (a light meter reducing the picture to one pixel, a white-balance patch, a
 *  simulation step) draws a scene into a render target, then passes that each read earlier targets, and reads the last
 *  one back. WebGL runs every pass as it is drawn; Unreal runs them only for a read. So each draw is noted as it
 *  happens, with its uniform values as they were then (a page reuses one material for every level of a reduction), and
 *  each render target it reads points at the draw that last wrote that target. */
import {frameCount} from './frameCount';

type Obj = Record<string, any>;
/** A uniform's value at the draw: a number, a vector's or matrix's elements, a texture, or null. */
export type Value = number | number[] | Obj | null;
type Common = {
  /** The render target drawn into. */
  target: Obj; width: number; height: number;
  /** three's texture type (1009 bytes, 1015 float, 1016 half float) and whether it samples nearest. */
  type: number; nearest: boolean;
  /** The animation frame of the draw, and how many passes lie between it and a scene. */
  frame: number; depth: number;
  /** The scene draw behind it: the first one its inputs lead back to. */
  src: SceneDraw | null;
};
/** A scene drawn into the target with a camera. */
export type SceneDraw = Common & {kind: 'scene'; scene: Obj; camera: Obj};
/** A full-screen pass: its material and uniform values, and the draw behind each render target texture it reads
 *  (null: a target nothing was drawn into, which WebGL reads as zeros). */
export type PassDraw = Common & {kind: 'pass'; material: Obj; values: Record<string, Value>; inputs: Record<string, Draw | null>};
/** A draw the bridge can't run again, and why (for the log). */
export type Gap = Common & {kind: 'gap'; why: string};
export type Draw = SceneDraw | PassDraw | Gap;

/** A pass further than this from a scene (one that reads its own last result, frame after frame) is not followed
 *  back: its draws would otherwise be kept for ever. */
export const MAX_DEPTH = 32;
const NEAREST = 1003;
const latest = new WeakMap<object, Draw>();
const owners = new WeakMap<object, Obj>();

/** The draw that last wrote a render target. */
export const drawOf = (target: Obj | null | undefined): Draw | undefined => target ? latest.get(target) : undefined;

/** Whether a material blends onto what its target holds (three blends a NormalBlending material only when it is
 *  transparent). A pass replaced by Unreal overwrites its target, so a blended one is not run. */
export const blends = (m: Obj) => { const b = m.blending ?? 1; return b !== 0 && !(b === 1 && !m.transparent); };

/** Called for every draw (readback.ts noteDraw). real: a scene, not a pass; quad: the pass's mesh. */
export function recordDraw(target: Obj | null, scene: Obj, camera: Obj, real: boolean, quad: Obj | null) {
  const tex = target?.texture;
  if (!target || !tex?.isTexture) return;
  owners.set(tex, target);
  const c: Common = {target, width: target.width | 0, height: target.height | 0, type: tex.type ?? 1009, nearest: tex.magFilter === NEAREST,
    frame: frameCount.animation, depth: 0, src: null};
  const gap = (why: string, src: SceneDraw | null = null) => { latest.set(target, {...c, kind: 'gap', why, src}); };
  if ((target.textures?.length ?? 1) > 1 || target.isWebGLCubeRenderTarget || target.isWebGL3DRenderTarget || target.isWebGLArrayRenderTarget) {
    gap('it draws into several or layered textures'); return;
  }
  if (real) { const d: SceneDraw = {...c, kind: 'scene', scene, camera}; d.src = d; latest.set(target, d); return; }
  const m = quad?.material;
  if (!m?.isShaderMaterial && !m?.isRawShaderMaterial) { gap(`${quad ? m?.type ?? 'its material' : scene.type ?? 'the object'} is not a shader pass`); return; }
  const values: Record<string, Value> = {}, inputs: Record<string, Draw | null> = {};
  let depth = 0, src: SceneDraw | null = null, why = blends(m) ? 'it draws with blending' : '';
  const u = (m.uniforms ?? {}) as Record<string, {value?: any} | undefined>;
  for (const k in u) {
    const v = u[k]?.value;
    if (v == null || typeof v !== 'object') { values[k] = typeof v === 'number' ? v : typeof v === 'boolean' ? +v : null; continue; }
    if (!v.isTexture) { values[k] = typeof v.toArray === 'function' ? v.toArray() : null; continue; }
    values[k] = v;
    if (v.isDepthTexture) { why ||= `it reads the depth texture ${k}`; continue; }
    const owner = owners.get(v);
    if (!owner) { if (v.isRenderTargetTexture) inputs[k] = null; continue; }
    if (owner === target) { why ||= `it reads ${k}, the target it draws into`; continue; }
    const d = latest.get(owner) ?? null;
    inputs[k] = d;
    if (!d) continue;
    depth = Math.max(depth, d.depth + 1);
    src ??= d.src;
  }
  if (depth > MAX_DEPTH) { gap(`it is more than ${MAX_DEPTH} passes from a scene`); return; }
  if (why) { gap(why, src); return; }
  latest.set(target, {...c, kind: 'pass', material: m, values, inputs, depth, src});
}
