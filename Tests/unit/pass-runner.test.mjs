// Render target passes run when the page reads one back (Runtime/src/passRun.ts), and the view a render target draw
// takes (Runtime/src/viewTake.ts). The page draws a scene into a target, reduces it with a pass whose material it
// reuses for every level, copies the last level into a float target and reads one pixel, as a light meter does. The
// host's side is stood in here by JavaScript copies of the two shaders, working on what the runtime sends: the program
// must name the passes in order, with the uniform values each draw had and the targets each one read.
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
globalThis.require ??= createRequire(import.meta.url); globalThis.__dirname ??= root;

/** The host's runner: scene slots hold value(u, v) at each pixel centre, rows from the bottom; passes run by kind. */
const value = (u, v) => u + 10 * v;
const slots = new Map(), kept = new Map(), shaders = new Map(), seen = {scenes: [], programs: []};
const at = s => s === -1 ? {w: 1, h: 1, data: new Float32Array(4)} : s <= -2 ? kept.get(-2 - s) : slots.get(s);
const texel = (t, u, v) => { const x = Math.min(t.w - 1, Math.max(0, Math.floor(u * t.w))), y = Math.min(t.h - 1, Math.max(0, Math.floor(v * t.h))); return [...t.data.subarray((y * t.w + x) * 4, (y * t.w + x) * 4 + 4)]; };
const kinds = {
  reduce: (u, v, U, T) => [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]].map(([a, b]) => texel(T.source, u + U.texel[0] * a, v + U.texel[1] * b)).reduce((s, c) => s.map((x, k) => x + c[k] / 4), [0, 0, 0, 0]),
  copy: (u, v, U, T) => texel(T.source, u, v),
};
const media = {
  captureView: () => null,
  passScene(f, n, i, ni, slot, w, h, format) {
    seen.scenes.push({slot, w, h, format, camera: [...new Float32Array(f, 0, 16).slice(12, 15)].map(Math.round)});
    const data = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([value((x + 0.5) / w, (y + 0.5) / h), 0, 0, 1], (y * w + x) * 4);
    slots.set(slot, {w, h, data});
    return true;
  },
  passRun(json) {
    const p = JSON.parse(json); seen.programs.push(p);
    for (const id of p.release) kept.delete(id);
    for (const s of p.shaders) shaders.set(s.key, s);
    for (const s of p.slots) slots.set(s.slot, {w: s.width, h: s.height, data: new Float32Array(s.width * s.height * 4)});
    for (const pass of p.passes) {
      const fn = kinds[shaders.get(pass.key).inputs.some(i => i.param === 'texel') ? 'reduce' : 'copy'], out = slots.get(pass.slot), T = {};
      for (const [k, s] of Object.entries(pass.slots)) T[k] = at(s);
      for (let y = 0; y < out.h; y++) for (let x = 0; x < out.w; x++) out.data.set(fn((x + 0.5) / out.w, (y + 0.5) / out.h, pass.vectors, T), (y * out.w + x) * 4);
    }
    const r = p.read, t = at(r.slot), buf = new ArrayBuffer(8 + r.width * r.height * 16);
    new Int32Array(buf, 0, 2).set([r.width, r.height]);
    for (let y = 0; y < r.height; y++) new Float32Array(buf, 8 + y * r.width * 16, r.width * 4).set(t.data.subarray(((r.y + y) * t.w + r.x) * 4, ((r.y + y) * t.w + r.x + r.width) * 4));
    for (const [slot, id] of p.keep) { kept.set(id, slots.get(slot)); slots.delete(slot); }
    return buf;
  },
};
const logs = [], store = new Map();
const host = {log: (level, text) => logs.push(`${level} ${text}`), registry: '', search: '', now: () => 0, shaderPreparation: true, reload() {}, media,
  readFile: p => p.endsWith('CrossShader.wasm') ? wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) : null,
  storage: {load: k => store.get(k) ?? null, save: (k, v) => store.set(k, v)},
  sink: {geometry() {}, releaseGeometry() {}, material() {}, materialUniforms() {}, texture() {}, shader() {}, events() {}, frame() {}}};
globalThis.document ??= {createElement: () => ({style: {}})};
const x = await loadRuntime('../../Tests/unit/pass-runner-fixture.ts', host, moduleThreeUrl);

const canvas = {isConnected: true, width: 640, height: 360, style: {}};
const gl = new x.UnrealRenderer({canvas});
const scene = new THREE.Scene(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
const live = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100); live.position.set(0, 0, 5); live.updateMatrixWorld();
const shot = new THREE.PerspectiveCamera(30, 1, 0.1, 100); shot.position.set(3, 2, 1); shot.updateMatrixWorld();
const VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const reduce = new THREE.ShaderMaterial({vertexShader: VERTEX, uniforms: {source: {value: null}, texel: {value: new THREE.Vector2()}},
  fragmentShader: 'uniform sampler2D source; uniform vec2 texel; varying vec2 vUv; void main() { gl_FragColor = 0.25 * (texture2D(source, vUv + texel * vec2(-0.5, -0.5)) + ' +
    'texture2D(source, vUv + texel * vec2(0.5, -0.5)) + texture2D(source, vUv + texel * vec2(-0.5, 0.5)) + texture2D(source, vUv + texel * vec2(0.5, 0.5))); }'});
const copy = new THREE.ShaderMaterial({vertexShader: VERTEX, uniforms: {source: {value: null}}, fragmentShader: 'uniform sampler2D source; varying vec2 vUv; void main() { gl_FragColor = texture2D(source, vUv); }'});
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); quad.frustumCulled = false;
const quadScene = new THREE.Scene(); quadScene.add(quad);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const target = (size, type = THREE.HalfFloatType) => new THREE.WebGLRenderTarget(size, size, {type, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter});
const input = target(4), levels = [target(2), target(1)], read = target(1, THREE.FloatType);
const draw = (material, into) => { quad.material = material; gl.setRenderTarget(into); gl.render(quadScene, ortho); gl.setRenderTarget(null); };
/** One meter reading, as an export draws it between two live frames: the shot into a target, two reduction levels and a copy, then a one pixel read. */
function meter() {
  gl.setRenderTarget(input); gl.render(scene, shot); gl.setRenderTarget(null);
  let source = input;
  for (const level of levels) { reduce.uniforms.source.value = source.texture; reduce.uniforms.texel.value.set(1 / source.width, 1 / source.height); draw(reduce, level); source = level; }
  copy.uniforms.source.value = source.texture; draw(copy, read);
  const px = new Float32Array(4); gl.readRenderTargetPixels(read, 0, 0, 1, 1, px);
  return px;
}

test('a one pixel read of passes behind a scene runs them in Unreal, each with its own uniform values', async () => {
  x.frameCount.animation++; gl.render(scene, live); x.endFrameView();
  let px = new Float32Array(4);
  for (let i = 0; i < 400 && !px[3]; i++) { x.frameCount.animation++; px = meter(); x.exportFrame(); x.endFrameView(); await new Promise(r => setTimeout(r, 2)); }
  assert.equal(px[3], 1, `the read came back (${x.passRuns.last})`);
  assert.ok(Math.abs(px[0] - 5.5) < 1e-6, `the mean of the scene over every pixel, ${px[0]}`);
  const p = seen.programs.at(-1);
  assert.deepEqual(p.passes.map(q => q.vectors.texel?.slice(0, 2) ?? null), [[0.25, 0.25], [0.5, 0.5], null], 'each level keeps the texel size it was drawn with');
  assert.deepEqual(p.passes.map(q => q.slots.source), [0, 1, 2], 'each pass reads the target the one before it wrote');
  assert.deepEqual(seen.scenes.at(-1), {slot: 0, w: 4, h: 4, format: 1 | 16, camera: [3, 2, 1]}, 'the scene goes out with the camera it was drawn with');
  assert.ok(p.shaders.every(s => !/\bJsgb(P|N|MX|MO|V0|Pr0|Cam)\b/.test(s.hlsl)), 'no mesh inputs are left in a pass material');
  assert.ok(p.shaders.every(s => s.inputs.some(i => i.source === 'uv')), 'the pixel\'s place in the target is the uv');
});

test('the view an export draw took goes back at the end of the frame', () => {
  x.frameCount.animation++; gl.render(scene, live); x.endFrameView();
  x.frameCount.animation++; meter();
  assert.equal(x.lastFrame.camera, shot, 'a perspective draw into a target takes the view while the frame runs');
  assert.equal(x.lastFrame.linear, true);
  x.endFrameView();
  assert.equal(x.lastFrame.camera, live, 'nothing from it reached the screen, so the live view is back');
  assert.equal(x.lastFrame.linear, false);
});

test('a view drawn into a target that a pass shows on the screen stays the view', () => {
  const composer = target(8);
  x.frameCount.animation++; gl.render(scene, live); x.endFrameView();
  x.frameCount.animation++;
  gl.setRenderTarget(composer); gl.render(scene, shot); gl.setRenderTarget(null);
  copy.uniforms.source.value = composer.texture; quad.material = copy; gl.render(quadScene, ortho);
  x.endFrameView();
  assert.equal(x.lastFrame.camera, shot);
  assert.equal(x.lastFrame.linear, true, 'the view is the composer\'s input, as before');
});

test('a read again without a new draw binds the result Unreal kept', () => {
  const runs = seen.programs.length;
  const px = new Float32Array(4); gl.readRenderTargetPixels(read, 0, 0, 1, 1, px);
  assert.equal(seen.programs.length, runs + 1);
  const p = seen.programs.at(-1);
  assert.equal(p.passes.length, 0, 'nothing runs again');
  assert.ok(p.read.slot <= -2, 'the read binds the kept target');
  assert.ok(Math.abs(px[0] - 5.5) < 1e-6);
});

test('a read whose scene was drawn frames ago is left alone, with one line in the log', () => {
  x.frameCount.animation += 5;
  reduce.uniforms.source.value = levels[0].texture; reduce.uniforms.texel.value.set(0.5, 0.5);
  // levels[0] was kept, so this pass runs from it although its scene is old.
  draw(reduce, levels[1]);
  const px = new Float32Array(4); gl.readRenderTargetPixels(levels[1], 0, 0, 1, 1, px);
  assert.ok(Math.abs(px[0] - 5.5) < 1e-6, 'a kept level stands in for its old scene');
  const stale = target(4);
  gl.setRenderTarget(stale); gl.render(scene, shot); gl.setRenderTarget(null);
  x.frameCount.animation += 5;
  reduce.uniforms.source.value = stale.texture; reduce.uniforms.texel.value.set(0.25, 0.25); draw(reduce, levels[0]);
  const none = new Float32Array(4); gl.readRenderTargetPixels(levels[0], 0, 0, 1, 1, none);
  assert.equal(none[3], 0, 'the buffer is as it was');
  assert.equal(logs.filter(l => /drawn in an earlier frame/.test(l)).length, 1);
});
