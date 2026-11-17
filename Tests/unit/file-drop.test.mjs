// Drag and drop as the overlay reports it (Runtime/src/dragDrop.ts): files dragged in from the Finder reach the drop
// listener of the element under the pointer with their dataTransfer.files, read from the host, and a page's own drag
// carries its data from dragstart to drop.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bootPage} from './browser-page.mjs';
import {fileHost} from './file-host.mjs';

const g = globalThis;
const zone = id => { const el = g.document.createElement('div'); el.setAttribute('data-jsgb', id); g.document.body.appendChild(el); return el; };
const outside = {types: ['Files'], items: [{kind: 'file', type: 'model/gltf-binary'}], files: 0, effectAllowed: 'all'};

test('files dropped from the Finder reach the drop target, with their kinds shown before the drop', async () => {
  const f = fileHost({'Desk/chair.glb': 'glTF-chair', 'Desk/Set/a.png': 'png-a', 'Desk/Set/b.png': 'png-b'});
  const page = await bootPage(f.host);
  const target = zone('d1');
  const seen = [];
  for (const type of ['dragenter', 'dragover', 'drop']) target.addEventListener(type, e => {
    seen.push({type, types: [...e.dataTransfer.types], files: e.dataTransfer.files.length, items: e.dataTransfer.items.length, isDrag: e instanceof g.DragEvent, x: e.clientX});
    e.preventDefault();
  });
  let dropped = null;
  target.addEventListener('drop', e => { dropped = e.dataTransfer; });
  page.uiInput(JSON.stringify({type: 'dragenter', id: 'd1', clientX: 40, drag: outside}));
  page.uiInput(JSON.stringify({type: 'dragover', id: 'd1', clientX: 41, drag: outside}));
  f.drop(['Desk/chair.glb', 'Desk/Set']);
  page.uiInput(JSON.stringify({type: 'drop', id: 'd1', clientX: 42, drag: {...outside, files: 2, data: {}}}));
  assert.deepEqual(seen, [
    {type: 'dragenter', types: ['Files'], files: 0, items: 1, isDrag: true, x: 40},
    {type: 'dragover', types: ['Files'], files: 0, items: 1, isDrag: true, x: 41},
    {type: 'drop', types: ['Files'], files: 2, items: 2, isDrag: true, x: 42},
  ]);
  const [glb, folder] = dropped.files;
  assert.deepEqual([glb.name, glb.type, glb.size, folder.name], ['chair.glb', 'model/gltf-binary', 10, 'Set']);
  assert.equal(await glb.text(), 'glTF-chair');
  const entry = dropped.items[1].webkitGetAsEntry();
  assert.deepEqual([entry.isDirectory, entry.fullPath], [true, '/Set']);
  const children = await new Promise(resolve => entry.createReader().readEntries(resolve));
  assert.deepEqual(children.map(c => c.fullPath), ['/Set/a.png', '/Set/b.png']);
  const file = await new Promise(resolve => children[1].file(resolve));
  assert.equal(await file.text(), 'png-b');
  assert.equal(dropped.items[0].getAsFile(), glb);
});

test('a page\'s own drag keeps its data from dragstart to drop, hidden while it moves', async () => {
  const f = fileHost();
  const page = await bootPage(f.host);
  const row = zone('r1'), folder = zone('r2');
  row.addEventListener('dragstart', e => { e.dataTransfer.setData('application/x-layer', 'layer-7'); e.dataTransfer.effectAllowed = 'move'; });
  const log = [];
  folder.addEventListener('dragover', e => { log.push(['over', [...e.dataTransfer.types], e.dataTransfer.getData('application/x-layer')]); e.preventDefault(); });
  folder.addEventListener('drop', e => log.push(['drop', e.dataTransfer.getData('application/x-layer'), e.dataTransfer.files.length]));
  page.uiInput(JSON.stringify({type: 'dragstart', id: 'r1', drag: {types: [], items: [], files: 0}}));
  page.uiInput(JSON.stringify({type: 'dragover', id: 'r2', drag: {types: [], items: [], files: 0}}));
  page.uiInput(JSON.stringify({type: 'drop', id: 'r2', drag: {types: [], items: [], files: 0, data: {}}}));
  page.uiInput(JSON.stringify({type: 'dragend', id: 'r1', drag: {types: [], items: [], files: 0}}));
  assert.deepEqual(log, [['over', ['application/x-layer'], ''], ['drop', 'layer-7', 0]]);
});

test('text dragged in from another app arrives at the drop', async () => {
  const f = fileHost();
  const page = await bootPage(f.host);
  const target = zone('t1');
  let text = null;
  // A drop lands only where the page took the drag, as in a browser (pageDrag.ts).
  target.addEventListener('dragenter', e => e.preventDefault());
  target.addEventListener('drop', e => { text = [e.dataTransfer.getData('text/plain'), e.dataTransfer.getData('text'), e.dataTransfer.files.length]; });
  const drag = {types: ['text/plain'], items: [{kind: 'string', type: 'text/plain'}], files: 0};
  page.uiInput(JSON.stringify({type: 'dragenter', id: 't1', drag}));
  page.uiInput(JSON.stringify({type: 'drop', id: 't1', drag: {...drag, data: {'text/plain': 'INT. KITCHEN - NIGHT'}}}));
  assert.deepEqual(text, ['INT. KITCHEN - NIGHT', 'INT. KITCHEN - NIGHT', 0]);
});
