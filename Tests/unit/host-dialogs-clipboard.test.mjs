// window.alert, confirm and prompt wait for the host's native dialog (Runtime/src/dialogs.ts), and the clipboard reaches
// the system's (clipboard.ts, clipboardCommands.ts): navigator.clipboard, ClipboardItem, the copy, cut and paste keys
// the overlay holds back outside fields, and document.execCommand('copy').
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {bootHostUi, systemHost} from './host-ui-page.mjs';

const g = globalThis;
const tagged = (tag, id) => { const el = g.document.createElement(tag); el.setAttribute('data-jsgb', id); g.document.body.appendChild(el); return el; };

test('confirm, prompt and alert wait for the host dialog and return the person\'s answer', async () => {
  const h = systemHost({answers: ['1', '0', '1Ada Lovelace', '0', '1']});
  await bootHostUi(h.host);
  assert.equal(g.confirm('Delete this layer?'), true);
  assert.equal(g.confirm('Delete this layer?'), false);
  assert.equal(g.prompt('Cast member name', 'New actor'), 'Ada Lovelace');
  assert.equal(g.prompt('Location'), null);
  assert.equal(g.alert('Saved'), undefined);
  assert.deepEqual(h.dialogs, [
    {kind: 'confirm', message: 'Delete this layer?', value: ''},
    {kind: 'confirm', message: 'Delete this layer?', value: ''},
    {kind: 'prompt', message: 'Cast member name', value: 'New actor'},
    {kind: 'prompt', message: 'Location', value: ''},
    {kind: 'alert', message: 'Saved', value: ''},
  ]);
});

test('a dialog that fails answers Cancel, and a host without dialogs keeps the logged stand-ins', async () => {
  const failing = systemHost();
  failing.host.dialog = () => { throw new Error('no window'); };
  await bootHostUi(failing.host);
  assert.equal(g.confirm('Delete everything?'), false);
  assert.equal(g.prompt('Name'), null);
  assert.ok(failing.seen.logs.some(l => /confirm dialog failed/.test(l)));
  const bare = systemHost({withDialog: false});
  await bootHostUi(bare.host);
  assert.equal(g.confirm('Delete?'), true);
  assert.equal(g.prompt('Name'), null);
  assert.ok(bare.seen.logs.some(l => /confirm \(no dialog on this host, answered OK\): Delete\?/.test(l)));
});

test('navigator.clipboard writes and reads text, HTML and PNG pictures through the host', async () => {
  const h = systemHost();
  await bootHostUi(h.host);
  await g.navigator.clipboard.writeText('https://prepviz.app/s/abc');
  assert.deepEqual(h.writes.at(-1), {texts: {'text/plain': 'https://prepviz.app/s/abc'}, png: null});
  assert.equal(await g.navigator.clipboard.readText(), 'https://prepviz.app/s/abc');
  // RichNoteEditor's copy: HTML and plain text together, as one item.
  await g.navigator.clipboard.write([new g.ClipboardItem({
    'text/html': new g.Blob(['<b>INT. KITCHEN</b>'], {type: 'text/html'}),
    'text/plain': Promise.resolve('INT. KITCHEN'),
  })]);
  assert.deepEqual(h.writes.at(-1).texts, {'text/html': '<b>INT. KITCHEN</b>', 'text/plain': 'INT. KITCHEN'});
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  await g.navigator.clipboard.write([new g.ClipboardItem({'image/png': new g.Blob([png], {type: 'image/png'})})]);
  assert.deepEqual([...h.writes.at(-1).png], [...png]);
  const [item] = await g.navigator.clipboard.read();
  assert.deepEqual([...item.types], ['image/png']);
  assert.deepEqual([...new Uint8Array(await (await item.getType('image/png')).arrayBuffer())], [...png]);
  await assert.rejects(g.navigator.clipboard.write([new g.ClipboardItem({'image/jpeg': new g.Blob([png])})]), {name: 'NotAllowedError'});
  assert.equal(g.ClipboardItem.supports('image/png'), true);
  assert.equal(g.ClipboardItem.supports('image/jpeg'), false);
});

test('Cmd+C the overlay held back fires copy at the focused element and copies the person\'s selection', async () => {
  const h = systemHost();
  const page = await bootHostUi(h.host);
  const seen = [];
  g.document.addEventListener('copy', e => seen.push([e.type, e.clipboardData && typeof e.clipboardData.setData]));
  page.uiInput(JSON.stringify({type: 'keydown', key: 'c', code: 'KeyC', metaKey: true, clip: true, selection: 'Scene 4, take 2'}));
  assert.deepEqual(seen, [['copy', 'function']]);
  assert.deepEqual(h.writes.at(-1).texts, {'text/plain': 'Scene 4, take 2'});
  // A listener that sets its own data and cancels puts that on the clipboard instead.
  const panel = tagged('div', 'p1');
  panel.addEventListener('copy', e => { e.clipboardData.setData('text/plain', 'shape:7'); e.clipboardData.setData('application/x-prepviz', '{"id":7}'); e.preventDefault(); });
  page.uiInput(JSON.stringify({type: 'keydown', id: 'p1', key: 'c', code: 'KeyC', metaKey: true, clip: true, selection: 'ignored'}));
  assert.deepEqual(h.writes.at(-1).texts, {'text/plain': 'shape:7', 'application/x-prepviz': '{"id":7}'});
  // The page cancelling the key (its own shape copy) cancels the command; a key the overlay ran itself is not run again.
  const count = h.writes.length;
  const stop = e => e.preventDefault();
  g.document.addEventListener('keydown', stop);
  page.uiInput(JSON.stringify({type: 'keydown', key: 'c', code: 'KeyC', metaKey: true, clip: true, selection: 'x'}));
  g.document.removeEventListener('keydown', stop);
  page.uiInput(JSON.stringify({type: 'keydown', key: 'c', code: 'KeyC', metaKey: true, selection: 'x'}));
  page.uiInput(JSON.stringify({type: 'keydown', key: 'c', code: 'KeyC', ctrlKey: true, clip: true, selection: 'x'}));
  assert.equal(h.writes.length, count);
  assert.equal(seen.length, 2);
});

test('Cmd+V outside a field fires paste with the clipboard\'s text and picture', async () => {
  const h = systemHost();
  const page = await bootHostUi(h.host);
  h.state.clipboard = {texts: {'text/plain': 'from Notes'}, png: Buffer.from([0x89, 0x50, 0x4e, 0x47])};
  // Nobody reads clipboardData (the page pastes its own shapes): the picture is never read off the clipboard.
  let pictureReads = 0;
  const image = h.host.clipboard.image;
  h.host.clipboard.image = () => { pictureReads++; return image(); };
  page.uiInput(JSON.stringify({type: 'keydown', key: 'v', code: 'KeyV', metaKey: true, clip: true}));
  assert.equal(pictureReads, 0);
  let got = null;
  g.document.body.addEventListener('paste', e => {
    const f = e.clipboardData.files[0];
    got = {text: e.clipboardData.getData('text/plain'), types: [...e.clipboardData.types], file: f && [f.name, f.type, f.size]};
  });
  page.uiInput(JSON.stringify({type: 'keydown', key: 'v', code: 'KeyV', metaKey: true, clip: true}));
  assert.deepEqual(got, {text: 'from Notes', types: ['text/plain', 'Files'], file: ['image.png', 'image/png', 4]});
});

test('document.execCommand copy and cut fire the event and copy the page\'s own selection', async () => {
  const h = systemHost();
  await bootHostUi(h.host);
  const area = tagged('textarea', 'a1');
  area.value = 'share link: https://prepviz.app/s/xyz';
  area.focus();
  area.setSelectionRange(12, area.value.length);
  const events = [];
  g.document.addEventListener('copy', e => events.push(e.type));
  g.document.addEventListener('cut', e => events.push(e.type));
  assert.equal(g.document.execCommand('copy'), true);
  assert.deepEqual(h.writes.at(-1).texts, {'text/plain': 'https://prepviz.app/s/xyz'});
  const inputs = [];
  area.addEventListener('input', e => inputs.push(e.inputType));
  area.setSelectionRange(0, 6);
  assert.equal(g.document.execCommand('cut'), true);
  assert.deepEqual(h.writes.at(-1).texts, {'text/plain': 'share '});
  assert.equal(area.value, 'link: https://prepviz.app/s/xyz');
  assert.deepEqual([events, inputs], [['copy', 'cut'], ['deleteByCut']]);
  assert.equal(g.document.queryCommandSupported('copy'), true);
});
