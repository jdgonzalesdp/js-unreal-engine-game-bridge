// What the overlay sends for fields, focus and hover, replayed into the runtime's page as uiInput receives it:
// edits that React notices, focus that follows the overlay's, related targets, and the overlay's view of the 3D canvas.
// The React test uses the react-dom build PrepViz ships (found in ../cine-blocking; it skips when that isn't there).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {bootPage, stubHost, tick} from './browser-page.mjs';

const g = globalThis;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pnpm = path.resolve(root, '../cine-blocking/node_modules/.pnpm');
const reactDir = fs.existsSync(pnpm) ? fs.readdirSync(pnpm).filter(d => d.startsWith('react-dom@18')).sort().at(-1) : undefined;

/** A fresh page; send() hands it a packet as the overlay sends one, published collects what goes to the overlay. */
async function page() {
  const {host} = stubHost({origin: 'http://localhost:5180'});
  const published = [];
  host.ui = {publish: html => published.push(html)};
  const runtime = await bootPage(host);
  return {publishUI: runtime.publishUI, published, send: p => runtime.uiInput(JSON.stringify(p))};
}

/** React's value tracker (react-dom trackValueOnNode): it wraps the property on the node and takes its own writes as
 *  known, so only a change made around the wrapper counts as the player's. Returns whether the value is news. */
function track(node, prop) {
  let proto = Object.getPrototypeOf(node), d;
  while (proto && !(d = Object.getOwnPropertyDescriptor(proto, prop))) proto = Object.getPrototypeOf(proto);
  let known = String(d.get.call(node));
  Object.defineProperty(node, prop, {configurable: true, get() { return d.get.call(this); }, set(v) { known = String(v); d.set.call(this, v); }});
  return () => known !== String(node[prop]);
}

test('an edit in the overlay reaches a field as a change its tracker has not seen', async () => {
  const {send} = await page();
  const doc = g.document;
  doc.body.innerHTML = '<input id="t" value="a"><input id="r" type="range" value="5"><input id="c" type="checkbox"><textarea id="n">x</textarea>';
  const news = {};
  for (const [id, prop] of [['t', 'value'], ['r', 'value'], ['c', 'checked'], ['n', 'value']]) {
    const el = doc.getElementById(id), seen = track(el, prop);
    el.addEventListener(prop === 'checked' ? 'click' : 'input', () => { news[id] = seen(); });
  }
  send({type: 'input', selector: '#t', value: 'ab'});
  send({type: 'input', selector: '#r', value: '7'});
  send({type: 'click', selector: '#c', checked: true, button: 0});
  send({type: 'input', selector: '#n', value: 'xy'});
  assert.deepEqual(news, {t: true, r: true, c: true, n: true});
  assert.deepEqual(['t', 'r', 'n'].map(id => doc.getElementById(id).value), ['ab', '7', 'xy']);
  assert.equal(doc.getElementById('c').checked, true);
  assert.equal('oninput' in doc, true, 'React looks for document.oninput to use input events');
  assert.deepEqual(['t', 'r', 'c'].map(id => doc.getElementById(id).type), ['text', 'range', 'checkbox'], 'React takes only known types for text fields');
});

test('React onChange fires for typing, a slider, a checkbox and a textarea', {skip: !reactDir && 'react-dom is not installed in ../cine-blocking'}, async () => {
  const {send} = await page();
  const doc = g.document;
  const load = createRequire(path.join(pnpm, reactDir, 'node_modules/react-dom/package.json'));
  const React = load('react'), {flushSync} = load('react-dom'), {createRoot} = load('react-dom/client');
  const h = React.createElement, log = [];
  function Form() {
    const [t, setT] = React.useState('a'), [r, setR] = React.useState('5'), [c, setC] = React.useState(false), [n, setN] = React.useState('x');
    return h('div', null,
      h('input', {id: 't', value: t, onChange: e => { log.push('t=' + e.target.value); setT(e.target.value); }}),
      h('input', {id: 'r', type: 'range', min: 0, max: 10, value: r, onChange: e => { log.push('r=' + e.target.value); setR(e.target.value); }}),
      h('input', {id: 'c', type: 'checkbox', checked: c, onChange: e => { log.push('c=' + e.target.checked); setC(e.target.checked); }}),
      h('textarea', {id: 'n', value: n, onChange: e => { log.push('n=' + e.target.value); setN(e.target.value); }}));
  }
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const app = createRoot(container);
  flushSync(() => app.render(h(Form)));
  send({type: 'focusin', selector: '#t'});
  send({type: 'input', selector: '#t', value: 'ab'});
  send({type: 'focusout', selector: '#t'});
  send({type: 'input', selector: '#r', value: '7'});
  send({type: 'click', selector: '#c', checked: true, button: 0});
  send({type: 'input', selector: '#n', value: 'xy'});
  await tick();
  assert.deepEqual(log, ['t=ab', 'r=7', 'c=true', 'n=xy']);
  assert.deepEqual(['t', 'r', 'n'].map(id => doc.getElementById(id).value), ['ab', '7', 'xy']);
  assert.equal(doc.getElementById('c').checked, true);
  flushSync(() => app.unmount());
});

test('focus leaving an overlay field leaves the page field too, so keys reach the document again', async () => {
  const {send} = await page();
  const doc = g.document;
  doc.body.innerHTML = '<input id="name"><div id="panel"></div>';
  const keys = [];
  doc.addEventListener('keydown', e => keys.push(e.target.tagName));
  send({type: 'focusin', selector: '#name'});
  assert.equal(doc.activeElement.id, 'name');
  send({type: 'keydown', selector: '#name', key: 'a', code: 'KeyA'});
  send({type: 'focusout', selector: '#name'});
  assert.equal(doc.activeElement, doc.body);
  send({type: 'keydown', key: 'z', code: 'KeyZ', metaKey: true});
  // A key with no element goes to the body even while the page still points at a field that was removed.
  const name = doc.getElementById('name');
  name.focus(); name.remove();
  send({type: 'keydown', key: 'g', code: 'KeyG', metaKey: true});
  assert.deepEqual(keys, ['INPUT', 'BODY', 'BODY']);
});

test('focus the page moves itself is marked for the overlay to follow', async () => {
  await page();
  const doc = g.document;
  doc.body.innerHTML = '<input id="a"><textarea id="b"></textarea>';
  const a = doc.getElementById('a'), b = doc.getElementById('b'), mark = el => el.getAttribute('data-jsgb-focus');
  a.focus();
  assert.equal(mark(a), '');
  b.select();
  assert.deepEqual([mark(a), mark(b), doc.activeElement.id], [null, 'select', 'b']);
  b.blur();
  assert.deepEqual([mark(b), doc.activeElement], [null, doc.body]);
  a.focus(); doc.body.focus();
  assert.equal(mark(a), null, 'focus on the body lets go of the field');
});

test('hover events carry the element the pointer came from or went to', async () => {
  const {send} = await page();
  const doc = g.document;
  doc.body.innerHTML = '<div id="a" data-jsgb="a1"></div><div id="b" data-jsgb="b1"></div>';
  const seen = [];
  doc.addEventListener('pointerout', e => seen.push([e.target.id, e.relatedTarget?.id ?? null]));
  send({type: 'pointerout', id: 'a1', relatedId: 'b1', buttons: 0});
  send({type: 'pointerout', id: 'b1', relatedId: null, buttons: 0});
  assert.deepEqual(seen, [['a', 'b'], ['b', null]]);
});

test('the elements holding the 3D canvas turn transparent in the overlay; panels beside it keep their backgrounds', async () => {
  const {publishUI, published} = await page();
  const doc = g.document;
  doc.body.innerHTML = '<div id="root"><div id="hud">tools</div><div id="view"><div id="wrap"><canvas></canvas></div></div></div>';
  g.__jsgbCanvas = doc.querySelector('canvas');
  publishUI(0);
  const idOf = sel => `[data-jsgb="${doc.querySelector(sel).getAttribute('data-jsgb')}"]`;
  const css = published.at(-1).match(/<style data-jsgb-head>([\s\S]*?)<\/style>/)?.[1] ?? '';
  assert.equal(css, `${['#wrap', '#view', '#root', 'body'].map(idOf).join(',')}{background:transparent!important}`);
  assert.ok(!css.includes(idOf('#hud')));
  g.__jsgbCanvas = null;
  publishUI(0);
  assert.ok(!published.at(-1).includes('background:transparent'), 'no canvas in the page, no holes');
  delete g.__jsgbCanvas;
});
