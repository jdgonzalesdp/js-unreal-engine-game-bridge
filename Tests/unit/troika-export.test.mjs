// What the scene exporter sends for draws whose vertices only a translated shader can place: a plain Mesh on an
// InstancedBufferGeometry (Runtime/src/shaderGuard.ts) and troika-three-text labels (Runtime/src/troikaText.ts).
// Before, both went out with the generic material: troika labels showed as solid 1 m squares in the outline colour.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime, moduleThreeUrl} from './load-runtime.mjs';

const THREE = await import(moduleThreeUrl);

/** A fresh exporter with a recording sink. worker: a background shader compiler that answers when told to; without
 *  one, every translation fails (an old host), as the Node smoke run sees it. */
async function exporter({worker = false} = {}) {
  const rec = {logs: [], materials: new Map(), geometries: new Map(), textures: new Map(), shaders: new Map(), frame: null, requests: []};
  const bg = {onmessage: null, onerror: null, postMessage: m => rec.requests.push(m), terminate() {}};
  const host = {log: (level, text) => rec.logs.push(`${level} ${text}`), registry: '', search: '', now: () => 0, readFile: () => null,
    storage: {load: () => null, save() {}}, ...(worker ? {backgroundWorker: () => bg} : {}),
    sink: {
      geometry: (id, pos, nrm, uv, col, cs, idx, groups) => rec.geometries.set(id, {vertices: pos.byteLength / 12, groups: JSON.parse(groups)}),
      releaseGeometry() {}, material: (id, json) => rec.materials.set(id, JSON.parse(json)), materialUniforms() {},
      texture: (id, json) => rec.textures.set(id, JSON.parse(json)), shader: (key, json) => rec.shaders.set(key, JSON.parse(json)),
      frame: (floats, count) => { rec.frame = new Float32Array(floats, 0, count).slice(); },
    }};
  const x = await loadRuntime('../../Tests/unit/scene-export-fixture.ts', host, moduleThreeUrl);
  /** Answers every pending translation request with a finished (stand-in) translation. */
  const answer = () => { for (const r of rec.requests.splice(0)) bg.onmessage({data: {key: r.key, result: {key: r.key, hlsl: 'ready', inputs: [], vertexHlsl: '', vertexInputs: []}, ms: 1}}); };
  /** Exports one frame of `scene` and returns its records' kinds after the header. */
  const frame = scene => {
    x.lastFrame.scene = scene; x.lastFrame.camera = camera;
    x.exportFrame();
    return rec.frame.length > x.HEADER_FLOATS ? rec.frame[x.HEADER_FLOATS] : 0;
  };
  return {x, rec, frame, answer};
}
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);

/** Sprites placed by their vertex shader from a per-instance offset. */
function placedSprites() {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geo.setAttribute('offset', new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 0, 5, 0, 0]), 3));
  geo.instanceCount = 2;
  const mat = new THREE.ShaderMaterial({vertexShader: 'attribute vec3 offset; void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position + offset, 1.0); }',
    fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }'});
  const scene = new THREE.Scene(); scene.add(new THREE.Mesh(geo, mat));
  return scene;
}

test('instanced geometry whose shader failed to translate stays hidden, with one warning', async () => {
  const {rec, frame} = await exporter();
  const scene = placedSprites();
  assert.equal(frame(scene), 0);
  assert.equal(frame(scene), 0);
  const warnings = rec.logs.filter(l => /stays hidden/.test(l));
  assert.equal(warnings.length, 1, rec.logs.join('\n'));
  assert.match(warnings[0], /^warn instanced geometry with ShaderMaterial stays hidden: its shader could not be translated/);
});

test('instanced geometry waits for its shader, then draws as before', async () => {
  const {x, rec, frame, answer} = await exporter({worker: true});
  const scene = placedSprites();
  assert.equal(frame(scene), 0, 'nothing while the shader translates');
  answer();
  assert.equal(frame(scene), x.INSTANCED);
  assert.equal(rec.logs.filter(l => /stays hidden/.test(l)).length, 0);
});

/** A drei <Text> as troika builds it: an InstancedBufferGeometry of its template quad with per-glyph attributes,
 *  [outline, fill] derived MeshBasicMaterials, and the layout in textRenderInfo. */
function label() {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 1, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0], 3));
  geo.setIndex([0, 2, 1, 2, 3, 1]);
  const bounds = new Float32Array([0, -0.02, 0.05, 0.08, 0.06, -0.02, 0.1, 0.06]), atlas = new Float32Array([0, 5]);
  geo.setAttribute('aTroikaGlyphBounds', new THREE.InstancedBufferAttribute(bounds, 4));
  geo.setAttribute('aTroikaGlyphIndex', new THREE.InstancedBufferAttribute(atlas, 1));
  geo.instanceCount = 2;
  const base = new THREE.MeshBasicMaterial({color: 0xffffff, transparent: true, side: THREE.DoubleSide});
  const fill = base.clone(); fill.isTroikaTextMaterial = true; fill.baseMaterial = base; fill.onBeforeCompile = () => {};
  const outline = Object.create(fill); outline.isTextOutlineMaterial = true;
  const text = new THREE.Mesh(geo, [outline, fill]);
  const sdfTexture = new THREE.Texture({width: 256, height: 64, data: new Uint8Array(256 * 64 * 4)});
  const info = {glyphBounds: bounds, glyphAtlasIndices: atlas, glyphColors: null, sdfTexture, sdfGlyphSize: 64, sdfExponent: 9, blockBounds: [0, -0.02, 0.1, 0.08]};
  Object.defineProperty(text, 'textRenderInfo', {get: () => info, configurable: true});
  Object.assign(text, {fontSize: 0.1, color: 0xffffff, outlineWidth: '10%', outlineColor: 0x000000, orientation: '+x-z'});
  text.position.set(1, 0.5, -2);
  const scene = new THREE.Scene(); scene.add(text);
  return {scene, text};
}

test('a troika label is drawn as one plain mesh of glyph quads with the bridge text shader', async () => {
  const {x, rec, frame, answer} = await exporter({worker: true});
  const {scene, text} = label();
  assert.equal(frame(scene), 0, 'held back while the text shader translates, never drawn as bare quads');
  assert.equal(x.textStats.hidden, 1);
  answer();
  assert.equal(frame(scene), x.MESH);
  const f = rec.frame, at = x.HEADER_FLOATS;
  const [gid, materials, mid] = [f[at + 2], f[at + 4], f[at + 5]];
  assert.equal(materials, 1);
  assert.deepEqual(Array.from(f.slice(at + 6, at + 22)), Array.from(new Float32Array(text.matrixWorld.elements)));
  // Two glyphs, outline and fill: four quads. The glyph attribute takes two UV channels after UV 0.
  const geometry = rec.geometries.get(gid);
  assert.equal(geometry.vertices, 16);
  assert.equal(geometry.groups.uvChannels, 8);
  const m = rec.materials.get(mid);
  assert.equal(m.name, 'JsgbTroikaText');
  assert.equal(m.type, 'ShaderMaterial');
  assert.ok(m.custom && rec.shaders.has(m.custom), 'drawn with the translated text shader, not the generic material');
  assert.equal(m.transparent, true);
  assert.equal(m.side, THREE.DoubleSide);
  assert.ok(Math.abs(m.uniforms.uJsgbOutlineWidth - 0.01) < 1e-9, 'outlineWidth 10% of fontSize 0.1');
  assert.deepEqual(m.uniforms.uJsgbSdfSize, [256, 64]);
  // The atlas is distance data: sent as linear (not sRGB) and flipped as three uploads it.
  const atlas = rec.textures.get(m.uniforms.uJsgbSdf?.tex);
  assert.equal(atlas?.srgb, false);
  assert.equal(atlas?.flipY, true);
  assert.deepEqual(m.uniforms.uJsgbFillColor, [1, 1, 1]);
  assert.deepEqual(m.uniforms.uJsgbOutlineColor, [0, 0, 0]);
  // No INSTANCED record and no generic stand-in for the troika geometry itself.
  assert.ok(![...rec.materials.values()].some(d => d.type === 'MeshBasicMaterial'));
  // The geometry is built once; later frames only follow the label.
  text.position.x = 3;
  assert.equal(frame(scene), x.MESH);
  assert.equal(rec.frame[at + 6 + 12], 3);
  assert.equal(x.textStats.builds, 1);
  text.outlineWidth = 0;
  frame(scene);
  assert.equal(x.textStats.builds, 2);
  assert.equal(rec.geometries.get(rec.frame[at + 2]).vertices, 8, 'no outline: fill quads only');
});

test('a troika label whose text shader cannot be translated stays hidden instead of drawing squares', async () => {
  const {rec, frame} = await exporter();
  const {scene} = label();
  assert.equal(frame(scene), 0);
  assert.equal(rec.logs.filter(l => /^warn troika text with ShaderMaterial "JsgbTroikaText" stays hidden/.test(l)).length, 1, rec.logs.join('\n'));
  assert.ok(![...rec.materials.values()].some(d => d.type === 'MeshBasicMaterial'));
});

test('a label with no layout yet draws nothing', async () => {
  const {rec, frame} = await exporter({worker: true});
  const {scene, text} = label();
  Object.defineProperty(text, 'textRenderInfo', {get: () => null});
  assert.equal(frame(scene), 0);
  assert.equal(rec.materials.size, 0);
});
