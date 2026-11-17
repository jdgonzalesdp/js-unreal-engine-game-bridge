/** Full-screen post-processing passes for Unreal. A page's EffectComposer (pmndrs postprocessing, three's own, or a
 *  hand-made chain) draws the view into a render target, then full-screen passes that each read the one before, the
 *  last to the screen. The stand-in renderer reports those draws here (renderer.ts). The chain from the view to the
 *  screen goes to the host each frame it changes, as post-process materials in the same order with their uniforms
 *  (JsgbPostProcess.cpp), so exposure, white balance, tone curves, LUTs and grades show in Unreal as in the browser.
 *  Passes that only feed other passes (blur levels, a luminance reduction, an AA edge map) are not mirrored: the log
 *  names each effect or input that is left out because of them, and nothing is dropped without a line in the log. */
import {host} from './host';
import {frameCount} from './frameCount';
import {translateShaderMaterial} from './shaders';
import {postShader, type PostShader, type PostShaderInfo} from './postHlsl';
import {sizedFetches} from './texelFetch';
import {passValues, effectUniforms, type PassValues} from './postValues';

type Material = Record<string, any>;
type Draw = {material: Material; prev: number; input: string; copy: boolean; blends: boolean};
type Emit = (kind: string, parameters: Record<string, unknown>) => void;

// This frame's pass draws since the view was drawn, and which draw last wrote each texture (-1: the view).
let draws: Draw[] = [];
let writers = new Map<object, number>();
let viewSize: [number, number] = [0, 0], viewFrame = -1;
/** The chain the screen showed last: each pass's material and the sampler that reads the pass before it. */
let chain: {material: Material; input: string}[] = [];

/** What the bridge mirrors now, for /bridge/eval: pass names in order, problems logged, chain updates sent. */
export const postState = {chain: [] as string[], pending: 0, sends: 0, problems: [] as string[]};
(globalThis as Record<string, unknown>).__jsgbPostPasses = postState;

/** The main renderer drew the view: into a render target a composer reads, or straight to the screen (no passes). */
export function noteViewDraw(target: Material | null) {
  const tex = target?.texture;
  // A scene drawn over a buffer a pass already wrote in this animation frame (overlays a pass adds on top) is not a
  // new view.
  if (tex && viewFrame === frameCount.animation && (writers.get(tex) ?? -1) >= 0) return;
  draws = []; writers = new Map(); viewFrame = frameCount.animation;
  if (tex) { writers.set(tex, -1); viewSize = [tex.image?.width ?? 0, tex.image?.height ?? 0]; }
  else if (!target) chain = [];
}

/** The main renderer drew one full-screen pass into `target` (null: the screen). */
export function notePassDraw(material: Material | null | undefined, target: Material | null) {
  if (!material) return;
  // A page that never draws a view (shader passes only, a feedback buffer) starts over here; the writers go too, so no
  // pass points at a draw that is gone.
  if (draws.length > 512) { draws = []; writers = new Map(); }
  // The pass's input: a texture the view or an earlier pass wrote this frame. The usual names come first, then a
  // texture the view's size (a bloom composite also reads its smaller blur levels), then the latest one written.
  const u = material.uniforms as Record<string, {value: any} | undefined> | undefined;
  let input = '', prev = -2, best = -1;
  for (const k of u ? Object.keys(u) : ['map']) {
    const tex = u ? u[k]?.value : material.map;
    if (!tex?.isTexture || !writers.has(tex)) continue;
    const w = writers.get(tex)!;
    const score = (k === 'inputBuffer' || k === 'tDiffuse' ? 4 : 0) + (tex.image?.width === viewSize[0] && tex.image?.height === viewSize[1] ? 2 : 0);
    if (score > best || (score === best && w > prev)) { best = score; prev = w; input = k; }
  }
  // three's OutputPass tone maps and encodes for the display, which Unreal's tonemapper already does with the
  // settings renderer.ts reads from it, so it counts as a copy. A pass drawn with blending adds to what its target
  // held (UnrealBloomPass's additive copy, an outline), which a post-process material can't do.
  const display = material.name === 'OutputShader' || material.name === 'GammaCorrectionShader' || !!u?.toneMappingExposure;
  const blending = material.blending ?? 1, blends = blending !== 0 && !(blending === 1 && !material.transparent);
  const index = draws.push({material, prev, input, copy: !material.isShaderMaterial || display, blends}) - 1;
  if (target?.texture) writers.set(target.texture, index);
  else if (!target) publish(index);
}

/** The screen was drawn: the passes from the view to it, when they lead back to the view. */
function publish(last: number) {
  const out: typeof chain = [];
  let i = last, blended: Material | null = null;
  for (let n = 0; i >= 0 && n < 64; n++) {
    const d = draws[i]; if (!d) return;
    if (d.blends) blended ??= d.material;
    if (!d.copy) out.unshift({material: d.material, input: d.input});
    i = d.prev;
  }
  if (i !== -1) return;
  // A chain through a blended pass is not mirrored: Unreal shows the view as it did before passes were mirrored.
  if (blended) warnOnce('blend:' + (blended.name || blended.type), `${blended.name || blended.type || 'a pass'} draws with blending onto the picture before it, which a post-process material can't do, so Unreal shows the view without the post-processing chain`);
  chain = blended ? [] : out;
}

// Each pass material's translation, kept while its shader source stays the same.
type Prepared = {fs: string; vs: string; defines: string; input: string; proxy: Material; info: PostShaderInfo; shader?: PostShader | null};
const prepared = new WeakMap<Material, Prepared>();
const logged = new Set<string>();
function warnOnce(key: string, text: string) {
  if (logged.has(key)) return;
  logged.add(key); postState.problems.push(text);
  host.log('warn', 'post-processing: ' + text);
}
/** A pass as the log names it: its place, its material, and for a pmndrs EffectPass each effect by its uniforms. */
function label(m: Material, i: number) {
  const u = m.uniforms ?? {}, effects = Object.keys(u).filter(k => /^e\d+BlendOpacity$/.test(k)).map(k => k.slice(0, -'BlendOpacity'.length));
  const what = effects.length ? effects.map(e => `${e}: ${effectUniforms(u, e) || 'no uniforms'}`).join('; ') : m.name || m.type || 'material';
  return `pass ${i + 1} (${what})`;
}

/** A picture the size of the view that the bridge can't send (another pass's target: SMAA's colour input, a depth or
 *  normal pass, last frame's picture), read by a pass outside a pmndrs EffectPass. As black it would spoil the whole
 *  picture, so the chain is not mirrored; smaller ones (blur levels) read black. */
function viewSizedInput(m: Material, shader: PostShader): string {
  const u = m.uniforms ?? {};
  if (Object.keys(u).some(k => /^e\d+BlendOpacity$/.test(k))) return '';
  for (const i of shader.inputs) {
    const tex = i.param && i.source === 'texture' ? u[i.param]?.value : null;
    if (tex?.isTexture && !tex.isDepthTexture && (tex.isRenderTargetTexture || !tex.image?.data) && tex.image?.width === viewSize[0] && tex.image?.height === viewSize[1]) return i.param!;
  }
  return '';
}

function shaderFor(m: Material, input: string, name: string): PostShader | null | undefined {
  const defines = JSON.stringify(m.defines ?? {});
  let p = prepared.get(m);
  if (!p || p.fs !== m.fragmentShader || p.vs !== m.vertexShader || p.defines !== defines || p.input !== input) {
    // Unreal's tonemapper writes the display encoding, so the pass leaves its output linear.
    const d = {...(m.defines ?? {})}; delete d.ENCODE_OUTPUT;
    const proxy = {name: m.name, vertexShader: sizedFetches(m.vertexShader ?? '').src, fragmentShader: sizedFetches(m.fragmentShader ?? '').src, defines: d,
      glslVersion: m.glslVersion, isRawShaderMaterial: m.isRawShaderMaterial};
    const u = m.uniforms ?? {};
    const depth = Object.keys(u).filter(k => k !== input && (u[k]?.value?.isDepthTexture || (k === 'depthBuffer' && !u[k]?.value)));
    p = {fs: m.fragmentShader, vs: m.vertexShader, defines, input, proxy, info: {scene: [input], depth, perspective: 'PERSPECTIVE_CAMERA' in d, uniforms: Object.keys(u)}};
    prepared.set(m, p);
  }
  if (p.shader !== undefined) return p.shader;
  if (!m.isShaderMaterial) { warnOnce(name + ':kind', `${name} is a ${m.type}, not a shader pass, and is left out`); return p.shader = null; }
  const t = translateShaderMaterial(p.proxy as never);
  if (t === undefined) return undefined;
  if (!t) { warnOnce(name + ':translate', `${name} could not be translated to HLSL and is left out`); return p.shader = null; }
  const s = postShader(t, p.info);
  if (s.problems.length) { warnOnce(name + ':glue', `${name} is left out: ${s.problems.join('; ')}`); return p.shader = null; }
  return p.shader = s;
}

const sentShaders = new Set<string>();
let lastJson = '';
/** Sends the chain the screen shows (only when it or one of its values changed), with new shaders and textures first. */
export function exportPostPasses(emit: Emit) {
  let passes: (PassValues & {key: string})[] = [], names: string[] = [];
  let pending = 0, needs = '', resent = false;
  // A lookup texture sent again keeps its id (a curve edited in place), so the chain goes out too: Unreal's instances
  // then take the new texture.
  const send: Emit = (kind, parameters) => { if (kind === 'postTexture') resent = true; emit(kind, parameters); };
  chain.forEach(({material, input}, i) => {
    const name = label(material, i);
    if (!input) { warnOnce(name + ':input', `${name} reads no texture from the pass before it and is left out`); return; }
    const shader = shaderFor(material, input, name);
    if (shader === undefined) { pending++; return; }
    if (!shader) return;
    const lost = viewSizedInput(material, shader);
    if (lost) { needs ||= `${name} needs ${lost}`; return; }
    if (!sentShaders.has(shader.key)) { sentShaders.add(shader.key); emit('postShader', {key: shader.key, name, hlsl: shader.hlsl, inputs: shader.inputs}); }
    const {values, skip} = passValues(material, shader, send, (param, text) => warnOnce(name + ':' + param, `${name}: ${text}`));
    if (skip) { warnOnce(name + ':skip', `${name} changes nothing once its left-out effects are gone, so Unreal skips it`); return; }
    passes.push({key: shader.key, ...values}); names.push(name);
  });
  if (needs) {
    warnOnce('needs:' + needs, `${needs}, a picture the size of the view that another pass draws, so Unreal shows the view without the post-processing chain`);
    passes = []; names = [];
  }
  postState.chain = names; postState.pending = pending;
  const json = JSON.stringify(passes);
  if (json === lastJson && !resent) return;
  lastJson = json; postState.sends++;
  emit('post', {passes});
}
