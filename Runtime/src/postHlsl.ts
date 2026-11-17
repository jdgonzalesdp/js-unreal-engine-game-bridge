import type {ShaderInput, TranslatedShader} from './shaders';

/** A full-screen pass's translated shader as the body of an Unreal post-process material (JsgbPostProcess.cpp).
 *  shaders.ts translates the pass like any ShaderMaterial; its glue is written for a mesh, so here the vertex stage
 *  runs on the pixel's place on the screen instead (three's full-screen triangle maps it one to one), the pass's
 *  input reads Unreal's scene colour, and a depth texture reads Unreal's scene depth as WebGL depth. Three's texture
 *  v runs up the screen and Unreal's viewport v down it, so both flip. Unreal pre-exposes scene colour; the input
 *  takes that out and the post material puts it back, so the pass sees the same linear values as in the browser. */

/** The Custom node's inputs: the translator's parameters, plus the scene colour and depth the code looks up. */
export type PostInput = Omit<ShaderInput, 'source'> & {source: ShaderInput['source'] | 'sceneColor' | 'sceneDepth'};
export type PostShader = {key: string; hlsl: string; inputs: PostInput[]; problems: string[]};
export type PostShaderInfo = {
  /** Samplers that read the previous pass (or the view): inputBuffer in an EffectComposer, tDiffuse in a ShaderPass. */
  scene: string[];
  /** Samplers that read the view's depth. */
  depth: string[];
  /** Whether depth turns into WebGL depth for a perspective camera (else orthographic). */
  perspective: boolean;
  /** The pass's uniform names, so matrix uniforms can be bound by name. */
  uniforms: string[];
};

const LOOKUPS = (at: string) => ['Sample(JsgbSceneSampler s, float2 uv)', 'SampleLevel(JsgbSceneSampler s, float2 uv, float lod)',
  'SampleBias(JsgbSceneSampler s, float2 uv, float bias)', 'SampleGrad(JsgbSceneSampler s, float2 uv, float2 dx, float2 dy)']
  .map(sig => `  float4 ${sig} { return ${at}; }`).join('\n');
// Scene colour and depth as texture-like structs the translated code samples as it would a Texture2D.
const SCENE_TYPES = `struct JsgbSceneSampler { float Pad; };
struct JsgbSceneInput { float Pad;
  float4 At(float2 uv) { float4 c = SceneTextureLookup(ClampSceneTextureUV(ViewportUVToSceneTextureUV(float2(uv.x, 1.0 - uv.y), 14), 14), 14, true); c.rgb *= View.OneOverPreExposure; return c; }
${LOOKUPS('At(uv)')}
};
struct JsgbSceneDepth { float Near; float Far; float Persp;
  float4 At(float2 uv) {
    float z = -SceneTextureLookup(ViewportUVToSceneTextureUV(float2(uv.x, 1.0 - uv.y), 1), 1, false).r * 0.01;
    float d = Persp > 0.5 ? ((Near + z) * Far) / ((Far - Near) * min(z, -1e-6)) : (z + Near) / (Near - Far);
    return float4(saturate(d), 0.0, 0.0, 1.0);
  }
${LOOKUPS('At(uv)')}
};
`;
const IDENTITY = 'float4x4(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)';
const MESH_INPUTS = /\bJsgb(P|N|UV|C|MX|MY|MZ|MO|V[0-3]|Pr[0-3]|Cam)\b/;
const VALUE_SOURCES = new Set(['scalar', 'vector', 'texture', 'volume', 'cube']);

function textHash(s: string) {
  let a = 0x811c9dc5; for (let i = 0; i < s.length; i++) a = Math.imul(a ^ s.charCodeAt(i), 0x01000193);
  return (a >>> 0).toString(16);
}

export function postShader(t: TranslatedShader, info: PostShaderInfo): PostShader {
  const problems: string[] = [];
  const split = t.hlsl.search(/^JsgbVS vs;$/m);
  if (split < 0) return {key: '', hlsl: '', inputs: [], problems: ['the translation has no vertex glue']};
  let types = t.hlsl.slice(0, split), glue = t.hlsl.slice(split);
  const esc = (s: string) => s.replace(/[$]/g, '\\$');
  for (const [names, type] of [[info.scene, 'JsgbSceneInput'], [info.depth, 'JsgbSceneDepth']] as const) for (const n of names) {
    if (new RegExp(`\\b${n}\\s*,\\s*${n}Sampler\\b`).test(types)) problems.push(`it passes ${n} to a function`);
    if (new RegExp(`\\b${n}\\.(GetDimensions|Load)\\b|spvTextureSize\\(${n}\\b`).test(types)) problems.push(`it asks ${n} for its size or single texels`);
    types = types.replace(new RegExp(`\\bTexture2D ${n}; SamplerState ${n}Sampler;`, 'g'), `${type} ${esc(n)}; JsgbSceneSampler ${esc(n)}Sampler;`);
  }
  const has = (name: string) => t.inputs.some(i => i.name === name);
  const near = has('U_cameraNear') ? '(float)U_cameraNear' : '0.1', far = has('U_cameraFar') ? '(float)U_cameraFar' : '1000.0';
  // Matrix uniforms: SPIRV-Cross multiplies vectors on the left (mul(v, M)), so M's rows are three's columns.
  const matrices = (stage: 'JsgbVS' | 'JsgbFS') => {
    const body = new RegExp(`struct ${stage} \\{([\\s\\S]*?)\\n\\};`).exec(types)?.[1] ?? '';
    return [...body.matchAll(/^\s+float([234])x\1 (\w+);$/gm)].map(m => ({n: +m[1], member: m[2], name: info.uniforms.includes(m[2]) ? m[2] : m[2].replace(/^_/, '')}))
      .filter(m => info.uniforms.includes(m.name));
  };
  const added: PostInput[] = [];
  const bindMatrices = (target: string, stage: 'JsgbVS' | 'JsgbFS') => matrices(stage).map(m => {
    const cols = Array.from({length: m.n}, (_, i) => `U_${m.name}_c${i}`);
    for (const [i, c] of cols.entries()) if (!added.some(a => a.name === c)) added.push({name: c, source: 'vector', param: `${m.name}_c${i}`});
    return `${target}.${m.member} = float${m.n}x${m.n}(${cols.map(c => c + '.' + 'xyzw'.slice(0, m.n)).join(', ')});`;
  });
  const lines = glue.split('\n').map(line => {
    let m: RegExpExecArray | null;
    if ((m = /^(vs|fs)\.(modelMatrix|viewMatrix|projectionMatrix) = float4x4\(/.exec(line))) return `${m[1]}.${m[2]} = ${IDENTITY};`;
    if ((m = /^(vs|fs)\.cameraPosition = JsgbCam\.xyz;$/.exec(line))) return `${m[1]}.cameraPosition = float3(0, 0, 0);`;
    if ((m = /^(vs|fs)\.isOrthographic = /.exec(line))) return `${m[1]}.isOrthographic = ${info.perspective ? 0 : 1};`;
    if (/^vs\.position = /.test(line)) return 'vs.position = float3(jsgbVp.x * 2.0 - 1.0, 1.0 - jsgbVp.y * 2.0, 0.0);';
    if (/^vs\.normal = /.test(line)) return 'vs.normal = float3(0.0, 0.0, 1.0);';
    if (/^vs\.uv = JsgbUV;$/.test(line) || /^fs\.jsgb_PointCoord = JsgbUV;$/.test(line)) return line.replace('JsgbUV', 'jsgbUv');
    if (/^fs\.gl_FragCoord = Parameters\.SvPosition;$/.test(line)) return 'fs.gl_FragCoord = float4(jsgbUv * View.ViewSizeAndInvSize.xy, Parameters.SvPosition.z, 1.0);';
    if (/^vs\.(vert_main|frag_main)\(\);$/.test(line) || /^fs\.frag_main\(\);$/.test(line)) return [...bindMatrices(line.slice(0, 2), line.startsWith('vs') ? 'JsgbVS' : 'JsgbFS'), line].join('\n');
    for (const n of info.scene) {
      if ((m = new RegExp(`^(vs|fs)\\.${n} = T_${n}; \\1\\.${n}Sampler = T_${n}Sampler;$`).exec(line))) return `${m[1]}.${n}.Pad = 0.0; ${m[1]}.${n}Sampler.Pad = 0.0;`;
      if ((m = new RegExp(`^(vs|fs)\\.${n}_jsgbFlipY = `).exec(line))) return `${m[1]}.${n}_jsgbFlipY = 0.0;`;
    }
    for (const n of info.depth) {
      if ((m = new RegExp(`^(vs|fs)\\.${n} = T_${n}; \\1\\.${n}Sampler = T_${n}Sampler;$`).exec(line))) {
        return `${m[1]}.${n}.Near = ${near}; ${m[1]}.${n}.Far = ${far}; ${m[1]}.${n}.Persp = ${info.perspective ? 1 : 0}; ${m[1]}.${n}Sampler.Pad = 0.0;`;
      }
      if ((m = new RegExp(`^(vs|fs)\\.${n}_jsgbFlipY = `).exec(line))) return `${m[1]}.${n}_jsgbFlipY = 0.0;`;
    }
    return line.replace(/\bJsgbC\b(\.xyz)?/g, (_s, xyz) => xyz ? 'float3(1.0, 1.0, 1.0)' : 'float4(1.0, 1.0, 1.0, 1.0)');
  });
  glue = ['float2 jsgbVp = GetViewportUV(Parameters);', 'float2 jsgbUv = float2(jsgbVp.x, 1.0 - jsgbVp.y);', ...lines].join('\n');
  const left = MESH_INPUTS.exec(glue);
  if (left) problems.push(`its glue still reads the mesh input ${left[0]}`);
  const inputs: PostInput[] = [...t.inputs.filter(i => VALUE_SOURCES.has(i.source) && new RegExp(`\\b${i.name}\\b`).test(glue)), ...added,
    {name: 'JsgbSceneIn', source: 'sceneColor'}, ...(info.depth.length ? [{name: 'JsgbDepthIn', source: 'sceneDepth' as const}] : [])];
  const hlsl = SCENE_TYPES + types + glue;
  return {key: 'post_' + t.key + '_' + textHash(JSON.stringify(info.scene) + JSON.stringify(info.depth) + info.perspective + hlsl.length), hlsl, inputs, problems};
}
