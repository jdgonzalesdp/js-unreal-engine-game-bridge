/** The shader translator writes legacy HLSL, which has no texelFetch and no textureSize: a shader that uses either
 *  failed to translate at all (PrepViz's camera image pipeline reads its dynamic-range curve with texelFetch).
 *  Both become ordinary lookups here, before translation: a texel is sampled at its centre and mip level, and the
 *  texture's size comes from a vecN uniform named <sampler>_jsgbSize that the host fills in from the texture.
 *  A function that takes a sampler and fetches from it gets that size as an extra parameter, and its callers pass it. */

const SAMPLER = /^(?:(?:in|const|lowp|mediump|highp)\s+)*(sampler2D|sampler3D)\s+(\w+)\s*$/;
const FETCH = /\b(texelFetch|textureSize)\s*\(/g;
const KEYWORDS = new Set(['return', 'else', 'case', 'do', 'discard']);

/** The arguments of the call whose '(' is at `open`, where each one ends, and the index after the ')'. */
function callArgs(s: string, open: number): {end: number; args: string[]; ends: number[]} {
  let depth = 0, start = open + 1; const args: string[] = [], ends: number[] = [];
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') { depth--; if (depth === 0) { args.push(s.slice(start, i).trim()); ends.push(i); return {end: i + 1, args, ends}; } }
    else if (c === ',' && depth === 1) { args.push(s.slice(start, i).trim()); ends.push(i); start = i + 1; }
  }
  return {end: s.length, args, ends};
}

type Param = {index: number; dims: number; name: string};
const sizeType = (dims: number) => dims === 3 ? 'vec3' : 'vec2';

/** Rewrites texelFetch and textureSize. `sized` lists the sampler uniforms that now need <name>_jsgbSize, `dims` their
 *  dimensions (2 or 3). */
export function sizedFetches(src: string): {src: string; sized: string[]; dims: Record<string, number>} {
  if (!/\b(texelFetch|textureSize)\s*\(/.test(src)) return {src, sized: [], dims: {}};
  const dims: Record<string, number> = {};
  for (const m of src.matchAll(/\buniform\s+(?:(?:lowp|mediump|highp)\s+)*(sampler2D|sampler3D)\s+(\w+)\s*;/g)) dims[m[2]] = m[1] === 'sampler3D' ? 3 : 2;
  // Functions with sampler parameters: where each is declared (a declaration is never taken for a call) and where its
  // body starts (the scope a fetch inside it belongs to).
  const fns = new Map<string, Param[]>(), declared = new Set<number>(), bodies: {at: number; name: string}[] = [];
  for (const m of src.matchAll(/\b(\w+)\s+(\w+)\s*\(([^()]*)\)\s*([{;])/g)) {
    if (KEYWORDS.has(m[1])) continue; // return f(x); is a call
    const params = m[3].split(',').map((p, index) => { const s = SAMPLER.exec(p.trim()); return s ? {index, dims: s[1] === 'sampler3D' ? 3 : 2, name: s[2]} : null; }).filter(Boolean) as Param[];
    declared.add(m.index! + m[0].lastIndexOf(m[2], m[0].indexOf('(')));
    if (params.length) fns.set(m[2], params);
    if (m[4] === '{') bodies.push({at: m.index!, name: m[2]});
  }
  const scopeOf = (at: number) => { let name = ''; for (const b of bodies) if (b.at < at) name = b.name; return name; };
  // Which samplers need a size: those fetched from, then whatever is passed into a sized parameter, until nothing changes.
  const needs = new Set<string>(); // "function:parameter" for parameters, the name for uniforms
  const mark = (name: string, at: number) => {
    const fn = scopeOf(at), key = fns.get(fn)?.some(p => p.name === name) ? fn + ':' + name : dims[name] ? name : '';
    if (!key || needs.has(key)) return false;
    needs.add(key); return true;
  };
  for (const m of src.matchAll(/\b(?:texelFetch|textureSize)\s*\(\s*(\w+)/g)) mark(m[1], m.index!);
  const calls = (name: string) => [...src.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))].map(m => ({at: m.index!, open: m.index! + m[0].length - 1}));
  for (let changed = true, rounds = 0; changed && rounds < 16; rounds++) {
    changed = false;
    for (const [name, params] of fns) for (const c of calls(name)) {
      if (declared.has(c.at)) continue;
      const {args} = callArgs(src, c.open);
      for (const p of params) if (needs.has(name + ':' + p.name) && /^\w+$/.test(args[p.index] ?? '')) changed = mark(args[p.index], c.at) || changed;
    }
  }
  // Sized parameters and the arguments that feed them: insertions only, so nested calls never collide.
  const inserts: {at: number; text: string}[] = [];
  const paramDims: Record<string, number> = {};
  for (const [name, params] of fns) {
    const sized = params.filter(p => needs.has(name + ':' + p.name));
    for (const p of sized) paramDims[p.name] = p.dims;
    if (sized.length) for (const c of calls(name)) {
      const {args, ends} = callArgs(src, c.open);
      for (const p of sized) if (ends[p.index] !== undefined) inserts.push({at: ends[p.index], text: declared.has(c.at) ? `, ${sizeType(p.dims)} ${p.name}_jsgbSize` : `, ${args[p.index]}_jsgbSize`});
    }
  }
  inserts.sort((a, b) => b.at - a.at);
  let out = src;
  for (const e of inserts) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  out = rewriteFetches(out, name => dims[name] ?? paramDims[name] ?? 2);
  const sized = Object.keys(dims).filter(n => needs.has(n));
  for (const n of sized) out = out.replace(new RegExp(`(\\buniform\\s+(?:(?:lowp|mediump|highp)\\s+)*sampler[23]D\\s+${n}\\s*;)`), `$1\nuniform ${sizeType(dims[n])} ${n}_jsgbSize;`);
  return {src: out, sized, dims};
}

/** texelFetch(s, p, lod) and textureSize(s, lod) as lookups sized by s_jsgbSize, nested calls included. */
function rewriteFetches(s: string, dimsOf: (name: string) => number): string {
  let out = '', last = 0, m: RegExpExecArray | null;
  const rx = new RegExp(FETCH.source, 'g');
  while ((m = rx.exec(s))) {
    const open = m.index + m[0].length - 1, {end, args} = callArgs(s, open);
    const a = args.map(x => rewriteFetches(x, dimsOf));
    const name = a[0], v = sizeType(dimsOf(name)), lod = (m[1] === 'texelFetch' ? a[2] : a[1]) ?? '0';
    const size = `max(${name}_jsgbSize * exp2(-float(${lod})), ${v}(1.0))`;
    out += s.slice(last, m.index) + (m[1] === 'texelFetch' ? `textureLod(${name}, (${v}(${a[1]}) + 0.5) / ${size}, float(${lod}))` : `i${v}(${size})`);
    last = end; rx.lastIndex = end;
  }
  return out + s.slice(last);
}
