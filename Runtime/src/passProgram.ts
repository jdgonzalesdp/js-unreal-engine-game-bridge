/** The parts of a pass the host needs to draw it (passRun.ts): its translated shader (passHlsl.ts), and its material
 *  parameters from the uniform values noted at the draw (passGraph.ts). Render target textures it read become the
 *  host's targets for the draws behind them; data textures (curves, lookup tables) go to the host as float RGBA. */
import {translateShaderMaterial} from './shaders';
import {sizedFetches} from './texelFetch';
import {floatPixels} from './postValues';
import {bytesBase64} from './base64';
import {passShader, type PassShader} from './passHlsl';
import type {Draw, PassDraw, Value} from './passGraph';

type Obj = Record<string, any>;
/** One pass for the host: the target it draws into, its shader, and its parameters. slots: render target textures by
 *  parameter, as the target of the draw behind each (-1: a target never drawn, zeros). textures: data textures. */
export type HostPass = {slot: number; key: string; scalars: Record<string, number>; vectors: Record<string, number[]>; textures: Record<string, number>; slots: Record<string, number>};
export type HostTexture = {id: number; width: number; height: number; depth: number; volume: number; nearest: number; wrapS: number; wrapT: number; data: string};

type Prepared = {fs: string; vs: string; defines: string; proxy: Obj; shader?: PassShader | null};
const prepared = new WeakMap<Obj, Prepared>();
const warmed = new WeakSet<Obj>();
/** Why the last translation of a material failed, for the log. */
export const failures = new WeakMap<Obj, string>();

/** The pass shader for a material: undefined while the translator works on it (shaders.ts translates on a background
 *  thread in Unreal), null when it can't be translated. */
export function shaderOf(m: Obj): PassShader | null | undefined {
  const defines = JSON.stringify(m.defines ?? {});
  let p = prepared.get(m);
  if (!p || p.fs !== m.fragmentShader || p.vs !== m.vertexShader || p.defines !== defines) {
    const proxy = {name: m.name, vertexShader: sizedFetches(m.vertexShader ?? '').src, fragmentShader: sizedFetches(m.fragmentShader ?? '').src,
      defines: {...(m.defines ?? {})}, glslVersion: m.glslVersion, isRawShaderMaterial: m.isRawShaderMaterial};
    p = {fs: m.fragmentShader, vs: m.vertexShader, defines, proxy};
    prepared.set(m, p);
  }
  if (p.shader !== undefined) return p.shader;
  const t = translateShaderMaterial(p.proxy as never);
  if (t === undefined) return undefined;
  if (!t) { failures.set(m, 'it could not be translated to HLSL'); return p.shader = null; }
  const s = passShader(t, 'PERSPECTIVE_CAMERA' in (m.defines ?? {}), Object.keys(m.uniforms ?? {}));
  if (s.problems.length) { failures.set(m, s.problems.join('; ')); return p.shader = null; }
  return p.shader = s;
}

/** Starts the translation of a pass the page draws into a render target, so it is ready by the time the page reads one
 *  back (a read can't wait for the background translator). */
export function prewarmPass(m: Obj) {
  if (warmed.has(m)) return;
  if (shaderOf(m) !== undefined) warmed.add(m);
}

const num = (v: Value) => typeof v === 'number' ? v : Array.isArray(v) ? +(v[0] ?? 0) : 0;
const vec4 = (v: Value) => typeof v === 'number' ? [v, 0, 0, 0] : Array.isArray(v) ? [0, 1, 2, 3].map(i => +(v[i] ?? 0)) : [0, 0, 0, 0];

let nextTexture = 1;
const sent = new WeakMap<object, {id: number; version: number}>();
/** The host's id for a data texture, adding its pixels to `out` when they are new or changed; 0 when it has none. */
function dataTexture(tex: Obj | null, out: HostTexture[]): number {
  if (!tex?.isTexture || tex.isRenderTargetTexture || tex.isDepthTexture) return 0;
  const known = sent.get(tex);
  if (known && known.version === tex.version) return known.id;
  const px = floatPixels(tex as never);
  if (!px) return 0;
  const id = known?.id ?? nextTexture++;
  sent.set(tex, {id, version: tex.version});
  out.push({id, width: px.width, height: px.height, depth: px.depth, volume: tex.isData3DTexture ? 1 : 0, nearest: tex.magFilter === 1003 ? 1 : 0,
    wrapS: tex.wrapS, wrapT: tex.wrapT, data: bytesBase64(new Uint8Array(px.data.buffer))});
  return id;
}

/** The pass's parameters from the values noted at its draw. slotOf: the host target of a draw behind an input. */
export function passParameters(d: PassDraw, s: PassShader, slot: number, slotOf: (d: Draw) => number, textures: HostTexture[], warn: (text: string) => void): HostPass {
  const p: HostPass = {slot, key: s.key, scalars: {}, vectors: {}, textures: {}, slots: {}};
  for (const i of s.inputs) {
    const name = i.param;
    if (!name) continue;
    if (i.source === 'texture' || i.source === 'volume') {
      if (name in d.inputs) { const from = d.inputs[name]; p.slots[name] = from ? slotOf(from) : -1; continue; }
      const tex = d.values[name] as Obj | null;
      const id = dataTexture(tex, textures);
      if (id) p.textures[name] = id;
      else if (tex) warn(`${name} has no pixel data the bridge can send; it reads black`);
    } else if (i.source === 'scalar') {
      if (!name.endsWith('_jsgbFlipY')) { p.scalars[name] = num(d.values[name] ?? null); continue; }
      // Pass targets keep WebGL's row order; a data texture flips as three uploads it.
      const base = name.slice(0, -10), key = base in d.values ? base : base.replace(/^_/, '');
      const t = d.values[key] as Obj | null;
      p.scalars[name] = key in d.inputs || !t?.flipY ? 0 : 1;
    } else if (i.source === 'vector') {
      const column = /^(\w+)_c(\d)$/.exec(name), size = /^(\w+)_jsgbSize$/.exec(name);
      const m = column ? d.values[column[1]] : null;
      if (Array.isArray(m) && (m.length === 9 || m.length === 16)) {
        const n = m.length === 9 ? 3 : 4, c = +column![2];
        p.vectors[name] = [...m.slice(c * n, c * n + n), 0].slice(0, 4);
      } else if (size) {
        const from = d.inputs[size[1]], img = (d.values[size[1]] as Obj | null)?.image;
        p.vectors[name] = from ? [from.width, from.height, 1, 0] : [img?.width ?? 1, img?.height ?? 1, img?.depth ?? 1, 0];
      } else p.vectors[name] = vec4(d.values[name] ?? null);
    }
  }
  return p;
}
