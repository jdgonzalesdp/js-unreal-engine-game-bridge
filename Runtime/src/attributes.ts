/** Extra vertex attributes (a shader's own `attribute float intensity;` and the like) travel to
 *  Unreal in UV channels 1-7, so generated shader materials can read them per vertex. A name keeps
 *  its channel for the whole session; attributes wider than two floats take two channels. */
const BUILTIN = new Set(['position', 'normal', 'uv', 'color', 'tangent', 'skinIndex', 'skinWeight', 'instanceMatrix', 'instanceColor']);
const channels = new Map<string, {channel: number; size: number}>();
let next = 1;
/** Attributes the bridge writes for its own shaders (troikaGlyphs.ts) keep fixed channels. The main thread places
 *  attributes and the shader worker reads them, each with its own copy of this map, and translations are kept on
 *  disk, so a channel handed out in order of first sight could differ between them. Those meshes carry no game
 *  attribute, so a game's attribute may still use the same channels on its own meshes. */
const FIXED = new Map<string, {channel: number; size: number}>([['aJsgbTextGlyph', {channel: 6, size: 4}]]);

export const isExtraAttribute = (name: string) => !BUILTIN.has(name);

/** The first UV channel holding attribute `name` (size 1-4), or null when the channels are used up. */
export function channelFor(name: string, size: number): {channel: number; size: number} | null {
  let c = FIXED.get(name) ?? channels.get(name);
  if (!c) {
    const need = size > 2 ? 2 : 1;
    if (next + need > 8) return null;
    c = {channel: next, size}; next += need; channels.set(name, c);
  }
  return c;
}
