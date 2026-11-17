// Extra vertex attributes travel in UV channels (Runtime/src/attributes.ts). The bridge's own text attribute keeps a
// fixed channel: the main thread and the shader worker each hand channels out in their own order, and a translation
// stored on disk must keep reading the channels the mesh was written with.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from './load-runtime.mjs';

test('the text glyph attribute keeps channels 6-7 whatever the game used first', async () => {
  const a = await loadRuntime('attributes.ts');
  assert.deepEqual(a.channelFor('buildingInteriorFace', 1), {channel: 1, size: 1});
  assert.deepEqual(a.channelFor('aJsgbTextGlyph', 4), {channel: 6, size: 4});
  const fresh = await loadRuntime('attributes.ts');
  assert.deepEqual(fresh.channelFor('aJsgbTextGlyph', 4), {channel: 6, size: 4});
});

test('game attributes still get channels in order of first sight', async () => {
  const a = await loadRuntime('attributes.ts');
  assert.deepEqual(a.channelFor('aTwo', 2), {channel: 1, size: 2});
  assert.deepEqual(a.channelFor('aFour', 4), {channel: 2, size: 4});
  assert.deepEqual(a.channelFor('aTwo', 2), {channel: 1, size: 2});
});
