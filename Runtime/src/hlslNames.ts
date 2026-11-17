/** GLSL names that HLSL reserves. SPIRV-Cross keeps a shader's own function and variable names, and some legal GLSL
 *  names are HLSL keywords that SPIRV-Cross does not escape (it was checked with the bundled build): a function named
 *  `line` (PrepViz's print grid) made Unreal's shader compiler stop at "modifiers must appear before type", and the
 *  material fell back to Unreal's default material. In the plan view's Print colors that default material covered
 *  the whole page outside the room. Such names get a jsgb_ prefix before translation.
 *
 *  `texture` and `sampler` stay: GLSL's own texture() is spelled that way. Uniform and attribute names stay too, since
 *  the host binds those by name; a shader that names a uniform after a keyword still fails as before. */
export const HLSL_RESERVED = [
  'line', 'lineadj', 'point', 'triangle', 'triangleadj', 'linear', 'nointerpolation', 'snorm', 'unorm',
  'groupshared', 'globallycoherent', 'register', 'packoffset', 'technique', 'technique10', 'technique11', 'pass',
  'compile', 'string', 'matrix', 'vector', 'dword', 'min16float', 'min10float', 'min16int', 'min12int', 'min16uint',
  'stateblock', 'stateblock_state', 'vertexfragment', 'pixelfragment', 'export', 'NULL', 'cbuffer', 'tbuffer',
];
const RESERVED = new RegExp(`(?<![\\w.#])(${HLSL_RESERVED.join('|')})\\b`, 'g');
const MEMBER = new RegExp(`\\.(${HLSL_RESERVED.join('|')})\\b`, 'g');

/** The names a shader binds from outside: its uniforms and vertex attributes. */
function boundNames(src: string): Set<string> {
  const names = new Set<string>();
  const rx = /(?:^|[;{}\n])\s*(?:layout\s*\([^)]*\)\s*)?(?:uniform|attribute)\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+([^;(){}]+);/g;
  for (const m of src.matchAll(rx)) for (const part of m[1].split(',')) { const n = /^\s*(\w+)/.exec(part)?.[1]; if (n) names.add(n); }
  return names;
}

/** The shader source with every HLSL-reserved name it declares itself renamed jsgb_<name>, uses and members included. */
export function escapeHlslNames(src: string): string {
  if (!RESERVED.test(src)) return src;
  RESERVED.lastIndex = 0;
  const keep = boundNames(src);
  return src.replace(RESERVED, (w: string) => keep.has(w) ? w : 'jsgb_' + w).replace(MEMBER, (m: string, w: string) => keep.has(w) ? m : '.jsgb_' + w);
}
