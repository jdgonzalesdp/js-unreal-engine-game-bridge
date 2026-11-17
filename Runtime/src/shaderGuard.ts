import type * as THREE from 'three-real';
import {host} from './host';
import type {TranslatedShader} from './shaders';

/** Whether a material's custom shader can be drawn yet. Some draws only make sense through the material's own
 *  vertex shader: a plain Mesh on an InstancedBufferGeometry, whose copies the shader places (sceneExport.ts
 *  emitGeometryInstances), and the bridge's own text material (troikaText.ts). Drawn with the generic stand-in
 *  material instead, they come out as stacks of unplaced template quads (troika text showed as solid 1 m squares in
 *  its outline colour), which three.js never draws. So they stay hidden while the translation runs, and for good
 *  when it fails.
 *
 *  syncMaterial records the translation result each time it describes a ShaderMaterial or a material patched in
 *  onBeforeCompile. Frames that skip the description (nothing changed, or only uniform values moved) keep the last
 *  result, which still holds: the shader source is part of what makes a material change. */
type ShaderState = 'ready' | 'pending' | 'failed';
const states = new WeakMap<object, ShaderState>();
const warned = new WeakSet<object>();
const warnedKeys = new Set<string>();

/** The result of translateShaderMaterial or translateHookedMaterial for this material: undefined while it runs. */
export function noteShader(mat: object, translated: TranslatedShader | null | undefined) {
  states.set(mat, translated === undefined ? 'pending' : translated ? 'ready' : 'failed');
}

/** False while the material's shader is translating or after its translation failed (logged once per material).
 *  Materials with no custom shader are always drawable. */
export function shaderDrawable(mat: THREE.Material, what: string): boolean {
  const state = states.get(mat);
  if (state === 'pending') return false;
  if (state !== 'failed') return true;
  if (!warned.has(mat)) {
    warned.add(mat);
    const key = `${what}|${mat.type}|${mat.name}`;
    if (!warnedKeys.has(key)) {
      if (warnedKeys.size > 256) warnedKeys.clear();
      warnedKeys.add(key);
      host.log('warn', `${what} with ${mat.type}${mat.name ? ` "${mat.name}"` : ''} stays hidden: its shader could not be translated, and the generic material can't place its vertices`);
    }
  }
  return false;
}
