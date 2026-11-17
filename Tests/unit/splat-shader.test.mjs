// The splat stand-in's shader (Runtime/src/splatShader.ts) through the real translator: on an InstancedMesh with
// instance colours and one per-instance float (alpha), it becomes HLSL that reads them from per-instance custom data,
// places its quad with a world position offset, and keeps its discards (the stochastic transparency).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {loadRuntime, moduleThreeUrl} from './load-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wasm = fs.readFileSync(path.join(root, 'Runtime/vendor/cross-shader/CrossShader.wasm'));
globalThis.__dirname ??= path.join(root, 'Runtime/vendor/cross-shader');
globalThis.require ??= createRequire(import.meta.url);
const logs = [];
const host = {log: (level, text) => logs.push(`${level} ${text}`), registry: '', storage: null, shaderPreparation: true,
  readFile: p => p.endsWith('CrossShader.wasm') ? wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) : null};
const shaders = await loadRuntime('shaders.ts', host, moduleThreeUrl);
const {splatMaterial} = await loadRuntime('splatShader.ts', host, moduleThreeUrl);

test('the splat shader translates for an instanced mesh with colours and a per-instance alpha', async () => {
  const m = splatMaterial();
  let t;
  for (let i = 0; i < 400 && t === undefined; i++) {
    shaders.newShaderFrame();
    t = shaders.translateShaderMaterial(m, {color: true, extras: [{name: 'splatAlpha', size: 1, offset: 0}]});
    if (t === undefined) await new Promise(r => setTimeout(r, 25));
  }
  assert.ok(t, logs.join('\n'));
  assert.equal(t.instanced, true);
  assert.ok(t.vertexHlsl.length > 0, 'the quad is placed by a world position offset');
  assert.match(t.hlsl, /discard/, 'the fragment stage keeps its discards');
  const all = [...t.inputs, ...t.vertexInputs];
  assert.ok(all.some(i => i.source === 'instanceColor'), 'colour from per-instance custom data');
  assert.ok(all.some(i => i.source === 'instanceData' && i.index === 3), 'alpha after the colour in per-instance custom data');
  for (const u of ['splatViewport', 'splatOpacity', 'splatTint', 'splatFrame', 'splatLinear']) assert.ok(all.some(i => i.param === u), `uniform ${u}`);
});
