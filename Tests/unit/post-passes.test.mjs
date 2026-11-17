// A post-processing chain drawn through the stand-in renderer reaches the host as post-process materials, in order,
// with values that follow the page's uniforms (Runtime/src/postPasses.ts). The passes have the shape pmndrs
// postprocessing gives an EffectPass (inputBuffer, effects prefixed e0, e1 with a blend opacity each) and run through
// the real shader translator, so the HLSL checked here is what Unreal compiles.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {loadRuntime, moduleThreeUrl} from './load-runtime.mjs';

const THREE = await import(moduleThreeUrl);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wasm = fs.readFileSync(path.join(root, 'Runtime/vendor/cross-shader/CrossShader.wasm'));
// The compiler's Emscripten loader looks for Node's require and __dirname.
globalThis.require ??= createRequire(import.meta.url); globalThis.__dirname ??= root;
const events = [], logs = [], store = new Map();
const host = {log: (level, text) => logs.push(`${level} ${text}`), registry: '', search: '', now: () => 0, shaderPreparation: true,
  readFile: p => p.endsWith('CrossShader.wasm') ? wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) : null,
  storage: {load: k => store.get(k) ?? null, save: (k, v) => store.set(k, v)},
  sink: {geometry() {}, releaseGeometry() {}, material() {}, materialUniforms() {}, texture() {}, shader() {}, frame() {}, events: json => events.push(...JSON.parse(json))}};
globalThis.document ??= {createElement: () => ({style: {}})};
const x = await loadRuntime('../../Tests/unit/post-passes-fixture.ts', host, moduleThreeUrl);

const VERTEX = 'varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }';
const frag = (head, image) => `uniform sampler2D inputBuffer; uniform sampler2D depthBuffer; uniform float cameraNear, cameraFar; varying vec2 vUv;\n${head}\n` +
  `vec4 blend23(const in vec4 a, const in vec4 b, const in float o) { return mix(a, b, o); }\n` +
  `void main() { vec4 color0 = texture2D(inputBuffer, vUv); vec4 color1 = vec4(0.0);\n${image}\n gl_FragColor = color0;\n#ifdef ENCODE_OUTPUT\n#include <colorspace_fragment>\n#endif\n}`;
/** Exposure times a white-balance gain, as PrepViz's ExposureScaleEffect. */
const exposure = new THREE.ShaderMaterial({name: 'EffectMaterial', vertexShader: VERTEX, defines: {ENCODE_OUTPUT: '1', PERSPECTIVE_CAMERA: '1'},
  uniforms: {inputBuffer: {value: null}, depthBuffer: {value: null}, cameraNear: {value: 0.1}, cameraFar: {value: 100}, e0Scale: {value: 0.25}, e0WbGain: {value: new THREE.Vector3(1, 0.9, 0.8)}, e0BlendOpacity: {value: 1}},
  fragmentShader: frag('uniform float e0Scale; uniform vec3 e0WbGain; uniform float e0BlendOpacity;\nvoid e0MainImage(const in vec4 c, const in vec2 uv, out vec4 o) { o = vec4(c.rgb * e0Scale * e0WbGain, c.a); }',
    'e0MainImage(color0, vUv, color1); color0 = blend23(color0, color1, e0BlendOpacity);')});
/** A calibration matrix and a curve read with texelFetch (as PrepViz's image pipeline), and a second effect that reads
 *  another pass's render target, which Unreal can't follow. */
const curve = new THREE.DataTexture(new Float32Array([0, 0.25, 0.5, 1]), 4, 1, THREE.RedFormat, THREE.FloatType); curve.needsUpdate = true;
const blurred = new THREE.WebGLRenderTarget(64, 32);
const look = new THREE.ShaderMaterial({name: 'EffectMaterial', vertexShader: VERTEX, defines: {},
  uniforms: {inputBuffer: {value: null}, depthBuffer: {value: null}, cameraNear: {value: 0.1}, cameraFar: {value: 100}, e0UCalibration: {value: new THREE.Matrix3().set(1, 0, 0, 0, 2, 0, 0, 0, 3)},
    e0UCurve: {value: curve}, e0BlendOpacity: {value: 1}, e1UBloom: {value: blurred.texture}, e1BlendOpacity: {value: 1}},
  fragmentShader: frag('uniform mat3 e0UCalibration; uniform highp sampler2D e0UCurve; uniform float e0BlendOpacity; uniform sampler2D e1UBloom; uniform float e1BlendOpacity;\n' +
    'float e0Tone(highp sampler2D t, float x) { return texelFetch(t, ivec2(int(clamp(x, 0.0, 1.0) * 3.0), 0), 0).r; }\n' +
    'void e0MainImage(const in vec4 c, const in vec2 uv, out vec4 o) { vec3 v = e0UCalibration * c.rgb; o = vec4(vec3(e0Tone(e0UCurve, v.g)), c.a); }\n' +
    'void e1MainImage(const in vec4 c, const in vec2 uv, out vec4 o) { o = c + texture2D(e1UBloom, uv); }',
    'e0MainImage(color0, vUv, color1); color0 = blend23(color0, color1, e0BlendOpacity); e1MainImage(color0, vUv, color1); color0 = blend23(color0, color1, e1BlendOpacity);')});

const canvas = {isConnected: true, width: 800, height: 400, style: {}};
const renderer = new x.UnrealRenderer({canvas});
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(50, 2, 0.1, 100);
const a = new THREE.WebGLRenderTarget(800, 400), b = new THREE.WebGLRenderTarget(800, 400), side = new THREE.WebGLRenderTarget(64, 32);
const passCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const pass = material => { const s = new THREE.Scene(); const tri = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3)), material); tri.frustumCulled = false; s.add(tri); return s; };
const exposurePass = pass(exposure), lookPass = pass(look), blurPass = pass(new THREE.ShaderMaterial({uniforms: {inputBuffer: {value: null}}, vertexShader: VERTEX, fragmentShader: 'uniform sampler2D inputBuffer; varying vec2 vUv; void main() { gl_FragColor = texture2D(inputBuffer, vUv); }'}));
/** One composer frame: the view into a, exposure a to b, a side blur from b, the look b to the screen. */
function drawFrame() {
  x.frameCount.animation++;
  renderer.setRenderTarget(a); renderer.render(scene, camera);
  exposure.uniforms.inputBuffer.value = a.texture; renderer.setRenderTarget(b); renderer.render(exposurePass, passCamera);
  blurPass.children[0].material.uniforms.inputBuffer.value = b.texture; renderer.setRenderTarget(side); renderer.render(blurPass, passCamera);
  look.uniforms.inputBuffer.value = b.texture; renderer.setRenderTarget(null); renderer.render(lookPass, passCamera);
}
async function settle() {
  for (let i = 0; i < 300 && x.postState.chain.length < 2; i++) { drawFrame(); x.exportFrame(); await new Promise(r => setTimeout(r, 5)); }
}
const last = kind => events.filter(e => e.kind === kind).at(-1)?.parameters;

test('the chain from the view to the screen goes out in order, translated, with its uniform values', async () => {
  await settle();
  assert.deepEqual(x.postState.chain, ['pass 1 (e0: scale, wbGain)', 'pass 2 (e0: uCalibration, uCurve; e1: uBloom)'], 'the side blur is not part of the chain');
  const shaders = events.filter(e => e.kind === 'postShader').map(e => e.parameters);
  assert.equal(shaders.length, 2);
  for (const s of shaders) {
    assert.match(s.hlsl, /JsgbSceneInput inputBuffer; JsgbSceneSampler inputBufferSampler;/);
    assert.match(s.hlsl, /JsgbSceneDepth depthBuffer;/);
    assert.doesNotMatch(s.hlsl, /\bJsgb(P|N|UV|MX|MO|V0|Pr0|Cam)\b/, 'no mesh inputs are left in a post material');
    assert.ok(s.inputs.some(i => i.source === 'sceneColor'));
  }
  assert.doesNotMatch(shaders[0].hlsl, /linearToOutputTexel|pow\(/, 'the output stays linear: Unreal encodes it');
  assert.match(shaders[1].hlsl, /fs\.e0UCalibration = float3x3\(U_e0UCalibration_c0\.xyz, U_e0UCalibration_c1\.xyz, U_e0UCalibration_c2\.xyz\);/);
  const chain = last('post').passes;
  assert.equal(chain.length, 2);
  assert.deepEqual(chain.map(p => p.key), shaders.map(s => s.key));
  assert.equal(chain[0].scalars.e0Scale, 0.25);
  assert.deepEqual(chain[0].vectors.e0WbGain.slice(0, 3).map(v => +v.toFixed(3)), [1, 0.9, 0.8]);
  // Matrix3 columns, the sized curve and the curve texture itself.
  assert.deepEqual(chain[1].vectors.e0UCalibration_c1.slice(0, 3), [0, 2, 0]);
  assert.deepEqual(chain[1].vectors.e0UCurve_jsgbSize.slice(0, 2), [4, 1]);
  const tex = events.find(e => e.kind === 'postTexture').parameters;
  assert.equal(chain[1].textures.e0UCurve, tex.id);
  assert.deepEqual([tex.width, tex.height, tex.depth, tex.volume], [4, 1, 1, 0]);
  const px = new Float32Array(new Uint8Array(Buffer.from(tex.data, 'base64')).buffer);
  assert.deepEqual(Array.from(px.slice(4, 8)), [0.25, 0, 0, 1]);
});

test('an effect that reads a render target is left out with a log line, the rest of its pass stays', () => {
  const chain = last('post').passes;
  assert.equal(chain[1].scalars.e1BlendOpacity, 0);
  assert.equal(chain[1].scalars.e0BlendOpacity, 1);
  assert.ok(logs.some(l => /pass 2 \(e0: uCalibration, uCurve; e1: uBloom\): effect e1 \(uBloom\) is left out: its texture e1UBloom is drawn by another pass/.test(l)), logs.join('\n'));
});

test('changing the exposure sends the new value; an unchanged frame sends nothing', () => {
  const before = events.filter(e => e.kind === 'post').length;
  drawFrame(); x.exportFrame();
  assert.equal(events.filter(e => e.kind === 'post').length, before);
  exposure.uniforms.e0Scale.value = 0.5;
  drawFrame(); x.exportFrame();
  assert.equal(last('post').passes[0].scalars.e0Scale, 0.5);
});

test('ping-pong buffers and a scene drawn over a pass keep the chain from one frame to the next', async () => {
  // As an EffectComposer swaps its two buffers: the view into a, exposure a to b, an overlay scene over b, the look b to a,
  // then a copy of a to the screen. The next frame draws the view into a again.
  const copy = pass(new THREE.ShaderMaterial({name: 'CopyMaterial', uniforms: {inputBuffer: {value: null}}, vertexShader: VERTEX, fragmentShader: 'uniform sampler2D inputBuffer; varying vec2 vUv; void main() { gl_FragColor = texture2D(inputBuffer, vUv); }'}));
  const overlay = new THREE.Scene();
  for (let frame = 0; frame < 300 && x.postState.chain.length < 3; frame++) {
    x.frameCount.animation++;
    renderer.setRenderTarget(a); renderer.render(scene, camera);
    exposure.uniforms.inputBuffer.value = a.texture; renderer.setRenderTarget(b); renderer.render(exposurePass, passCamera);
    renderer.render(overlay, camera);
    look.uniforms.inputBuffer.value = b.texture; renderer.setRenderTarget(a); renderer.render(lookPass, passCamera);
    copy.children[0].material.uniforms.inputBuffer.value = a.texture; renderer.setRenderTarget(null); renderer.render(copy, passCamera);
    x.exportFrame(); await new Promise(r => setTimeout(r, 5));
  }
  assert.deepEqual(x.postState.chain, ['pass 1 (e0: scale, wbGain)', 'pass 2 (e0: uCalibration, uCurve; e1: uBloom)', 'pass 3 (CopyMaterial)']);
});

test('a view drawn straight to the screen clears the chain', () => {
  renderer.setRenderTarget(null); renderer.render(scene, camera); x.exportFrame();
  assert.deepEqual(last('post').passes, []);
});

test('texelFetch and textureSize become sized lookups, through function parameters', () => {
  const r = x.sizedFetches('uniform sampler2D a;\nfloat f(sampler2D s) { return texelFetch(s, ivec2(textureSize(s, 0)) - 1, 0).r; }\nvoid main() { gl_FragColor = vec4(f(a)); }');
  assert.deepEqual(r.sized, ['a']);
  assert.match(r.src, /uniform vec2 a_jsgbSize;/);
  assert.match(r.src, /float f\(sampler2D s, vec2 s_jsgbSize\)/);
  assert.match(r.src, /f\(a, a_jsgbSize\)/);
  assert.doesNotMatch(r.src, /texelFetch|textureSize/);
});

// three's own EffectComposer: what a post material can't reproduce stays as it was before passes were mirrored.
const plain = (name, fs, uniforms, extra = {}) => pass(new THREE.ShaderMaterial({name, uniforms, vertexShader: VERTEX, fragmentShader: fs, ...extra}));
const copyFs = 'uniform sampler2D tDiffuse; varying vec2 vUv; void main() { gl_FragColor = texture2D(tDiffuse, vUv); }';
test("three's OutputPass is left to Unreal's tonemapper, not mirrored as a second tone curve", () => {
  const output = plain('OutputShader', copyFs, {tDiffuse: {value: null}, toneMappingExposure: {value: 1}});
  x.frameCount.animation++;
  renderer.setRenderTarget(a); renderer.render(scene, camera);
  exposure.uniforms.inputBuffer.value = a.texture; renderer.setRenderTarget(b); renderer.render(exposurePass, passCamera);
  output.children[0].material.uniforms.tDiffuse.value = b.texture; renderer.setRenderTarget(null); renderer.render(output, passCamera);
  x.exportFrame();
  assert.deepEqual(x.postState.chain, ['pass 1 (e0: scale, wbGain)']);
});

test('a chain through a pass drawn with blending (UnrealBloomPass adds its glow) is not mirrored', () => {
  const add = plain('AddGlow', copyFs, {tDiffuse: {value: null}}, {blending: THREE.AdditiveBlending, transparent: true});
  x.frameCount.animation++;
  renderer.setRenderTarget(a); renderer.render(scene, camera);
  exposure.uniforms.inputBuffer.value = a.texture; renderer.setRenderTarget(b); renderer.render(exposurePass, passCamera);
  add.children[0].material.uniforms.tDiffuse.value = b.texture; renderer.setRenderTarget(a); renderer.render(add, passCamera);
  look.uniforms.inputBuffer.value = a.texture; renderer.setRenderTarget(null); renderer.render(lookPass, passCamera);
  x.exportFrame();
  assert.deepEqual(last('post').passes, []);
  assert.ok(logs.some(l => /AddGlow draws with blending/.test(l)), logs.join('\n'));
});

test('a page of shader passes with a feedback buffer and no view keeps drawing past the draw limit', () => {
  const sim = plain('Sim', copyFs, {tDiffuse: {value: null}});
  let read = a, write = b;
  for (let frame = 0; frame < 700; frame++) {
    x.frameCount.animation++;
    sim.children[0].material.uniforms.tDiffuse.value = read.texture; renderer.setRenderTarget(write); renderer.render(sim, passCamera);
    exposure.uniforms.inputBuffer.value = write.texture; renderer.setRenderTarget(null); renderer.render(exposurePass, passCamera);
    [read, write] = [write, read];
  }
});

test('a pass that also reads a view-sized picture the bridge cannot follow leaves the chain out', async () => {
  const other = new THREE.WebGLRenderTarget(800, 400);
  const blend = plain('NeedsColor', 'uniform sampler2D tDiffuse; uniform sampler2D tColor; varying vec2 vUv; void main() { gl_FragColor = texture2D(tDiffuse, vUv) * texture2D(tColor, vUv); }',
    {tDiffuse: {value: null}, tColor: {value: other.texture}});
  for (let i = 0; i < 300 && !logs.some(l => /NeedsColor\) needs tColor/.test(l)); i++) {
    x.frameCount.animation++;
    renderer.setRenderTarget(a); renderer.render(scene, camera);
    exposure.uniforms.inputBuffer.value = a.texture; renderer.setRenderTarget(b); renderer.render(exposurePass, passCamera);
    blend.children[0].material.uniforms.tDiffuse.value = b.texture; renderer.setRenderTarget(null); renderer.render(blend, passCamera);
    x.exportFrame(); await new Promise(r => setTimeout(r, 5));
  }
  assert.ok(logs.some(l => /NeedsColor\) needs tColor, a picture the size of the view/.test(l)), logs.join('\n'));
  assert.deepEqual(last('post').passes, []);
});

test('a lookup texture edited in place goes out again with the chain, so Unreal points its pass at the new one', async () => {
  for (let i = 0; i < 300 && x.postState.chain.length < 2; i++) { drawFrame(); x.exportFrame(); await new Promise(r => setTimeout(r, 5)); }
  drawFrame(); x.exportFrame();
  const before = events.length;
  curve.image.data.set([1, 0.5, 0.25, 0]); curve.needsUpdate = true;
  drawFrame(); x.exportFrame();
  const kinds = events.slice(before).map(e => e.kind);
  assert.deepEqual(kinds, ['postTexture', 'post']);
});
