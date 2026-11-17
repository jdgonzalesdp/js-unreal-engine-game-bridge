// troika-three-text (drei's <Text>) glyph quads built on the CPU (Runtime/src/troikaGlyphs.ts) and the bridge's text
// shader (Runtime/src/troikaTextShader.ts) going through the real GLSL to HLSL translator.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {loadRuntime, moduleThreeUrl} from './load-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wasm = fs.readFileSync(path.join(root, 'Runtime/vendor/cross-shader/CrossShader.wasm'));
// The shader compiler's Emscripten loader takes its Node path here and wants these.
globalThis.__dirname ??= path.join(root, 'Runtime/vendor/cross-shader');
globalThis.require ??= createRequire(import.meta.url);
const THREE = await import(moduleThreeUrl);
const logs = [];
const host = {log: (level, text) => logs.push(`${level} ${text}`), registry: '', storage: null, shaderPreparation: true,
  readFile: p => p.endsWith('CrossShader.wasm') ? wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) : null};
const glyphs = await loadRuntime('troikaGlyphs.ts', host, moduleThreeUrl);
const textShader = await loadRuntime('troikaTextShader.ts', host, moduleThreeUrl);
const shaders = await loadRuntime('shaders.ts', host, moduleThreeUrl);

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);
const vec = (m, x, y, z) => new THREE.Vector3(x, y, z).applyMatrix3(m).toArray().map(v => Math.round(v * 1e6) / 1e6 + 0);
const unclipped = [-1e3, -1e3, 1e3, 1e3];
/** Two glyphs as troika's TextBuilder lays them out: bounds [x0, y0, x1, y1] each, and their atlas indices. */
const info = {glyphBounds: new Float32Array([0, -0.02, 0.05, 0.08, 0.06, -0.02, 0.1, 0.06]), glyphAtlasIndices: new Float32Array([3, 9]), glyphColors: null};

test('orientation strings rotate the text plane as troika does', () => {
  assert.deepEqual(glyphs.orientationMatrix('+x+y').elements, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(glyphs.orientationMatrix(undefined).elements, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  // Lying flat, facing up: text +x stays +x, text up is world -z, the face looks along +y.
  const flat = glyphs.orientationMatrix('+x-z');
  assert.deepEqual(vec(flat, 1, 0, 0), [1, 0, 0]);
  assert.deepEqual(vec(flat, 0, 1, 0), [0, 0, -1]);
  assert.deepEqual(vec(flat, 0, 0, 1), [0, 1, 0]);
  // Reading along -z with up +y: the face looks along +x.
  const side = glyphs.orientationMatrix('-z+y');
  assert.deepEqual(vec(side, 1, 0, 0), [0, 0, -1]);
  assert.deepEqual(vec(side, 0, 1, 0), [0, 1, 0]);
  assert.deepEqual(vec(side, 0, 0, 1), [1, 0, 0]);
  // Unknown strings fall back to the identity, as troika's regular expression does.
  assert.deepEqual(glyphs.orientationMatrix('sideways').elements, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

test('size props resolve percentages of the font size', () => {
  assert.equal(glyphs.resolvePercent('10%', 0.2), 0.020000000000000004);
  assert.equal(glyphs.resolvePercent(0.008, 0.2), 0.008);
  assert.equal(glyphs.resolvePercent('wide', 0.2), 0);
  assert.equal(glyphs.resolvePercent(undefined, 0.2), 0);
});

test('one quad per glyph, placed from its bounds with a 0..1 glyph uv and its atlas index', () => {
  const g = glyphs.buildGlyphGeometry(info, {outline: null, clip: unclipped, orient: new THREE.Matrix3(), curveRadius: 0});
  const pos = g.attributes.position, uv = g.attributes.uv, glyph = g.attributes.aJsgbTextGlyph;
  assert.equal(pos.count, 8);
  assert.deepEqual(Array.from(g.index.array), [0, 2, 1, 2, 3, 1, 4, 6, 5, 6, 7, 5]);
  // troika's template corners: (0,1) (1,1) (0,0) (1,0).
  const expected = [[0, 0.08], [0.05, 0.08], [0, -0.02], [0.05, -0.02], [0.06, 0.06], [0.1, 0.06], [0.06, -0.02], [0.1, -0.02]];
  expected.forEach(([x, y], i) => { near(pos.getX(i), x, `x ${i}`); near(pos.getY(i), y, `y ${i}`); near(pos.getZ(i), 0, `z ${i}`); });
  assert.deepEqual(Array.from(uv.array.slice(0, 8)), [0, 1, 1, 1, 0, 0, 1, 0]);
  near(glyph.getX(0), 3, 'atlas index'); near(glyph.getY(0), 0.05, 'width'); near(glyph.getZ(0), 0.1, 'height'); assert.equal(glyph.getW(0), 1);
  near(glyph.getX(4), 9, 'second atlas index');
  assert.deepEqual(Array.from(g.attributes.color.array.slice(0, 3)), [1, 1, 1]);
  assert.deepEqual(Array.from(g.attributes.normal.array.slice(0, 3)), [0, 0, 1]);
});

test('an outline adds widened, shifted quads first, whose glyph uv reaches past 0..1', () => {
  const outline = {width: 0.01, blur: 0.005, offsetX: 0.002, offsetY: 0.003};
  const g = glyphs.buildGlyphGeometry(info, {outline, clip: unclipped, orient: new THREE.Matrix3(), curveRadius: 0});
  const pos = g.attributes.position, uv = g.attributes.uv, glyph = g.attributes.aJsgbTextGlyph;
  assert.equal(pos.count, 16);
  // Outline layer first (layer 0), then the fill layer (1), so fills draw over every outline.
  assert.deepEqual([0, 4, 8, 12].map(i => glyph.getW(i)), [0, 0, 1, 1]);
  // Shifted by the offset (x right, y down) and grown by width + blur on every side.
  const grow = 0.015, x0 = 0.002, y0 = -0.02 - 0.003, x1 = 0.052, y1 = 0.08 - 0.003;
  near(pos.getX(2), x0 - grow, 'left'); near(pos.getY(2), y0 - grow, 'bottom');
  near(pos.getX(1), x1 + grow, 'right'); near(pos.getY(1), y1 + grow, 'top');
  near(uv.getX(2), -grow / 0.05, 'uv left'); near(uv.getY(2), -grow / 0.1, 'uv bottom');
  near(uv.getX(1), 1 + grow / 0.05, 'uv right'); near(uv.getY(1), 1 + grow / 0.1, 'uv top');
  // The fill quads keep the glyph's own bounds.
  near(pos.getX(10), 0, 'fill left'); near(pos.getY(9), 0.08, 'fill top');
  assert.deepEqual(Array.from(uv.array.slice(16, 24)), [0, 1, 1, 1, 0, 0, 1, 0]);
});

test('the clip rect trims quads and their uv, and the orientation turns them', () => {
  const flat = glyphs.orientationMatrix('+x-z');
  const g = glyphs.buildGlyphGeometry(info, {outline: null, clip: [0.02, -1, 1, 0.03], orient: flat, curveRadius: 0});
  const pos = g.attributes.position, uv = g.attributes.uv;
  // First glyph: x 0..0.05 clipped to 0.02..0.05, y -0.02..0.08 clipped to -0.02..0.03; text y becomes world -z.
  near(pos.getX(0), 0.02, 'clipped left'); near(pos.getZ(0), -0.03, 'clipped top'); near(pos.getY(0), 0, 'flat');
  near(uv.getX(0), 0.4, 'uv x'); near(uv.getY(0), 0.5, 'uv y');
  assert.deepEqual(Array.from(g.attributes.normal.array.slice(0, 3)).map(v => Math.round(v)), [0, 1, 0]);
});

test('glyph colours from colorRanges go to the fill quads only', () => {
  const colored = {...info, glyphColors: new Uint8Array([255, 0, 0, 0, 255, 0])};
  const g = glyphs.buildGlyphGeometry(colored, {outline: {width: 0.01, blur: 0, offsetX: 0, offsetY: 0}, clip: unclipped, orient: new THREE.Matrix3(), curveRadius: 0});
  const c = g.attributes.color;
  assert.deepEqual([c.getX(0), c.getY(0), c.getZ(0)], [1, 1, 1]);
  assert.deepEqual([c.getX(8), c.getY(8), c.getZ(8)], [1, 0, 0]);
  assert.deepEqual([c.getX(12), c.getY(12), c.getZ(12)], [0, 1, 0]);
});

test('the text shader translates, keeps the standard transform (no world position offset) and uses derivatives', async () => {
  const m = textShader.createTextMaterial();
  let t;
  for (let i = 0; i < 400 && t === undefined; i++) {
    shaders.newShaderFrame(); // one translation is allowed per frame, as the frame pump resets it
    t = shaders.translateShaderMaterial(m);
    if (t === undefined) await new Promise(r => setTimeout(r, 25));
  }
  assert.ok(t, logs.join('\n'));
  assert.equal(t.vertexHlsl, '', 'Unreal draws the quads where they are');
  assert.match(t.hlsl, /fwidth\(/);
  assert.match(t.hlsl, /discard;/);
  assert.match(t.hlsl, /uJsgbSdf\.SampleLevel\(uJsgbSdfSampler, jsgbFlipUV\(/);
  assert.ok(t.inputs.some(i => i.source === 'texture' && i.param === 'uJsgbSdf'));
  assert.ok(t.inputs.some(i => i.name === 'JsgbC' && i.source === 'vertexColor'));
  // The glyph attribute arrives in two UV channels; no matrix uniform is needed.
  assert.deepEqual(t.inputs.filter(i => /^JsgbT\d$/.test(i.name)).map(i => i.source), ['uv', 'uv']);
  assert.match(t.hlsl, /vs\.aJsgbTextGlyph = float4\(JsgbT\d\.xy, JsgbT\d\.xy\);/);
  assert.ok(!t.inputs.some(i => /Orient/.test(i.name)));
});
