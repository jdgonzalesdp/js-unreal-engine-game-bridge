// <input type=file> and the File System Access pickers (Runtime/src/filePicker.ts, fileApi.ts, fileHandles.ts) over a
// stand-in for the host's open panel: what opens the panel, what it is asked for, the files and events a page gets, and
// bytes that are read from the host only when the page reads them.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bootPage, tick} from './browser-page.mjs';
import {fileHost, settle} from './file-host.mjs';

const g = globalThis;
const fileInput = (attrs = {}) => {
  const input = g.document.createElement('input');
  input.type = 'file';
  for (const [k, v] of Object.entries(attrs)) input[k] = v;
  g.document.body.appendChild(input);
  return input;
};
const events = (el, types) => { const log = []; for (const t of types) g.document.addEventListener(t, e => { if (e.target === el) log.push(t); }); return log; };

test('input.click() opens the panel and fills input.files, then input and change fire', async () => {
  const f = fileHost({'chair.glb': 'glTF-chair-bytes', 'chair.mtl': 'newmtl wood'});
  await bootPage(f.host);
  const input = fileInput({accept: '.glb,.gltf,image/png', multiple: true});
  const log = events(input, ['input', 'change', 'cancel']);
  f.choose(['chair.glb', 'chair.mtl']);
  input.click();
  await settle();
  assert.deepEqual(f.seen.opens, [{multiple: true, directory: false, expand: false, extensions: ['glb', 'gltf', 'png']}]);
  assert.deepEqual(log, ['input', 'change']);
  const [glb, mtl] = input.files;
  assert.equal(input.files.length, 2);
  assert.ok(glb instanceof g.File && glb instanceof g.Blob, 'a real File, which is a Blob');
  assert.deepEqual([glb.name, glb.size, glb.type, mtl.type, glb.webkitRelativePath], ['chair.glb', 16, 'model/gltf-binary', '', '']);
  assert.ok(glb.lastModified > 1.7e12);
  assert.equal(input.value, 'C:\\fakepath\\chair.glb');
  assert.equal(input.files.item(1), mtl);
  assert.equal(input.files, input.files, 'the same FileList until the choice changes');
  assert.equal(f.seen.reads.length, 0, 'nothing is read until the page reads it');
  assert.equal(await glb.slice(0, 4).text(), 'glTF');
  assert.equal(await glb.slice(-5).text(), 'bytes');
  assert.deepEqual(f.seen.reads.map(r => r.slice(1)), [[0, 4], [11, 5]], 'a slice reads only its own range');
  assert.equal(await mtl.text(), 'newmtl wood');
  assert.equal(new TextDecoder().decode(await glb.arrayBuffer()), 'glTF-chair-bytes');
  input.value = '';
  assert.equal(input.files.length, 0, 'value = "" clears the choice');
});

test('a closed panel fires cancel; a cancelled click and a disabled input open nothing', async () => {
  const f = fileHost({'a.png': 'png'});
  await bootPage(f.host);
  const input = fileInput();
  const log = events(input, ['input', 'change', 'cancel']);
  f.choose(null);
  input.click();
  await settle();
  assert.deepEqual(log, ['cancel']);
  assert.equal(input.files.length, 0);
  input.addEventListener('click', e => e.preventDefault(), {once: true});
  input.click();
  input.disabled = true;
  input.click();
  await settle();
  assert.equal(f.seen.opens.length, 1, 'only the first click opened the panel');
});

test('a click in the overlay opens the panel; the same choice again changes nothing', async () => {
  const f = fileHost({'a.png': 'png-bytes'});
  const page = await bootPage(f.host);
  const label = g.document.createElement('label');
  const input = fileInput({accept: 'image/*'});
  label.appendChild(input);
  g.document.body.appendChild(label);
  input.setAttribute('data-jsgb', 'f1');
  let changed = 0;
  input.addEventListener('change', () => changed++);
  f.choose(['a.png']);
  page.uiInput(JSON.stringify({type: 'click', id: 'f1', button: 0}));
  await settle();
  assert.equal(changed, 1);
  assert.ok(f.seen.opens[0].extensions.includes('png') && f.seen.opens[0].extensions.includes('webp'), 'image/* lists the image extensions');
  page.uiInput(JSON.stringify({type: 'click', id: 'f1', button: 0}));
  assert.equal(input.files.length, 1, 'the click itself keeps the earlier choice');
  await settle();
  assert.deepEqual([f.seen.opens.length, changed], [2, 1], 'the panel opened again; the same file is no change');
});

test('a host without an open panel cancels the pick, so the page never waits', async () => {
  const f = fileHost({}, {panel: false});
  await bootPage(f.host);
  const input = fileInput();
  const log = events(input, ['change', 'cancel']);
  input.click();
  await settle();
  assert.deepEqual(log, ['cancel']);
  assert.ok(f.hostSeen.logs.some(l => /no open panel/.test(l)));
});

test('a webkitdirectory input lists every file in the folder with its relative path', async () => {
  const f = fileHost({'Set/a.glb': 'a', 'Set/tex/wood.png': 'w'});
  await bootPage(f.host);
  const input = fileInput({webkitdirectory: true});
  f.choose(['Set']);
  input.click();
  await settle();
  assert.equal(f.seen.opens[0].directory, true);
  assert.deepEqual([...input.files].map(x => x.webkitRelativePath), ['Set/a.glb', 'Set/tex/wood.png']);
  assert.equal(await input.files[1].text(), 'w');
});

test('FormData carries a file input\'s files', async () => {
  const f = fileHost({'notes.txt': 'hello'});
  await bootPage(f.host);
  const form = g.document.createElement('form');
  const input = fileInput({name: 'upload'});
  form.appendChild(input);
  assert.equal(new g.FormData(form).get('upload').name, '', 'an empty File when nothing is chosen');
  f.choose(['notes.txt']);
  input.click();
  await settle();
  assert.equal(new g.FormData(form).get('upload').name, 'notes.txt');
});

test('blob URLs of a picked file load through fetch, and a DataTransfer can set input.files', async () => {
  const f = fileHost({'scene.bin': 'binary-scene'});
  await bootPage(f.host);
  const input = fileInput();
  f.choose(['scene.bin']);
  input.click();
  await settle();
  const url = URL.createObjectURL(input.files[0]);
  assert.equal(await (await fetch(url)).text(), 'binary-scene');
  const dt = new g.DataTransfer();
  dt.items.add(new g.File(['made'], 'made.txt', {type: 'text/plain'}));
  const other = fileInput();
  other.files = dt.files;
  assert.equal(other.files[0].name, 'made.txt');
  assert.equal(await new g.Response(input.files[0].stream()).text(), 'binary-scene', 'Blob.stream() reads the file');
});

test('showOpenFilePicker gives file handles, and a closed panel rejects with AbortError', async () => {
  const f = fileHost({'shot.png': 'png', 'Proj/a.json': '{}', 'Proj/sub/b.json': '[]'});
  await bootPage(f.host);
  f.choose(['shot.png']);
  const [handle] = await g.showOpenFilePicker({types: [{description: 'Images', accept: {'image/png': ['.png']}}]});
  assert.deepEqual(f.seen.opens[0].extensions, ['png']);
  assert.equal(handle.kind, 'file');
  assert.equal((await handle.getFile()).name, 'shot.png');
  assert.equal(await handle.queryPermission(), 'granted');
  f.choose(null);
  await assert.rejects(g.showOpenFilePicker(), e => e.name === 'AbortError');
  f.choose(['Proj']);
  const dir = await g.showDirectoryPicker();
  const names = [];
  for await (const [name, h] of dir.entries()) names.push(`${name}:${h.kind}`);
  assert.deepEqual(names, ['a.json:file', 'sub:directory']);
  const sub = await dir.getDirectoryHandle('sub');
  assert.equal(await (await (await sub.getFileHandle('b.json')).getFile()).text(), '[]');
  await assert.rejects(dir.getFileHandle('missing.json'), e => e.name === 'NotFoundError');
  await tick();
});

test('a large file reads in parts across timer turns, and each read is a fresh copy', async () => {
  const big = new Uint8Array((8 << 20) + 5).map((_, i) => i & 255);
  const f = fileHost({'scan.ply': big});
  await bootPage(f.host);
  const input = fileInput();
  f.choose(['scan.ply']);
  input.click();
  await settle();
  const file = input.files[0];
  const a = new Uint8Array(await file.arrayBuffer()), b = new Uint8Array(await file.arrayBuffer());
  assert.equal(a.length, big.length);
  assert.deepEqual([a[0], a[255], a[256], a[a.length - 1]], [0, 255, 0, (big.length - 1) & 255]);
  assert.notEqual(a.buffer, b.buffer);
  assert.deepEqual(f.seen.reads.map(r => r[2]), [8 << 20, 5, 8 << 20, 5], 'two parts per read, nothing kept between reads');
});

