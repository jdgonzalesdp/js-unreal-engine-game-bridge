import * as THREE from 'three-real';

/** The key under which the exporter keeps the output of a material's onBeforeCompile hook (sceneExport.ts hookShader).
 *
 *  three runs the hook again only when the material's program cache key changes (WebGLRenderer.getProgram): the
 *  material's customProgramCacheKey and the parameters that pick a program, such as its maps and defines. Setting
 *  needsUpdate (a version bump) with the same key reuses the compiled program and the uniforms the hook made the first
 *  time. The key used to start with the version, so a page that sets needsUpdate every frame (PrepViz does on about 180
 *  surface materials while an object is dragged) had each hook run again, its whole shader expanded and hashed again,
 *  every frame: 58 ms of a frame in Unreal. The output is the same either way, as three's is. */

type Cached = {key: string; version: number; hook: unknown; params?: string};
const MAPS = ['map', 'alphaMap', 'aoMap', 'bumpMap', 'normalMap', 'displacementMap', 'emissiveMap', 'envMap', 'lightMap',
  'metalnessMap', 'roughnessMap', 'specularMap', 'clearcoatMap', 'sheenColorMap', 'transmissionMap', 'gradientMap', 'matcap'];

/** The program parameters three folds into its key that a hook can see on the material. Built only when the version
 *  moved: three looks at them only then too. */
function programParams(mat: THREE.Material): string {
  const m = mat as unknown as Record<string, unknown>;
  let bits = '';
  for (const k of MAPS) bits += m[k] ? '1' : '0';
  let defines = '';
  try { defines = JSON.stringify(m.defines ?? null); } catch { defines = String(mat.version); }
  return `${bits}|${+!!m.vertexColors}|${+((m.alphaTest as number) > 0)}|${+!!m.alphaHash}|${+!!m.flatShading}|${mat.side}|${defines}`;
}

export function hookProgramKey(mat: THREE.Material, cached: Cached | undefined): string {
  const params = cached && cached.version === mat.version && cached.params !== undefined ? cached.params : programParams(mat);
  if (cached) cached.params = params;
  let custom = '';
  try { custom = String(mat.customProgramCacheKey?.() ?? ''); } catch { custom = 'v' + mat.version; }
  return `${custom}|${params}`;
}
