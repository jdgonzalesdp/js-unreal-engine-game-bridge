// The export services a page uses to render and save (Runtime/src/readback.ts, canvasRead.ts, imageEncode.ts,
// webcodecs.ts, download.ts), against a stub host that records what the Unreal host would be asked. Before, a render
// target read gave zeros, canvas.toBlob gave a BMP under any type, VideoEncoder and showSaveFilePicker were missing,
// and a download link did nothing: PrepViz's renders came out black and its exports never reached a file.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const esbuild = await import(pathToFileURL(path.join(root, 'Runtime/node_modules/esbuild/lib/main.js')).href);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgb-media-'));
process.on('exit', () => fs.rmSync(out, {recursive: true, force: true}));
const bundle = path.join(out, 'media.mjs');
await esbuild.build({entryPoints: [path.join(root, 'Tests/unit/media-page-fixture.ts')], outfile: bundle, bundle: true, format: 'esm', platform: 'node',
  logLevel: 'warning', alias: {'three-real': 'three'}, nodePaths: [path.join(root, 'Runtime/node_modules')]});

const WEB = ['URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'structuredClone', 'Blob', 'fetch', 'Response', 'Headers', 'Request', 'navigator',
  'Event', 'EventTarget', 'CustomEvent', 'MessageEvent', 'DOMException', 'crypto', 'localStorage', 'sessionStorage', 'location', 'history', 'document'];
for (const k of WEB) try { delete globalThis[k]; } catch { /* not deletable */ }

/** The stub host: captureView answers a picture whose top half is red and bottom half blue, and records each ask. */
const seen = {captures: [], encodes: [], saves: [], downloads: [], video: []};
let pickAnswer = '';
const media = {
  captureView(floats, count, inst, instCount, w, h, float) {
    seen.captures.push({header: new Float32Array(floats, 0, count).slice(0, 22), w, h, float});
    const px = float ? new Float32Array(w * h * 4) : new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4, top = y < h / 2; px[o] = top ? (float ? 1 : 255) : 0; px[o + 2] = top ? 0 : (float ? 1 : 255); px[o + 3] = float ? 1 : 255; }
    const buf = new ArrayBuffer(8 + px.byteLength); new Int32Array(buf, 0, 2).set([w, h]); new Uint8Array(buf, 8).set(new Uint8Array(px.buffer)); return buf;
  },
  savePick: (name, types) => { seen.saves.push({name, types}); return 7; },
  saveTake: () => pickAnswer,
  saveWrite: (id, bytes) => { seen.saves.push({id, bytes: new Uint8Array(bytes).slice()}); return true; },
  download: (name, bytes) => { seen.downloads.push({name, bytes: new Uint8Array(bytes).slice()}); return name; },
  videoSupported: () => true,
  videoOpen: json => { seen.video.push(JSON.parse(json)); return 3; },
  videoEncode: (id, rgba, w, h, ts, dur, key) => { seen.video.push({w, h, ts, dur, key, bytes: rgba.byteLength}); return true; },
  videoTake: () => {
    const frames = seen.video.filter(v => v.bytes && !v.taken);
    const buf = new ArrayBuffer(8 + 8 + frames.length * 32), dv = new DataView(buf);
    dv.setInt32(0, 4, true); new Uint8Array(buf, 8, 4).set([1, 100, 0, 40]);
    frames.forEach((f, i) => { const o = 16 + i * 32; f.taken = true; dv.setInt32(o, f.key ? 1 : 0, true); dv.setInt32(o + 4, 5, true); dv.setFloat64(o + 8, f.ts, true); dv.setFloat64(o + 16, f.dur, true); });
    return buf;
  },
  videoFlush: () => true, videoClose() {},
};
const frames = [];
globalThis.__jsgbHost = {search: '', registry: '', now: () => performance.now(), readFile: () => null, log() {}, reload() {}, storage: {load: () => null, save() {}},
  sink: {geometry() {}, releaseGeometry() {}, material() {}, materialUniforms() {}, texture() {}, shader() {}, events() {}, frame: (f, n) => frames.push(n)}, media};
const page = await import(pathToFileURL(bundle).href);
const {THREE} = page;
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

/** A renderer whose canvas sits in the page; the largest such canvas is the game view (renderer.ts). */
function view(size = 64) {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const gl = new page.UnrealRenderer({canvas}); gl.setSize(size, size);
  const scene = new THREE.Scene(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
  const live = new THREE.PerspectiveCamera(50, 1, 0.1, 100); live.position.set(0, 0, 5);
  const shot = new THREE.PerspectiveCamera(30, 1, 0.1, 100); shot.position.set(3, 2, 1); shot.updateMatrixWorld();
  return {canvas, gl, scene, live, shot};
}

test('an export finds the float readback it checks for', () => {
  assert.equal(view().gl.extensions.has('EXT_color_buffer_float'), true);
});

test('a render target read gets Unreal\'s picture of the scene from the camera drawn there, bottom row first', () => {
  const {gl, scene, live, shot} = view(256);
  gl.render(scene, live);
  assert.equal(page.lastFrame.camera, live);
  const rt = new THREE.WebGLRenderTarget(40, 40);
  gl.setRenderTarget(rt); gl.render(scene, shot); gl.setRenderTarget(null);
  const px = new Uint8Array(40 * 40 * 4);
  gl.readRenderTargetPixels(rt, 0, 0, 40, 40, px);
  const c = seen.captures.at(-1);
  assert.deepEqual([c.w, c.h, c.float], [40, 40, false]);
  assert.deepEqual([...c.header.slice(12, 15)].map(v => Math.round(v)), [3, 2, 1], 'the frame goes out with the export camera');
  assert.deepEqual([px[0], px[2]], [0, 255], 'bottom row (blue) first');
  assert.deepEqual([px[(39 * 40) * 4], px[(39 * 40) * 4 + 2]], [255, 0]);
  assert.equal(page.lastFrame.camera, live, 'the game view is back after the read');
});

test('a pass chain reads the scene its first pass drew; small meter reads are left alone', () => {
  const {gl, scene, shot} = view();
  const a = new THREE.WebGLRenderTarget(64, 64), b = new THREE.WebGLRenderTarget(64, 64);
  gl.setRenderTarget(a); gl.render(scene, shot);
  const pass = new THREE.Scene(); pass.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({uniforms: {source: {value: a.texture}}})));
  gl.setRenderTarget(b); gl.render(pass, new THREE.Camera()); gl.setRenderTarget(null);
  const before = seen.captures.length;
  gl.readRenderTargetPixels(b, 0, 0, 1, 1, new Uint8Array(4));
  assert.equal(seen.captures.length, before, 'a 1 pixel read does not draw a picture');
  const floats = new Float32Array(64 * 64 * 4);
  gl.readRenderTargetPixels(b, 0, 0, 64, 64, floats);
  assert.equal(seen.captures.length, before + 1);
  assert.equal(seen.captures.at(-1).float, true);
  assert.deepEqual([...seen.captures.at(-1).header.slice(12, 15)].map(v => Math.round(v)), [3, 2, 1]);
  assert.equal(floats[2], 1);
});

test('a renderer canvas reads as Unreal\'s picture and has no 2D context; toDataURL writes PNG and JPEG', () => {
  const {canvas, gl, scene, live} = view();
  gl.render(scene, live);
  assert.equal(canvas.getContext('2d'), null);
  const png = canvas.toDataURL('image/png');
  assert.match(png, /^data:image\/png;base64,/);
  const decoded = page.decodePng(Uint8Array.from(atob(png.split(',')[1]), ch => ch.charCodeAt(0)));
  assert.deepEqual([decoded.width, decoded.height, decoded.data[0], decoded.data[2]], [64, 64, 255, 0], 'top row red');
  const copy = document.createElement('canvas'); copy.width = 64; copy.height = 64;
  const ctx = copy.getContext('2d'); ctx.drawImage(canvas, 0, 0);
  assert.deepEqual([...ctx.getImageData(0, 63, 1, 1).data.slice(0, 3)], [0, 0, 255], 'drawImage of the WebGL canvas');
  const jpg = copy.toDataURL('image/jpeg', 0.9);
  assert.match(jpg, /^data:image\/jpeg;base64,\/9j\//);
});

test('VideoEncoder offers H.264 only and hands out chunks with the avcC description first', async () => {
  assert.equal((await VideoEncoder.isConfigSupported({codec: 'hev1.1.6.L153.B0', width: 64, height: 64})).supported, false);
  assert.equal((await VideoEncoder.isConfigSupported({codec: 'avc1.640033', width: 64, height: 64})).supported, true);
  const chunks = [];
  const enc = new VideoEncoder({output: (chunk, meta) => chunks.push({chunk, meta}), error: e => { throw e; }});
  enc.configure({codec: 'avc1.640033', width: 64, height: 64, bitrate: 1e6, framerate: 24});
  const bitmap = await createImageBitmap(new ImageData(64, 64));
  for (let i = 0; i < 2; i++) { const f = new VideoFrame(bitmap, {timestamp: i * 41667, duration: 41667}); enc.encode(f, {keyFrame: i === 0}); f.close(); }
  await enc.flush();
  enc.close();
  assert.deepEqual(chunks.map(c => c.chunk.type), ['key', 'delta']);
  assert.deepEqual([...new Uint8Array(chunks[0].meta.decoderConfig.description)], [1, 100, 0, 40]);
  assert.equal(chunks[1].chunk.timestamp, 41667);
  assert.equal(chunks[0].chunk.byteLength, 5);
});

test('showSaveFilePicker writes the chosen file; a download link writes into Downloads', async () => {
  pickAnswer = '';
  const picked = showSaveFilePicker({suggestedName: 'shot.mp4'});
  await tick(10); pickAnswer = 'ok:shot.mp4';
  const handle = await picked;
  assert.equal(handle.name, 'shot.mp4');
  const w = await handle.createWritable(); await w.write(new Blob([new Uint8Array([1, 2, 3])])); await w.close();
  assert.deepEqual([...seen.saves.at(-1).bytes], [1, 2, 3]);
  pickAnswer = 'cancel';
  await assert.rejects(showSaveFilePicker({suggestedName: 'x'}), e => e.name === 'AbortError');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([new Uint8Array([9, 8])])); a.download = 'frame.png';
  a.click(); await tick(5);
  assert.deepEqual(seen.downloads.at(-1), {name: 'frame.png', bytes: new Uint8Array([9, 8])});
});

test('PNG and JPEG encoders round-trip', () => {
  const p = {width: 3, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])};
  assert.deepEqual([...page.decodePng(page.encodePng(p)).data], [...p.data]);
  const j = page.encodeJpeg({width: 8, height: 8, data: new Uint8ClampedArray(256).fill(200)}, 0.9);
  assert.deepEqual([j[0], j[1], j.at(-2), j.at(-1)], [0xff, 0xd8, 0xff, 0xd9]);
});
