import * as THREE from 'three-real';
import {bytesBase64} from './base64';
import type {PostShader} from './postHlsl';

/** A post pass's parameter values for its Unreal material, read from the pass's uniforms (postPasses.ts). */
export type PassValues = {scalars: Record<string, number>; vectors: Record<string, number[]>; textures: Record<string, number>};
type Uniforms = Record<string, {value: any} | undefined>;
type Emit = (kind: string, parameters: Record<string, unknown>) => void;

const num = (v: unknown) => typeof v === 'number' ? v : typeof v === 'boolean' ? +v : 0;
function vectorOf(v: any): number[] {
  if (typeof v === 'number' || typeof v === 'boolean') return [+v, 0, 0, 0];
  if (v?.isColor) return [v.r, v.g, v.b, 1];
  if (v?.isVector2) return [v.x, v.y, 0, 0];
  if (v?.isVector3) return [v.x, v.y, v.z, 0];
  if (v?.isVector4 || v?.isQuaternion) return [v.x, v.y, v.z, v.w];
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from({length: 4}, (_, i) => +((v as ArrayLike<number>)[i] ?? 0));
  return [0, 0, 0, 0];
}

// Data textures (lookup tables, curves) go to the host as float RGBA, once and again when their version changes.
// Render targets and images are not sent: a pass that reads one is reported (postPasses.ts).
let nextId = 1;
const sent = new WeakMap<object, {id: number; version: number}>();
const srgbToLinear = (c: number) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const CHANNELS: Record<number, number> = {[THREE.RedFormat]: 1, [THREE.RedIntegerFormat]: 1, [THREE.RGFormat]: 2, [THREE.RGIntegerFormat]: 2, 1022: 3, [THREE.AlphaFormat]: 1};

/** The texture's pixels as RGBA floats, as a shader samples them (bytes normalized, sRGB bytes decoded). */
export function floatPixels(tex: THREE.Texture): {data: Float32Array; width: number; height: number; depth: number} | null {
  const img = tex.image as {data?: ArrayLike<number>; width?: number; height?: number; depth?: number} | undefined;
  const d = img?.data, width = img?.width ?? 0, height = img?.height ?? 0;
  const depth = (tex as THREE.Data3DTexture).isData3DTexture ? img?.depth ?? 0 : 1;
  if (!d || !width || !height || !depth) return null;
  const channels = CHANNELS[tex.format as number] ?? 4, n = width * height * depth;
  if (d.length < n * channels) return null;
  const bytes = d instanceof Uint8Array || d instanceof Uint8ClampedArray;
  const half = tex.type === THREE.HalfFloatType && d instanceof Uint16Array;
  const scale = bytes ? 1 / 255 : d instanceof Uint16Array && !half ? 1 / 65535 : 1;
  const srgb = bytes && tex.colorSpace === THREE.SRGBColorSpace;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 4; c++) {
      let v: number;
      if (c < channels) { v = d[i * channels + c]; v = half ? THREE.DataUtils.fromHalfFloat(v) : v * scale; if (srgb && c < 3) v = srgbToLinear(v); }
      else v = c === 3 ? 1 : 0;
      out[i * 4 + c] = v;
    }
    // An alpha-only texture samples as (0, 0, 0, a).
    if (tex.format === THREE.AlphaFormat) { out[i * 4 + 3] = out[i * 4]; out[i * 4] = 0; }
  }
  return {data: out, width, height, depth};
}

/** The host's id for a data texture, sending it first when it is new or changed; 0 when it can't be sent. */
export function postTextureId(tex: THREE.Texture | null | undefined, emit: Emit): number {
  if (!tex?.isTexture || (tex as {isRenderTargetTexture?: boolean}).isRenderTargetTexture || (tex as THREE.DepthTexture).isDepthTexture) return 0;
  const known = sent.get(tex);
  if (known && known.version === tex.version) return known.id;
  const px = floatPixels(tex);
  if (!px) return 0;
  const id = known?.id ?? nextId++;
  sent.set(tex, {id, version: tex.version});
  emit('postTexture', {id, width: px.width, height: px.height, depth: px.depth, volume: (tex as THREE.Data3DTexture).isData3DTexture ? 1 : 0,
    nearest: tex.magFilter === THREE.NearestFilter ? 1 : 0, wrapS: tex.wrapS, wrapT: tex.wrapT, data: bytesBase64(new Uint8Array(px.data.buffer))});
  return id;
}

/** The uniforms of one effect in a merged pmndrs EffectPass (named <prefix><Name>), for the log. */
export const effectUniforms = (u: Uniforms, prefix: string) => Object.keys(u).filter(k => k.startsWith(prefix) && /[A-Z]/.test(k[prefix.length] ?? '') && !k.endsWith('BlendOpacity'))
  .map(k => k[prefix.length].toLowerCase() + k.slice(prefix.length + 1)).slice(0, 5).join(', ');

/** Every parameter the pass's material takes, from its uniforms. A texture the bridge can't send (another pass's
 *  render target, an image) leaves out the pmndrs effect that reads it: that effect's blend opacity goes to 0, so the
 *  pass passes its colour through it unchanged. Outside an EffectPass the texture reads black. skip: every effect in
 *  the pass is left out, so the pass changes nothing. */
export function passValues(material: {uniforms?: Uniforms}, shader: PostShader, emit: Emit, warn: (param: string, text: string) => void): {values: PassValues; skip: boolean} {
  const u = material.uniforms ?? {};
  const values: PassValues = {scalars: {}, vectors: {}, textures: {}};
  const off = new Set<string>();
  for (const i of shader.inputs) {
    const p = i.param;
    if (!p) continue;
    if (i.source === 'texture' || i.source === 'volume' || i.source === 'cube') {
      const tex = u[p]?.value as THREE.Texture | null | undefined;
      const id = postTextureId(tex, emit);
      if (id) { values.textures[p] = id; continue; }
      const why = !tex ? 'is not set' : (tex as {isRenderTargetTexture?: boolean}).isRenderTargetTexture ? 'is drawn by another pass' : 'has no pixel data the bridge can send';
      const prefix = /^(e\d+)[A-Z]/.exec(p)?.[1];
      if (prefix && u[prefix + 'BlendOpacity']) { off.add(prefix); warn(p, `effect ${prefix} (${effectUniforms(u, prefix)}) is left out: its texture ${p} ${why}`); }
      else warn(p, `runs without ${p}, which ${why}; it reads black`);
    } else if (i.source === 'scalar') {
      if (p.endsWith('_jsgbFlipY')) { const base = p.slice(0, -10), t = (u[base] ?? u[base.replace(/^_/, '')])?.value; values.scalars[p] = t?.flipY ? 1 : 0; }
      else values.scalars[p] = num(u[p]?.value);
    } else if (i.source === 'vector') {
      const column = /^(\w+)_c(\d)$/.exec(p), size = /^(\w+)_jsgbSize$/.exec(p);
      const m = column && u[column[1]]?.value;
      if (m?.isMatrix3 || m?.isMatrix4) { const n = m.isMatrix3 ? 3 : 4, c = +column![2]; values.vectors[p] = [...m.elements.slice(c * n, c * n + n), 0].slice(0, 4); }
      else if (size) { const img = u[size[1]]?.value?.image; values.vectors[p] = [img?.width ?? 1, img?.height ?? 1, img?.depth ?? 1, 0]; }
      else values.vectors[p] = vectorOf(u[p]?.value);
    }
  }
  for (const prefix of off) values.scalars[prefix + 'BlendOpacity'] = 0;
  const effects = Object.keys(u).filter(k => /^e\d+BlendOpacity$/.test(k));
  return {values, skip: effects.length > 0 && effects.every(k => off.has(k.slice(0, -'BlendOpacity'.length)))};
}
