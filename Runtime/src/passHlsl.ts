import type {ShaderInput, TranslatedShader} from './shaders';

/** A full-screen pass's translated shader as the body of the material Unreal draws over a whole render target
 *  (JsgbPassMaterial.cpp), for passes the page runs into render targets and reads back (passRun.ts). shaders.ts
 *  translates the pass like any ShaderMaterial; its glue is written for a mesh, so here the vertex stage runs on the
 *  pixel's place in the target instead (a full-screen quad or triangle has position = uv * 2 - 1), and every texture
 *  stays a texture parameter: Unreal binds the targets of earlier passes to them. Pass targets keep WebGL's row
 *  order (the bottom row first, at v = 0), so uv and gl_FragCoord need no flip and neither do the textures that
 *  earlier passes wrote. */
export type PassShader = {key: string; hlsl: string; inputs: ShaderInput[]; problems: string[]};

const IDENTITY = 'float4x4(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)';
/** Mesh inputs a pass material has no source for (the uv stays: it is the pixel's place in the target). */
const MESH_INPUTS = /\bJsgb(P|N|C|IC|MX|MY|MZ|MO|V[0-3]|Pr[0-3]|Cam|W[0-3]|World|T\d+|I_\w+)\b/;
const VALUE_SOURCES = new Set(['scalar', 'vector', 'texture', 'volume']);

function textHash(s: string) {
  let a = 0x811c9dc5; for (let i = 0; i < s.length; i++) a = Math.imul(a ^ s.charCodeAt(i), 0x01000193);
  return (a >>> 0).toString(16);
}

/** perspective: the material declares PERSPECTIVE_CAMERA (isOrthographic is 0). uniforms: the pass's uniform names,
 *  so matrix uniforms can be bound by name. */
export function passShader(t: TranslatedShader, perspective: boolean, uniforms: string[]): PassShader {
  const problems: string[] = [];
  const split = t.hlsl.search(/^JsgbVS vs;$/m);
  if (split < 0) return {key: '', hlsl: '', inputs: [], problems: ['the translation has no vertex glue']};
  const types = t.hlsl.slice(0, split);
  // Matrix uniforms: SPIRV-Cross multiplies vectors on the left (mul(v, M)), so M's rows are three's columns.
  const added: ShaderInput[] = [];
  const bindMatrices = (target: string, stage: string) => {
    const body = new RegExp(`struct ${stage} \\{([\\s\\S]*?)\\n\\};`).exec(types)?.[1] ?? '';
    return [...body.matchAll(/^\s+float([234])x\1 (\w+);$/gm)].map(m => ({n: +m[1], member: m[2], name: uniforms.includes(m[2]) ? m[2] : m[2].replace(/^_/, '')}))
      .filter(m => uniforms.includes(m.name)).map(m => {
        const cols = Array.from({length: m.n}, (_, i) => `U_${m.name}_c${i}`);
        for (const [i, c] of cols.entries()) if (!added.some(a => a.name === c)) added.push({name: c, source: 'vector', param: `${m.name}_c${i}`});
        return `${target}.${m.member} = float${m.n}x${m.n}(${cols.map(c => c + '.' + 'xyzw'.slice(0, m.n)).join(', ')});`;
      });
  };
  const lines = t.hlsl.slice(split).split('\n').map(line => {
    let m: RegExpExecArray | null;
    if ((m = /^(vs|fs)\.(modelMatrix|viewMatrix|projectionMatrix) = float4x4\(/.exec(line))) return `${m[1]}.${m[2]} = ${IDENTITY};`;
    if ((m = /^(vs|fs)\.cameraPosition = JsgbCam\.xyz;$/.exec(line))) return `${m[1]}.cameraPosition = float3(0, 0, 0);`;
    if ((m = /^(vs|fs)\.isOrthographic = /.exec(line))) return `${m[1]}.isOrthographic = ${perspective ? 0 : 1};`;
    if (/^vs\.position = /.test(line)) return 'vs.position = float3(JsgbUV.x * 2.0 - 1.0, JsgbUV.y * 2.0 - 1.0, 0.0);';
    if (/^vs\.normal = /.test(line)) return 'vs.normal = float3(0.0, 0.0, 1.0);';
    if (/^vs\.(vert_main|frag_main)\(\);$/.test(line) || /^fs\.frag_main\(\);$/.test(line)) return [...bindMatrices(line.slice(0, 2), line.startsWith('vs') ? 'JsgbVS' : 'JsgbFS'), line].join('\n');
    return line.replace(/\bJsgbC\b(\.xyz)?/g, (_s, xyz) => xyz ? 'float3(1.0, 1.0, 1.0)' : 'float4(1.0, 1.0, 1.0, 1.0)');
  });
  const glue = lines.join('\n');
  const left = MESH_INPUTS.exec(glue);
  if (left) problems.push(`its glue still reads the mesh input ${left[0]}`);
  if (/\bJsgbEmissive\b/.test(glue)) problems.push('it writes a second (emissive) output');
  const used = (name: string) => new RegExp(`\\b${name}\\b`).test(glue);
  const inputs: ShaderInput[] = [...t.inputs.filter(i => VALUE_SOURCES.has(i.source) && used(i.name)), ...added];
  if (used('JsgbUV')) inputs.push({name: 'JsgbUV', source: 'uv', index: 0});
  for (const i of t.inputs) if (i.source === 'cube' && used(i.name)) problems.push(`it samples the cube texture ${i.param}`);
  const hlsl = types + glue;
  return {key: 'pass_' + t.key + '_' + textHash(hlsl), hlsl, inputs, problems};
}
