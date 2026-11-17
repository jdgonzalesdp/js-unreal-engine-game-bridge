// ImageBitmaps copied as a browser copies them: posted to a worker thread with their picture, and createImageBitmap of
// a decoded bitmap or image hands over its pixels (the eyes cut reads a head's colour map back this way).
import test from 'node:test';
import assert from 'node:assert/strict';
import {ImageBitmapImpl} from '../../Runtime/src/canvas2d.ts';
import {encode, decode} from '../../Runtime/src/clone.ts';
import {copyingBitmaps} from '../../Runtime/src/bitmapClone.ts';

function withBitmaps(fn) {
  const had = globalThis.ImageBitmap;
  globalThis.ImageBitmap = ImageBitmapImpl;
  try { return fn(); } finally { if (had === undefined) delete globalThis.ImageBitmap; else globalThis.ImageBitmap = had; }
}

test('a bitmap posted to a worker thread arrives with its pixels', () => withBitmaps(() => {
  const data = new Uint8ClampedArray(2 * 3 * 4).map((_, i) => i * 7);
  const bitmap = new ImageBitmapImpl(2, 3, undefined, undefined, {width: 2, height: 3, data});
  const bytes = encode({id: 4, job: {atlas: bitmap, scale: 2}});
  assert.ok(bytes, 'encodable');
  const got = decode(bytes.buffer).job;
  assert.ok(got.atlas instanceof ImageBitmapImpl);
  assert.equal(got.atlas.width, 2); assert.equal(got.atlas.height, 3);
  assert.deepEqual([...got.atlas.__pixels.data], [...data]);
  assert.equal(got.scale, 2);
}));

test('an encoded bitmap sends only its own bytes, and a file bitmap its path', () => withBitmaps(() => {
  const file = new Uint8Array(1000).fill(9), png = file.subarray(100, 140);
  const encoded = new ImageBitmapImpl(4, 4, undefined, png);
  const bytes = encode(encoded);
  assert.ok(bytes.length < 400, `${bytes.length} bytes: not the whole file`);
  const got = decode(bytes.buffer);
  assert.equal(got.__bytes.length, 40);
  assert.ok(got.__bytes.every(v => v === 9));
  assert.equal(decode(encode(new ImageBitmapImpl(8, 8, '/textures/wood.png')).buffer).__jsgbAsset, '/textures/wood.png');
}));

test('createImageBitmap of a decoded bitmap or image hands over its pixels or bytes; other sources pass through', async () => {
  const calls = [];
  const make = async (source, ...rest) => { calls.push({source, rest}); return source; };
  const copy = copyingBitmaps(make);
  assert.equal(copyingBitmaps(copy), copy, 'installed once');
  const data = new Uint8ClampedArray(16).fill(200);
  await copy(new ImageBitmapImpl(2, 2, '/head.webp', undefined, {width: 2, height: 2, data}), {imageOrientation: 'flipY'});
  assert.deepEqual(calls[0].source, {data, width: 2, height: 2});
  assert.deepEqual(calls[0].rest, [{imageOrientation: 'flipY'}], 'options still reach createImageBitmap');
  const img = {naturalWidth: 2, naturalHeight: 2, __jsgbAsset: '/eye.webp', __pixels: {width: 2, height: 2, data}};
  await copy(img);
  assert.equal(calls[1].source.data, data, 'an <img> the bridge decoded');
  const png = new Uint8Array([1, 2, 3]);
  await copy(new ImageBitmapImpl(1, 1, undefined, png));
  assert.deepEqual(calls[2].source, {bytes: png});
  const blob = {arrayBuffer: async () => new ArrayBuffer(0), __pixels: {width: 1, height: 1, data}};
  const canvas = {getContext() {}, __pixels: {width: 1, height: 1, data}};
  await copy(blob); await copy(canvas);
  assert.equal(calls[3].source, blob); assert.equal(calls[4].source, canvas);
});
