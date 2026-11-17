import * as THREE from 'three-real';
import {lastFrame} from './renderer';

/** sceneExport.ts compares each material's values as numbers every frame (quickValues) and describes the material
 *  again in full only when one of them moved. The version is one of those numbers, so a page that sets needsUpdate
 *  every frame had every such material described in full every frame, its uniforms read and its description turned
 *  into JSON, only to find nothing had changed (PrepViz does this to about 180 surface materials while an object is
 *  dragged: 7 ms of every frame in Node after its hooks stopped running again, hookKey.ts).
 *
 *  A version bump only matters to three when it comes with a change that picks another program: shader sources,
 *  defines, the onBeforeCompile hook, blending factors, an environment map. Those, and what else the description reads
 *  that the numbers leave out, are kept here from the last full description. When the version is the only number that
 *  moved and these are the same, the description stands, as the program does in three. */

type Instanced = {color: boolean; extras: {name: string; size: number; offset: number}[]} | undefined;
const described = new WeakMap<THREE.Material, unknown[]>();

/** The first index where the values differ (NaN equals NaN), from `from` on, or -1. */
export function firstChange(last: ArrayLike<number>, now: ArrayLike<number>, count: number, from = 0): number {
  for (let i = from; i < count; i++) if (last[i] !== now[i] && !(last[i] !== last[i] && now[i] !== now[i])) return i;
  return -1;
}

/** The userData the description reads: its first eight plain keys (tags) and a shader's depth pull. */
function tags(data: Record<string, unknown> | undefined): string {
  if (!data) return '';
  return Object.keys(data).filter(k => typeof data[k] !== 'object').slice(0, 8).join(',') + '|' + data.jsgbDepthPull;
}

/** What the material's description depends on beyond its quick values. Built only when its version moved. */
export function materialInputs(mat: THREE.Material, hook: {key: string} | undefined, linear: boolean | null, instanced: Instanced): unknown[] {
  const m = mat as THREE.Material & Record<string, any>;
  let defines = '';
  try { defines = JSON.stringify(m.defines ?? null); } catch { defines = 'v' + mat.version; }
  const shader = !!m.isShaderMaterial;
  const environment = (lastFrame.scene as THREE.Scene | null)?.environment;
  return [hook, hook?.key, shader ? m.vertexShader : '', shader ? m.fragmentShader : '', shader ? Object.keys(m.uniforms ?? {}).join(',') : '',
    !!m.isRawShaderMaterial, defines, m.envMap ?? null, !!environment, linear, m.blendSrc, m.blendDst, m.blendEquation, tags(m.userData),
    instanced ? `${instanced.color}|${instanced.extras.map(e => `${e.name}${e.size}@${e.offset}`).join(',')}` : ''];
}

export function rememberInputs(mat: THREE.Material, inputs: unknown[]) { described.set(mat, inputs); }

/** Whether these inputs are the ones the material's last full description was built from. */
export function sameInputs(mat: THREE.Material, inputs: unknown[]): boolean {
  const last = described.get(mat);
  if (!last || last.length !== inputs.length) return false;
  for (let i = 0; i < last.length; i++) if (last[i] !== inputs[i]) return false;
  return true;
}

/** Values the description reads that quickValues used to leave out: a fat line's width (the stand-in material keeps
 *  it in userData, so a Line2 that got thicker kept its old width in Unreal) and the built-in uniforms a patched
 *  material sends (specular, shininess, reflectivity, aoMapIntensity). s has room: quickValues keeps 64 slots. */
export function quickExtras(m: THREE.Material & Record<string, any>, s: Float64Array, i: number): number {
  const fat = m.userData?.jsgbFatWidth, sp = m.specular;
  s[i++] = typeof fat === 'number' ? fat : -1; s[i++] = m.userData?.jsgbFatWorld ? 1 : 0;
  s[i++] = sp?.isColor ? sp.r : -1; s[i++] = sp?.isColor ? sp.g : -1; s[i++] = sp?.isColor ? sp.b : -1;
  s[i++] = m.shininess ?? -1; s[i++] = m.reflectivity ?? -1; s[i++] = m.aoMapIntensity ?? -1;
  return i;
}
