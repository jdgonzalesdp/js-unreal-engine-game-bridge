// A page's own drags follow the page's answers (Runtime/src/pageDrag.ts), element.draggable is the attribute browsers
// have, and the system's light or dark look and time zone reach the page (appearance.ts, timeZones.ts).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bootHostUi, systemHost} from './host-ui-page.mjs';

const g = globalThis;
const zone = id => { const el = g.document.createElement('div'); el.setAttribute('data-jsgb', id); g.document.body.appendChild(el); return el; };
const none = {types: [], items: [], files: 0};
const send = (page, type, id, extra = {}) => page.uiInput(JSON.stringify({type, id, drag: type === 'drop' ? {...none, data: {}} : none, ...extra}));

test('element.draggable writes "true" and "false", which the overlay reads as a browser does', async () => {
  await bootHostUi(systemHost().host);
  const row = zone('r1');
  assert.equal(row.draggable, false);
  row.draggable = true;
  assert.equal(row.getAttribute('draggable'), 'true');
  assert.match(row.outerHTML, /draggable="true"/);
  assert.equal(row.draggable, true);
  row.draggable = false;
  assert.equal(row.getAttribute('draggable'), 'false');
  assert.equal(row.draggable, false);
  const img = g.document.createElement('img');
  assert.equal(img.draggable, true);
});

test('a layer dropped on a folder that takes it lands, and the row\'s dragend sees the move', async () => {
  const page = await bootHostUi(systemHost().host);
  const row = zone('r1'), folder = zone('f1');
  row.addEventListener('dragstart', e => { e.dataTransfer.setData('application/x-cine-layer-id', 'L7'); e.dataTransfer.effectAllowed = 'copyMove'; });
  folder.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('application/x-cine-layer-id')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } });
  const log = [];
  folder.addEventListener('drop', e => log.push(['drop', e.dataTransfer.getData('application/x-cine-layer-id'), e.dataTransfer.dropEffect]));
  row.addEventListener('dragend', e => log.push(['dragend', e.dataTransfer.dropEffect, [...e.dataTransfer.types]]));
  send(page, 'dragstart', 'r1');
  send(page, 'dragenter', 'f1');
  send(page, 'dragover', 'f1');
  send(page, 'drop', 'f1');
  send(page, 'dragend', 'r1');
  assert.deepEqual(log, [['drop', 'L7', 'move'], ['dragend', 'move', ['application/x-cine-layer-id']]]);
});

test('a drop where no dragover was cancelled is a dragleave, and the drag ends with dropEffect none', async () => {
  const page = await bootHostUi(systemHost().host);
  const row = zone('r1'), other = zone('o1');
  row.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', 'L1'));
  const log = [];
  for (const type of ['dragover', 'dragleave', 'drop']) other.addEventListener(type, e => log.push(type));
  row.addEventListener('dragend', e => log.push('dragend ' + e.dataTransfer.dropEffect));
  send(page, 'dragstart', 'r1');
  send(page, 'dragover', 'o1');
  send(page, 'drop', 'o1');
  send(page, 'dragend', 'r1');
  assert.deepEqual(log, ['dragover', 'dragleave', 'dragend none']);
});

test('a cancelled dragstart cancels the whole drag; the next drag works', async () => {
  const page = await bootHostUi(systemHost().host);
  const row = zone('r1'), folder = zone('f1');
  let locked = true;
  row.addEventListener('dragstart', e => { if (locked) { e.preventDefault(); return; } e.dataTransfer.setData('application/x-cine-layer-id', 'L2'); });
  const log = [];
  folder.addEventListener('dragover', e => { log.push('over'); e.preventDefault(); });
  folder.addEventListener('drop', e => log.push('drop ' + e.dataTransfer.getData('application/x-cine-layer-id')));
  row.addEventListener('dragend', () => log.push('end'));
  for (const [type, id] of [['dragstart', 'r1'], ['dragover', 'f1'], ['drop', 'f1'], ['dragend', 'r1']]) send(page, type, id);
  assert.deepEqual(log, []);
  locked = false;
  for (const [type, id] of [['dragstart', 'r1'], ['dragover', 'f1'], ['drop', 'f1'], ['dragend', 'r1']]) send(page, type, id);
  assert.deepEqual(log, ['over', 'drop L2', 'end']);
});

test('effectAllowed "copy" with a cancel that picks no effect drops as a copy', async () => {
  const page = await bootHostUi(systemHost().host);
  const card = zone('c1'), rail = zone('k1');
  card.addEventListener('dragstart', e => { e.dataTransfer.setData('application/x-play', 'P1'); e.dataTransfer.effectAllowed = 'copy'; });
  rail.addEventListener('dragover', e => e.preventDefault());
  let dropped = null;
  rail.addEventListener('drop', e => { dropped = [e.dataTransfer.getData('application/x-play'), e.dataTransfer.dropEffect]; });
  for (const [type, id] of [['dragstart', 'c1'], ['dragenter', 'k1'], ['dragover', 'k1'], ['drop', 'k1'], ['dragend', 'c1']]) send(page, type, id);
  assert.deepEqual(dropped, ['P1', 'copy']);
});

test('dropEffect none in a cancelled dragover refuses the drop (files the page does not take)', async () => {
  const page = await bootHostUi(systemHost().host);
  const target = zone('t1');
  const files = {types: ['Files'], items: [{kind: 'file', type: 'image/png'}], files: 0};
  target.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; });
  const log = [];
  target.addEventListener('drop', () => log.push('drop'));
  target.addEventListener('dragleave', () => log.push('leave'));
  page.uiInput(JSON.stringify({type: 'dragenter', id: 't1', drag: files}));
  page.uiInput(JSON.stringify({type: 'dragover', id: 't1', drag: files}));
  page.uiInput(JSON.stringify({type: 'drop', id: 't1', drag: {...files, files: 1, data: {}}}));
  assert.deepEqual(log, ['leave']);
});

test('prefers-color-scheme follows the host\'s look, with change events', async () => {
  const h = systemHost({scheme: 'dark'});
  const page = await bootHostUi(h.host);
  const mq = g.matchMedia('(prefers-color-scheme: dark)');
  assert.equal(mq.matches, true);
  assert.equal(g.matchMedia('(prefers-color-scheme: light)').matches, false);
  const changes = [];
  mq.addEventListener('change', e => changes.push(e.matches));
  assert.equal(page.checkAppearance(), false);
  h.state.scheme = 'light';
  assert.equal(page.checkAppearance(), true);
  assert.deepEqual(changes, [false]);
  assert.equal(page.matchesMedia('(prefers-color-scheme: light)'), true);
});

test('the page\'s local time zone is the host\'s name for it', async () => {
  const page = await bootHostUi(systemHost({timeZone: 'Asia/Kolkata'}).host);
  assert.equal(page.localZone(), 'Asia/Kolkata');
});
