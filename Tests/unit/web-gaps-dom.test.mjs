// The DOM pieces webGaps.ts adds: text selection, field validity, the smaller DOM gaps, hit testing from the overlay's
// layout, media queries and CSS custom properties. The React test uses the react-dom build PrepViz ships (found in
// ../cine-blocking; it skips when that isn't there).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {stubHost, tick} from './browser-page.mjs';
import {bootGaps} from './web-gaps-page.mjs';

const g = globalThis;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pnpm = path.resolve(root, '../cine-blocking/node_modules/.pnpm');
const reactDir = fs.existsSync(pnpm) ? fs.readdirSync(pnpm).filter(d => d.startsWith('react-dom@18')).sort().at(-1) : undefined;

test('React runs a text field\'s key handlers: its selection read no longer throws', {skip: !reactDir && 'react-dom is not installed in ../cine-blocking'}, async () => {
  const {uiInput} = await bootGaps();
  const send = p => uiInput(JSON.stringify(p));
  const load = createRequire(path.join(pnpm, reactDir, 'node_modules/react-dom/package.json'));
  const React = load('react'), {flushSync} = load('react-dom'), {createRoot} = load('react-dom/client');
  const h = React.createElement, keys = [];
  const container = g.document.createElement('div');
  g.document.body.appendChild(container);
  const app = createRoot(container);
  flushSync(() => app.render(h('div', null,
    h('input', {id: 'name', defaultValue: 'Scene 1', onKeyDown: e => keys.push('down ' + e.key), onKeyUp: e => keys.push('up ' + e.key)}),
    h('div', {id: 'note', contentEditable: true, suppressContentEditableWarning: true, onKeyDown: e => keys.push('note ' + e.key)}, 'text'))));
  send({type: 'focusin', selector: '#name'});
  send({type: 'keydown', selector: '#name', key: 'Enter', code: 'Enter'});
  send({type: 'keyup', selector: '#name', key: 'Enter', code: 'Enter'});
  send({type: 'focusin', selector: '#note'});
  send({type: 'keydown', selector: '#note', key: 'Escape', code: 'Escape'});
  await tick();
  assert.deepEqual(keys, ['down Enter', 'up Enter', 'note Escape']);
  flushSync(() => app.unmount());
});

test('a text field keeps a selection; types without one refuse it, as in a browser', async () => {
  await bootGaps();
  const doc = g.document;
  doc.body.innerHTML = '<input id="t" value="hello world"><input id="n" type="number" value="5"><textarea id="a">abc</textarea>';
  const t = doc.getElementById('t'), n = doc.getElementById('n'), a = doc.getElementById('a');
  assert.deepEqual([t.selectionStart, t.selectionEnd], [11, 11], 'the caret starts at the end');
  t.setSelectionRange(0, 5);
  assert.deepEqual([t.selectionStart, t.selectionEnd, t.selectionDirection], [0, 5, 'none']);
  t.setRangeText('HELLO', 0, 5, 'select');
  assert.deepEqual([t.value, t.selectionStart, t.selectionEnd], ['HELLO world', 0, 5]);
  t.value = 'new';
  assert.deepEqual([t.selectionStart, t.selectionEnd], [3, 3], 'a new value puts the caret at its end');
  a.select();
  assert.deepEqual([a.selectionStart, a.selectionEnd], [0, 3]);
  assert.equal(n.selectionStart, null);
  assert.throws(() => n.setSelectionRange(0, 1), e => e.name === 'InvalidStateError');
});

test('the document selection and Range boundary points', async () => {
  await bootGaps();
  const doc = g.document;
  doc.body.innerHTML = '<div id="d"><h3 id="h">Title</h3><p id="p">one <b>two</b> three</p></div>';
  const sel = g.getSelection();
  assert.equal(doc.getSelection(), sel);
  assert.deepEqual([sel.rangeCount, sel.anchorNode, sel.isCollapsed, sel.type, sel.toString()], [0, null, true, 'None', '']);
  const r = doc.createRange();
  r.selectNodeContents(doc.getElementById('p'));
  sel.removeAllRanges(); sel.addRange(r);
  assert.equal(sel.toString(), 'one two three');
  assert.equal(sel.type, 'Range');
  const text = doc.getElementById('h').firstChild;
  sel.collapse(text, 2);
  assert.deepEqual([sel.anchorNode, sel.anchorOffset, sel.isCollapsed], [text, 2, true]);
  assert.equal(sel.anchorNode.parentElement.closest('h3').id, 'h');
  const c = doc.createRange(); c.setStart(text, 1); c.setEnd(text, 4);
  assert.deepEqual([c.toString(), c.collapsed, c.startOffset, c.endOffset], ['itl', false, 1, 4]);
  c.collapse(true);
  assert.equal(c.collapsed, true);
  assert.equal(typeof g.Range, 'function');
});

test('constraint validation, valueAsNumber and stepping', async () => {
  await bootGaps();
  const doc = g.document;
  doc.body.innerHTML = '<form id="f"><input id="n" type="number" min="0" max="10" value="4"><input id="r" required><input id="d" type="date" value="2026-11-16"></form>';
  const n = doc.getElementById('n'), r = doc.getElementById('r'), d = doc.getElementById('d');
  let invalid = 0;
  n.addEventListener('invalid', () => invalid++);
  n.setCustomValidity('Too far');
  assert.deepEqual([n.validity.customError, n.validity.valid, n.validationMessage, n.checkValidity(), invalid], [true, false, 'Too far', false, 1]);
  n.setCustomValidity('');
  assert.equal(n.checkValidity(), true);
  assert.equal(n.valueAsNumber, 4);
  n.value = '12';
  assert.equal(n.validity.rangeOverflow, true);
  n.value = '';
  assert.ok(Number.isNaN(n.valueAsNumber));
  n.valueAsNumber = 2.5; n.stepUp(); n.stepDown(5);
  assert.equal(n.value, '0', 'stepping stops at min');
  assert.deepEqual([r.validity.valueMissing, r.reportValidity()], [true, false]);
  r.value = 'x';
  assert.equal(r.checkValidity(), true);
  assert.equal(d.valueAsNumber, Date.UTC(2026, 10, 16));
  assert.equal(d.valueAsDate.toISOString(), '2026-11-16T00:00:00.000Z');
});

test('document.implementation, XMLSerializer, innerText, readyState and the smaller gaps', async () => {
  await bootGaps();
  const doc = g.document;
  const other = doc.implementation.createHTMLDocument('note');
  const body = other.createElement('body');
  body.innerHTML = '<p>Hi <b>there</b><br>x</p>';
  assert.equal(body.querySelector('b').textContent, 'there');
  assert.notEqual(other, doc);
  const div = doc.createElement('div');
  div.innerHTML = '<p>a<br>b</p><img src="x.png">';
  assert.equal(new g.XMLSerializer().serializeToString(div), '<div xmlns="http://www.w3.org/1999/xhtml"><p>a<br /></p><img src="x.png" /></div>'.replace('<br /></p>', '<br />b</p>'));
  div.innerText = 'one\ntwo';
  assert.equal(div.innerHTML, 'one<br>two');
  assert.equal(doc.readyState, 'interactive');
  let loaded = 0;
  g.addEventListener('load', () => loaded++);
  await tick(5);
  assert.deepEqual([doc.readyState, loaded], ['complete', 1]);
  assert.deepEqual([new g.CompositionEvent('compositionend', {data: 'x'}).data, new g.StorageEvent('storage', {key: 'k'}).key], ['x', 'k']);
  assert.equal(new g.KeyboardEvent('keydown', {shiftKey: true}).getModifierState('Shift'), true);
  assert.equal(g.navigator.onLine, true);
  assert.equal(doc.execCommand('bold'), false);
  assert.equal(g.NodeFilter.SHOW_ELEMENT, 1);
  assert.deepEqual([...doc.styleSheets], []);
});

test('elementFromPoint finds the topmost element the overlay laid out under the point', async () => {
  const {layoutBoxes, uiInput} = await bootGaps();
  const doc = g.document;
  doc.body.innerHTML = '<div id="tree"><div id="proj" data-drop-project="p1"><span id="row">Scene</span></div></div><div id="veil"></div>';
  uiInput(JSON.stringify({type: 'pointermove', selector: '#tree'}));
  const id = sel => { const el = doc.querySelector(sel); if (!el.hasAttribute('data-jsgb')) el.setAttribute('data-jsgb', 'x' + sel.slice(1)); return el.getAttribute('data-jsgb'); };
  layoutBoxes.set(id('#tree'), {x: 0, y: 0, width: 300, height: 600, display: 'block'});
  layoutBoxes.set(id('#proj'), {x: 0, y: 40, width: 300, height: 100, display: 'block'});
  layoutBoxes.set(id('#row'), {x: 10, y: 50, width: 100, height: 20, display: 'inline'});
  layoutBoxes.set(id('#veil'), {x: 0, y: 0, width: 1600, height: 900, display: 'block', pointerEvents: 'none'});
  assert.equal(doc.elementFromPoint(20, 60).id, 'row');
  assert.equal(doc.elementFromPoint(200, 120).closest('[data-drop-project]').getAttribute('data-drop-project'), 'p1');
  assert.equal(doc.elementFromPoint(200, 700), doc.documentElement, 'nothing laid out there: the page itself');
  assert.deepEqual(doc.elementsFromPoint(20, 60).slice(0, 3).map(e => e.id), ['row', 'proj', 'tree']);
});

test('matchMedia follows the viewport and reports changes', async () => {
  const {setViewport} = await bootGaps();
  setViewport(1600, 900);
  const phone = g.matchMedia('(max-width: 600px)'), wide = g.matchMedia('only screen and (min-width: 1200px)');
  assert.deepEqual([phone.matches, wide.matches, g.matchMedia('(min-width: 5000px)').matches], [false, true, false]);
  assert.deepEqual([g.matchMedia('(pointer: coarse)').matches, g.matchMedia('(hover: hover) and (pointer: fine)').matches, g.matchMedia('print').matches], [false, true, false]);
  assert.equal(g.matchMedia('(max-width: 600px) and (orientation: portrait), (min-height: 800px)').matches, true);
  assert.equal(g.matchMedia('(400px <= width <= 1700px)').matches, true);
  const seen = [];
  phone.addEventListener('change', e => seen.push(e.matches));
  setViewport(500, 800);
  assert.deepEqual([seen, phone.matches, g.matchMedia('(orientation: portrait)').matches], [[true], true, true]);
});

test('custom properties inherit from ancestors and come from the page stylesheet', async () => {
  const {host} = stubHost({origin: 'http://localhost:5180'});
  const files = {'/page.json': JSON.stringify({css: 'game.css'}),
    '/game.css': ':root{--accent:#111;--gap:4px}\nhtml[data-theme="dark"]{--accent:#222}\n.panel{--gap:var(--accent)}\n@media (max-width: 600px){:root{--accent:#333}}'};
  host.readFile = p => files[p] ? new TextEncoder().encode(files[p]).buffer : null;
  const {setViewport} = await bootGaps({host});
  setViewport(1600, 900);
  const doc = g.document;
  doc.body.innerHTML = '<div class="panel"><span id="s"></span></div>';
  const s = doc.getElementById('s'), read = name => g.getComputedStyle(s).getPropertyValue(name);
  doc.documentElement.style.setProperty('--bottom-bar-h', '48px');
  assert.equal(read('--bottom-bar-h'), '48px', 'a variable set on <html> reaches its descendants');
  assert.deepEqual([read('--accent'), read('--gap'), read('--missing')], ['#111', '#111', '']);
  doc.documentElement.setAttribute('data-theme', 'dark');
  assert.equal(read('--accent'), '#222', 'the more specific rule wins');
  doc.documentElement.removeAttribute('data-theme');
  setViewport(500, 900);
  assert.equal(read('--accent'), '#333', 'a matching @media rule counts');
});
