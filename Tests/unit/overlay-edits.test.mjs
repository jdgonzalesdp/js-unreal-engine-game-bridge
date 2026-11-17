// The overlay's text editing, selection, scrolling, pens and clipboard, replayed into the runtime's page as uiInput
// receives them, and the commands the page sends back with its publishes (Runtime/src/overlayEdits.ts and neighbours).
// The overlay's half (JavaScript/jsgb-ui-edit.js, jsgb-ui-motion.js) needs a real browser and is not run here.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bootPage, stubHost, tick} from './browser-page.mjs';

const g = globalThis;

async function page() {
  const {host} = stubHost({origin: 'http://localhost:5180'});
  const published = [];
  host.ui = {publish: html => published.push(html)};
  // Each boot is a new page; an earlier boot's selection must not answer getSelection() here.
  for (const k of ['getSelection', 'Selection', 'Range']) delete g[k];
  const runtime = await bootPage(host);
  const send = p => runtime.uiInput(JSON.stringify(p));
  const publish = () => { runtime.publishUI(0); return published.at(-1) ?? ''; };
  /** The commands in the last publish. */
  const commands = () => {
    const m = /<meta name="jsgb-commands" content="([^"]*)">/.exec(publish());
    if (!m) return [];
    return JSON.parse(m[1].replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')).list;
  };
  const idOf = el => el.getAttribute('data-jsgb');
  return {send, publish, commands, idOf};
}

test('an editable region takes the overlay\'s edits in place, and drops one made before the page changed it', async () => {
  const {send, publish, idOf} = await page();
  const doc = g.document;
  doc.body.innerHTML = '<div id="note" contenteditable="true"><h3>Ti</h3></div>';
  const note = doc.getElementById('note'), h3 = note.firstChild;
  publish();
  assert.equal(note.getAttribute('data-jsgb-rev'), '1');
  assert.equal(h3.getAttribute('data-jsgb'), null, 'no bridge ids inside the region');
  assert.equal(note.isContentEditable && h3.isContentEditable, true);
  assert.equal(note.contentEditable, 'true');
  const inputs = [];
  note.addEventListener('input', e => inputs.push([e.constructor.name, e.inputType, e.data]));
  send({type: 'input', id: idOf(note), html: '<h3>Tit</h3>', rev: '1', inputType: 'insertText', data: 't', edit: 1});
  assert.equal(note.innerHTML, '<h3>Tit</h3>');
  assert.equal(note.firstChild, h3, 'the same element, changed in place');
  assert.deepEqual(inputs, [['InputEvent', 'insertText', 't']]);
  // The page's own change raises the revision; an overlay edit made on the old one is dropped.
  h3.textContent = 'Page';
  send({type: 'input', id: idOf(note), html: '<h3>Titl</h3>', rev: '1', inputType: 'insertText', data: 'l', edit: 2});
  assert.equal(note.innerHTML, '<h3>Page</h3>');
  assert.equal(inputs.length, 1);
  publish();
  assert.equal(note.getAttribute('data-jsgb-rev'), '2');
});

test('execCommand goes to the overlay for the focused region; queries read the page\'s selection', async () => {
  const {send, commands, idOf, publish} = await page();
  const doc = g.document;
  doc.body.innerHTML = '<div id="note" contenteditable><p>a <b id="b">bold</b></p></div><button id="x">x</button>';
  const note = doc.getElementById('note');
  publish();
  assert.equal(doc.execCommand('bold'), false, 'nothing editable is focused');
  send({type: 'focusin', id: idOf(note)});
  g.getSelection().collapse(doc.getElementById('b').firstChild, 2);
  assert.equal(doc.execCommand('formatBlock', false, 'h3'), true);
  assert.equal(doc.queryCommandState('bold'), true);
  assert.equal(doc.queryCommandValue('formatBlock'), 'p');
  const list = commands();
  assert.deepEqual(list.find(c => c.k === 'exec'), {k: 'exec', id: idOf(note), cmd: 'formatBlock', value: 'h3', n: list.find(c => c.k === 'exec').n});
  // The caret the page set goes too: inside the region, the region and paths below it.
  assert.deepEqual(list.find(c => c.k === 'sel').anchor, {id: idOf(note), path: [0, 0], c: 0, t: 2});
});

test('the overlay\'s selection reaches the page, unless the page set its own since', async () => {
  const {send, commands, idOf, publish} = await page();
  const doc = g.document;
  doc.body.innerHTML = '<p id="p">Some <i>static</i> words</p><input id="f" value="abcdef">';
  publish();
  const p = doc.getElementById('p'), f = doc.getElementById('f');
  const at = t => ({id: idOf(p), path: [], c: 1, t});
  send({type: 'selection', sel: {anchor: at(1), focus: at(6)}, seen: 0});
  assert.equal(String(g.getSelection()), 'words');
  g.getSelection().selectAllChildren(p);
  const n = commands().find(c => c.k === 'sel').n;
  send({type: 'selection', sel: {anchor: at(0), focus: at(1)}, seen: n - 1});
  assert.equal(String(g.getSelection()), 'Some static words', 'a report from before the page\'s selection is dropped');
  send({type: 'selection', sel: {anchor: at(0), focus: at(1)}, seen: n});
  assert.equal(String(g.getSelection()), ' ');
  send({type: 'keyup', id: idOf(f), key: 'ArrowRight', fsel: {start: 1, end: 3, dir: 'forward'}, seen: n});
  assert.deepEqual([f.selectionStart, f.selectionEnd, f.selectionDirection], [1, 3, 'forward']);
  f.setSelectionRange(0, 2);
  assert.deepEqual(commands().filter(c => c.k === 'fsel').map(({start, end, value}) => [start, end, value]), [[0, 2, 'abcdef']]);
});

test('scrolling: the overlay\'s position and sizes, the page\'s own scrolls as commands, scroll events', async () => {
  const {send, commands, idOf, publish} = await page();
  const doc = g.document;
  doc.body.innerHTML = '<div id="s"><div id="row"></div></div>';
  publish();
  const s = doc.getElementById('s'), seen = [];
  send({type: 'host-layout', width: 800, height: 600, rects: {[idOf(s)]: {x: 0, y: 0, width: 302, height: 202, sw: 300, sh: 1800, clw: 300, clh: 200}}});
  assert.deepEqual([s.scrollHeight, s.clientHeight, s.scrollWidth], [1800, 200, 300]);
  s.addEventListener('scroll', () => seen.push('element'));
  g.addEventListener('scroll', e => seen.push('window capture ' + e.target.id), true);
  send({type: 'scroll', id: idOf(s), top: 300, left: 0});
  assert.equal(s.scrollTop, 300);
  assert.deepEqual(seen, ['window capture s', 'element']);
  s.scrollTop = 99999;
  assert.equal(s.scrollTop, 1600, 'clamped as a browser does');
  doc.getElementById('row').scrollIntoView({block: 'center'});
  const list = commands().filter(c => c.k === 'scroll');
  assert.deepEqual(list.map(({id, top, into}) => [id, top, into?.block]), [[idOf(s), 99999, undefined], [idOf(doc.getElementById('row')), undefined, 'center']]);
});

test('a pointermove carries its samples: getCoalescedEvents and getPredictedEvents, with pen fields', async () => {
  const {send, idOf, publish} = await page();
  const doc = g.document;
  doc.body.innerHTML = '<canvas id="c"></canvas>';
  publish();
  const c = doc.getElementById('c');
  let got;
  c.addEventListener('pointermove', e => { got = {e, list: e.getCoalescedEvents(), predicted: e.getPredictedEvents()}; });
  send({type: 'pointermove', id: idOf(c), pointerType: 'pen', pointerId: 2, clientX: 30, clientY: 40, offsetX: 10, offsetY: 20, pressure: 0.7, tiltX: 15, buttons: 1,
    coalesced: [{clientX: 26, clientY: 38, pressure: 0.6, tiltX: 14, dt: -4}, {clientX: 30, clientY: 40, pressure: 0.7, tiltX: 15, dt: 0}],
    predicted: [{clientX: 34, clientY: 42, pressure: 0.7, dt: 8}]});
  assert.equal(got.e.tiltX, 15);
  assert.equal(got.e.pressure, 0.7);
  assert.deepEqual(got.list.map(s => [s.clientX, s.offsetX, s.offsetY, s.pressure, s.tiltX, s.pointerType, s.pointerId, s.target === c]),
    [[26, 6, 18, 0.6, 14, 'pen', 2, true], [30, 10, 20, 0.7, 15, 'pen', 2, true]]);
  assert.equal(got.list[0].timeStamp, got.e.timeStamp - 4);
  assert.deepEqual(got.predicted.map(s => s.clientX), [34]);
  assert.ok(got.list[0] instanceof g.PointerEvent);
  send({type: 'pointermove', id: idOf(c), clientX: 1, clientY: 1});
  assert.deepEqual(got.list, [got.e], 'one sample: the event itself');
  const down = new g.PointerEvent('pointerdown', {});
  assert.deepEqual(down.getCoalescedEvents(), []);
});

test('held keys and pastes: the page\'s listeners decide, the answer goes back', async () => {
  const {send, commands, idOf, publish} = await page();
  const doc = g.document;
  doc.body.innerHTML = '<textarea id="t"></textarea>';
  publish();
  const t = doc.getElementById('t');
  let cancelEnter = true;
  t.addEventListener('keydown', e => { if (e.key === 'Enter' && cancelEnter && !e.isComposing) e.preventDefault(); });
  const pastes = [];
  t.addEventListener('paste', async e => {
    const file = e.clipboardData.files[0];
    if (file) e.preventDefault();
    pastes.push([e.clipboardData.getData('text/plain'), file?.name, file?.type, file && [...new Uint8Array(await file.arrayBuffer())]]);
  });
  send({type: 'keydown', id: idOf(t), key: 'Enter', code: 'Enter', held: 1});
  cancelEnter = false;
  send({type: 'keydown', id: idOf(t), key: 'Enter', code: 'Enter', held: 2});
  send({type: 'keydown', id: idOf(t), key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229, held: 3});
  send({type: 'paste', id: idOf(t), held: 4, clip: {data: {'text/plain': 'hi'}}});
  send({type: 'paste', id: idOf(t), held: 5, clip: {data: {}, files: [{name: 'shot.png', type: 'image/png', base64: 'iVBORw=='}]}});
  await tick();
  assert.deepEqual(commands().filter(c => c.k === 'held').map(c => [c.held, c.ok]), [[1, false], [2, true], [3, true], [4, true], [5, false]]);
  assert.deepEqual(pastes, [['hi', undefined, undefined, undefined], ['', 'shot.png', 'image/png', [137, 80, 78, 71]]]);
  const ime = [];
  t.addEventListener('compositionupdate', e => ime.push(e.data));
  send({type: 'compositionupdate', id: idOf(t), data: 'に'});
  assert.deepEqual(ime, ['に']);
});

test('focus moving fires blur, focusout, focus and focusin once, from the page or the overlay', async () => {
  const {send, idOf, publish} = await page();
  const doc = g.document;
  doc.body.innerHTML = '<input id="a"><input id="b"><button id="bar">B</button>';
  publish();
  const a = doc.getElementById('a'), b = doc.getElementById('b'), log = [];
  for (const el of [a, b]) for (const type of ['blur', 'focusout', 'focus', 'focusin']) el.addEventListener(type, e => log.push(`${type} ${el.id} ${e.relatedTarget?.id ?? '-'}`));
  a.focus(); b.focus(); b.blur();
  assert.deepEqual(log.splice(0), ['focus a -', 'focusin a -', 'blur a b', 'focusout a b', 'focus b a', 'focusin b a', 'blur b -', 'focusout b -']);
  send({type: 'focusin', id: idOf(a)});
  send({type: 'focusout', id: idOf(a), relatedId: idOf(b)});
  send({type: 'focusin', id: idOf(b), relatedId: idOf(a)});
  assert.deepEqual(log.splice(0), ['focus a -', 'focusin a -', 'blur a b', 'focusout a b', 'focus b a', 'focusin b a']);
  // A toolbar press the overlay held back: not cancelled, the field lets go of focus before the click.
  send({type: 'mousedown', id: idOf(doc.getElementById('bar')), button: 0, held: true});
  assert.equal(doc.activeElement, doc.body);
  assert.deepEqual(log.splice(0), ['blur b -', 'focusout b -']);
});
