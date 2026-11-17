// The page features pageApis.ts and cacheStorage.ts add: the Cache API kept in the host's store, FontFace and
// document.fonts reaching the overlay through a blob URL, IntersectionObserver over the overlay's layout reports, and
// <form> elements with their methods.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stubHost} from './browser-page.mjs';
import {bootPlatform} from './platform-apis-page.mjs';

const g = globalThis;
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

test('caches keep a response across page starts, in parts, and drop one whose parts are damaged', async () => {
  const store = new Map();
  await bootPlatform({host: stubHost({origin: 'http://localhost:5180', store}).host});
  const big = new Uint8Array(1300 * 1024).map((_, i) => i * 7);
  const url = 'https://api.prepvis.com/api/v1/body-rig/face-landmarks/face_landmarker.task?v=3';
  let cache = await g.caches.open('face-landmarks');
  assert.equal(await cache.match(url), undefined);
  await cache.put(url, new g.Response(big, {headers: {'content-type': 'application/octet-stream', etag: 'w1'}}).clone());
  await cache.put('https://api.prepvis.com/small.js', new g.Response('console.log(1)', {headers: {'content-type': 'text/javascript'}}));
  assert.equal([...store.keys()].filter(k => k.startsWith('caches#body.')).length, 4);
  // A new start of the page reads it back from the store.
  await bootPlatform({host: stubHost({origin: 'http://localhost:5180', store}).host});
  assert.deepEqual(await g.caches.keys(), ['face-landmarks']);
  cache = await g.caches.open('face-landmarks');
  const kept = await cache.match(new g.Request(url));
  assert.ok(kept);
  assert.equal(kept.headers.get('etag'), 'w1');
  assert.deepEqual(new Uint8Array(await kept.arrayBuffer()), big);
  assert.equal(await (await g.caches.match('https://api.prepvis.com/small.js')).text(), 'console.log(1)');
  assert.ok(await cache.match('https://api.prepvis.com/small.js?x=1', {ignoreSearch: true}));
  assert.deepEqual((await cache.keys()).map(r => r.url), [url, 'https://api.prepvis.com/small.js']);
  await assert.rejects(cache.put(new g.Request(url, {method: 'POST'}), new g.Response('x')), TypeError);
  // A part cut short: the entry is treated as missing, not as damaged bytes.
  const part = [...store.keys()].find(k => k.startsWith('caches#body.') && k.endsWith('.1'));
  store.set(part, store.get(part).slice(0, 100));
  assert.equal(await cache.match(url), undefined);
  assert.equal(await cache.delete('https://api.prepvis.com/small.js'), true);
  assert.equal(await g.caches.delete('face-landmarks'), true);
  assert.deepEqual(await g.caches.keys(), []);
  assert.equal([...store.entries()].filter(([k, v]) => k.startsWith('caches#body.') && v).length, 0);
});

test('A FontFace loads through the runtime and reaches the overlay as an @font-face rule with a blob URL', async () => {
  const font = new Uint8Array([0, 1, 0, 0, 0, 12, 0, 128, 0, 3, 0, 64, 1, 2, 3, 4]);
  const {host} = stubHost({origin: 'http://localhost:5180'});
  host.readFile = path => path === '/fonts/text/Inter-Regular.ttf' ? font.slice().buffer : path === '/fonts/text/notafont.ttf' ? new Uint8Array(32).buffer : null;
  const published = [];
  host.ui = {publish: html => published.push(html)};
  const {publishUI} = await bootPlatform({host});
  const fonts = g.document.fonts;
  const events = [];
  fonts.addEventListener('loadingdone', e => events.push(['done', e.fontfaces.length]));
  const face = new g.FontFace('pv-text-builtin-sans-regular', `url(${JSON.stringify('http://localhost:5180/fonts/text/Inter-Regular.ttf')})`);
  assert.equal(face.status, 'unloaded');
  assert.equal(fonts.check('16px "pv-text-builtin-sans-regular"'), true);
  const loaded = face.load();
  assert.equal(face.status, 'loading');
  assert.equal(await loaded, face);
  fonts.add(face);
  assert.equal(face.status, 'loaded');
  assert.ok(fonts.has(face));
  assert.equal(fonts.check('16px "pv-text-builtin-sans-regular", sans-serif'), true);
  assert.deepEqual(await fonts.load('16px pv-text-builtin-sans-regular'), [face]);
  const rule = g.document.head.querySelector('style[data-jsgb-fonts]').textContent;
  assert.match(rule, /@font-face\{font-family:"pv-text-builtin-sans-regular";src:url\("blob:[^"]+"\)\}/);
  publishUI(0);
  assert.match(published.at(-1), /src:url\("\/bridge\/blob\/[^"]+"\)/);
  // A file that isn't a font, and one that isn't there, fail as a browser's do; ready waits for them.
  const bad = new g.FontFace('Bad', 'url(/fonts/text/notafont.ttf)'), gone = new g.FontFace('Gone', 'url(/fonts/text/none.ttf)');
  fonts.add(bad); fonts.add(gone);
  assert.equal(fonts.status, 'loading');
  assert.equal(fonts.check('12px Bad'), false);
  await assert.rejects(bad.loaded, e => e.name === 'NetworkError');
  await assert.rejects(gone.loaded, e => e.name === 'NetworkError');
  assert.equal(await fonts.ready, fonts);
  assert.equal(fonts.status, 'loaded');
  assert.ok(events.length >= 1);
  assert.throws(() => fonts.check('Bad'), e => e.name === 'SyntaxError');
  const fromBytes = new g.FontFace('Bytes', font.buffer, {weight: '700'});
  await fromBytes.loaded;
  fonts.add(fromBytes);
  assert.match(g.document.head.querySelector('style[data-jsgb-fonts]').textContent, /font-family:"Bytes";src:url\("blob:[^"]+"\);font-weight:700/);
});

test('IntersectionObserver follows the overlay\'s layout: viewport, clipping ancestors, root margins and thresholds', async () => {
  const {uiInput} = await bootPlatform();
  const doc = g.document;
  const list = doc.createElement('div'); list.setAttribute('data-jsgb', 'list'); list.style.overflowY = 'auto';
  const rows = [0, 1, 2, 3].map(i => { const r = doc.createElement('button'); r.setAttribute('data-jsgb', 'row' + i); list.appendChild(r); return r; });
  doc.body.appendChild(list);
  const layout = (top, rects = {}) => uiInput(JSON.stringify({type: 'host-layout', width: 800, height: 600, rects: {
    list: {x: 0, y: 100, width: 200, height: 100}, ...Object.fromEntries(rows.map((r, i) => ['row' + i, {x: 0, y: top + i * 60, width: 200, height: 40}])), ...rects}}));
  layout(100);
  const seen = [];
  const io = new g.IntersectionObserver(entries => { for (const e of entries) seen.push([e.target.getAttribute('data-jsgb'), e.isIntersecting, Math.round(e.intersectionRatio * 100)]); });
  rows.forEach(r => io.observe(r));
  await tick(5);
  // Rows 0 and 1 are inside the list's box; rows 2 and 3 are below it, clipped although still in the viewport.
  assert.deepEqual(seen, [['row0', true, 100], ['row1', true, 100], ['row2', false, 0], ['row3', false, 0]]);
  seen.length = 0;
  layout(-20);
  await tick(5);
  assert.deepEqual(seen, [['row0', false, 0], ['row1', false, 0], ['row2', true, 100], ['row3', true, 100]]);
  seen.length = 0;
  layout(-20);
  await tick(5);
  assert.deepEqual(seen, [], 'nothing changed, nothing reported');
  io.disconnect();
  // A root margin like the documentation page's: only the band near the top counts.
  const heads = [0, 1].map(i => { const h = doc.createElement('h2'); h.setAttribute('data-jsgb', 'h' + i); doc.body.appendChild(h); return h; });
  layout(100, {h0: {x: 0, y: 90, width: 300, height: 20}, h1: {x: 0, y: 400, width: 300, height: 20}});
  const band = [];
  const doc2 = new g.IntersectionObserver(es => es.forEach(e => band.push([e.target.getAttribute('data-jsgb'), e.isIntersecting])), {rootMargin: '-80px 0px -70% 0px', threshold: 0});
  heads.forEach(h => doc2.observe(h));
  await tick(5);
  assert.deepEqual(band, [['h0', true], ['h1', false]]);
  const halves = [];
  const half = new g.IntersectionObserver(es => es.forEach(e => halves.push(e.intersectionRatio)), {threshold: [0, 0.5, 1]});
  half.observe(rows[1]);
  await tick(5);
  layout(130);
  await tick(5);
  assert.deepEqual(halves.map(r => Math.round(r * 100)), [100, 25]);
  assert.throws(() => new g.IntersectionObserver(() => {}, {rootMargin: '10'}), e => e.name === 'SyntaxError');
  assert.throws(() => new g.IntersectionObserver(() => {}, {threshold: 2}), RangeError);
});

test('Forms are HTMLFormElements: requestSubmit validates and submits, elements finds fields', async () => {
  await bootPlatform();
  const doc = g.document;
  // An earlier boot's classes stay on the global (they are not removed between boots), so the class is checked by name.
  const isForm = el => Object.getPrototypeOf(el).constructor.name === 'HTMLFormElement' && typeof el.requestSubmit === 'function';
  assert.ok(isForm(doc.createElement('form')));
  const host = doc.createElement('div');
  host.innerHTML = '<form id="cast"><input name="who" required><button type="submit" id="go">Add</button><button type="button" id="other">x</button></form>';
  doc.body.appendChild(host);
  const form = doc.getElementById('cast');
  assert.ok(isForm(form));
  assert.ok(isForm(form.cloneNode(true)));
  const events = [];
  form.addEventListener('submit', e => { e.preventDefault(); events.push('submit ' + (e.submitter?.id ?? '')); });
  form.elements.who.addEventListener('invalid', () => events.push('invalid'));
  assert.equal(form.elements.length, 3);
  assert.equal(form.length, 3);
  assert.equal(form.checkValidity(), false);
  form.requestSubmit();
  assert.deepEqual(events, ['invalid', 'invalid']);
  form.elements.who.value = 'Ana';
  form.requestSubmit(doc.getElementById('go'));
  assert.deepEqual(events.slice(2), ['submit go']);
  assert.throws(() => form.requestSubmit(doc.getElementById('other')), TypeError);
  form.elements.who.value = '';
  form.noValidate = true;
  form.requestSubmit();
  assert.equal(events.at(-1), 'submit ');
});
