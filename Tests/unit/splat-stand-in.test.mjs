// Gaussian splats drawn by Spark reach Unreal as instanced stand-ins (Runtime/src/splatStandIn.ts): one instance per
// splat whose frame holds its covariance, with its colour and alpha, placed by the splat's own world matrix. The Spark
// renderer itself is never drawn or run in the mirror. Before, it was drawn as a mesh whose shader could not place
// anything, and a placed .ply showed only its box.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime, moduleThreeUrl} from './load-runtime.mjs';

const THREE = await import(moduleThreeUrl);

async function exporter() {
  const rec = {logs: [], materials: new Map(), shaders: new Map(), frame: null, inst: null, requests: []};
  const bg = {onmessage: null, onerror: null, postMessage: m => rec.requests.push(m), terminate() {}};
  const host = {log: (level, text) => rec.logs.push(`${level} ${text}`), registry: '', search: '', now: () => 0, readFile: () => null,
    storage: {load: () => null, save() {}}, backgroundWorker: () => bg,
    sink: {
      geometry() {}, releaseGeometry() {}, material: (id, json) => rec.materials.set(id, JSON.parse(json)), materialUniforms() {}, texture() {},
      shader: (key, json) => rec.shaders.set(key, JSON.parse(json)),
      frame: (floats, count, inst, ni) => { rec.frame = new Float32Array(floats, 0, count).slice(); rec.inst = new Float32Array(inst, 0, ni).slice(); },
    }};
  const x = await loadRuntime('../../Tests/unit/splat-export-fixture.ts', host, moduleThreeUrl);
  const answer = () => { for (const r of rec.requests.splice(0)) bg.onmessage({data: {key: r.key, result: {key: r.key, hlsl: 'ready', inputs: [], vertexHlsl: 'moved', vertexInputs: [], instanced: true}, ms: 1}}); };
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  const frame = scene => { x.lastFrame.scene = scene; x.lastFrame.camera = camera; x.exportFrame(); return rec.frame.length > x.HEADER_FLOATS ? rec.frame[x.HEADER_FLOATS] : 0; };
  return {x, rec, frame, answer};
}

/** What Spark's PackedSplats hands forEachSplat, for splats given as plain records. */
function packed(splats) {
  return {numSplats: splats.length, packedArray: new Uint32Array(splats.length * 4),
    forEachSplat(cb) { splats.forEach((s, i) => cb(i, new THREE.Vector3(...s.at), new THREE.Vector3(...s.scale), new THREE.Quaternion(...s.q), s.alpha, new THREE.Color(...s.rgb))); }};
}
/** A Spark renderer: a Mesh on instanced geometry that gathers the scene's splats. Running it would be a mistake here. */
function sparkRenderer() {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setAttribute('splatIndex', new THREE.InstancedBufferAttribute(new Uint32Array(4), 1));
  const r = new THREE.Mesh(geo, new THREE.ShaderMaterial({vertexShader: 'void main() { gl_Position = vec4(0.0); }', fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }'}));
  r.ran = 0;
  r.onBeforeRender = () => { r.ran++; };
  r.compileScene = scene => { const all = []; scene.traverseVisible(n => { if (n.packedSplats) all.push(n); }); return {generators: all, visibleGenerators: all}; };
  return r;
}
const splats = [
  {at: [0, 1, 0], scale: [0.1, 0.02, 0.05], q: [0, 0, 0, 1], alpha: 0.8, rgb: [1, 0, 0]},
  {at: [2, 0, -1], scale: [0.01, 0.3, 0.001], q: [0.2, 0.4, -0.1, 0.89], alpha: 0.5, rgb: [0.2, 0.6, 1]},
];

test('a splat frame is the splat covariance with its axes longest first and right-handed', async () => {
  const {x} = await exporter();
  for (const s of splats) {
    const out = new Float32Array(16);
    x.splatFrame(new THREE.Vector3(...s.at), new THREE.Vector3(...s.scale), new THREE.Quaternion(...s.q).normalize(), out, 0);
    const m = new THREE.Matrix4().fromArray(out), a = new THREE.Matrix3().setFromMatrix4(m);
    const r = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(...s.q).normalize()));
    const floor = Math.max(...s.scale) * 1e-3, d = new THREE.Matrix3().set(...[0, 1, 2].flatMap(i => [0, 1, 2].map(j => i === j ? Math.max(s.scale[i], floor) ** 2 : 0)));
    const want = r.clone().multiply(d).multiply(r.clone().transpose()), got = a.clone().multiply(a.clone().transpose());
    want.elements.forEach((v, i) => assert.ok(Math.abs(v - got.elements[i]) < 1e-6, `covariance ${i}: ${got.elements[i]} vs ${v}`));
    assert.ok(a.determinant() > 0, 'right-handed');
    const len = c => Math.hypot(out[c * 4], out[c * 4 + 1], out[c * 4 + 2]);
    assert.ok(len(0) >= len(1) && len(1) >= len(2), 'longest first');
    assert.deepEqual([out[12], out[13], out[14]].map(v => +v.toFixed(5)), s.at);
  }
});

test('a Spark renderer is drawn as its splats, one instance each, and never run', async () => {
  const {x, rec, frame, answer} = await exporter();
  const scene = new THREE.Scene(), spark = sparkRenderer(), splat = new THREE.Object3D();
  splat.packedSplats = packed(splats); splat.opacity = 0.5; splat.position.set(3, 0, 0); splat.quaternion.set(1, 0, 0, 0);
  scene.add(spark, splat); scene.updateMatrixWorld();
  assert.equal(x.isSplatRenderer(spark), true);
  assert.equal(x.isSplatRenderer(new THREE.Mesh(new THREE.BoxGeometry())), false);
  assert.equal(frame(scene), 0, 'nothing while the splat shader translates');
  answer();
  assert.equal(frame(scene), x.INSTANCED);
  assert.equal(spark.ran, 0, 'the Spark renderer is never run in the mirror');
  const f = rec.frame, h = x.HEADER_FLOATS;
  assert.equal(f[h + 5], 2, 'one instance per splat');
  assert.deepEqual(Array.from(f.slice(h + 6, h + 22)), Array.from(splat.matrixWorld.elements).map(Math.fround), 'placed by the splat');
  assert.equal(f[h + 22], 1, 'the instances are sent');
  assert.equal(f[h + 23], 1 + 2, 'colours, and one extra float (alpha) per instance');
  const inst = rec.inst, at = f[h + 24];
  assert.deepEqual(Array.from(inst.slice(at + 32, at + 38)).map(v => +v.toFixed(3)), [1, 0, 0, 0.2, 0.6, 1], 'colours');
  assert.deepEqual(Array.from(inst.slice(at + 38, at + 40)), [0.8, 0.5].map(Math.fround), 'alphas');
  const mat = [...rec.materials.values()].find(m => m.name === 'jsgb-splats');
  assert.ok(mat, 'the splat material is described');
  assert.equal(mat.uniforms.splatOpacity, 0.5);
  assert.ok(!rec.logs.some(l => /^warn/.test(l)), rec.logs.join('\n'));
  // A still splat sends its matrix again but not its instances.
  frame(scene);
  assert.equal(rec.frame[h + 22], 0);
});

test('a hidden Spark renderer draws no splats, and splats without data are skipped', async () => {
  const {x, frame, answer} = await exporter();
  const scene = new THREE.Scene(), spark = sparkRenderer(), splat = new THREE.Object3D();
  splat.packedSplats = {numSplats: 0, packedArray: null, forEachSplat() {}};
  scene.add(spark, splat);
  assert.equal(x.packedSplatsOf(splat), null);
  frame(scene); answer();
  assert.equal(frame(scene), 0, 'a splat still loading draws nothing');
  splat.packedSplats = packed(splats);
  frame(scene); answer();
  assert.equal(frame(scene), x.INSTANCED, 'it draws once its data arrives');
  spark.visible = false;
  assert.equal(frame(scene), 0, 'hidden (PrepViz plan view): no splats');
});

test('splats back after a long absence send their instances again, as Unreal has dropped them', async () => {
  const {x, rec, frame, answer} = await exporter();
  const scene = new THREE.Scene(), spark = sparkRenderer(), splat = new THREE.Object3D();
  splat.packedSplats = packed(splats);
  scene.add(spark, splat);
  frame(scene); answer(); frame(scene);
  const h = x.HEADER_FLOATS;
  frame(scene);
  assert.equal(rec.frame[h + 22], 0, 'a still splat keeps its instances');
  spark.visible = false;
  for (let i = 0; i < 20; i++) frame(scene);
  spark.visible = true;
  frame(scene);
  assert.equal(rec.frame[h + 22], 0, 'a short absence: Unreal only hid them');
  spark.visible = false;
  for (let i = 0; i < 400; i++) frame(scene);
  spark.visible = true;
  frame(scene);
  assert.equal(rec.frame[h + 22], 1, 'a long absence: sent again');
});
