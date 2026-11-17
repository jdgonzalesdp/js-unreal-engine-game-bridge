// The page's address (Runtime/src/location.ts) and the browser pieces a sign-in leans on: location and history under a
// configured origin, navigation that restarts the page or opens the system browser, links, document.cookie,
// navigator.locks and the runtime's URL.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bootPage, restarted, stubHost, tick} from './browser-page.mjs';

const g = globalThis;

test('location follows the configured origin and the start address', async () => {
  const {host} = stubHost({origin: 'http://localhost:5180', path: '/scenes/4', search: '?x=1'});
  await bootPage(host);
  assert.equal(g.location.href, 'http://localhost:5180/scenes/4?x=1');
  assert.deepEqual([g.location.origin, g.location.host, g.location.hostname, g.location.port], ['http://localhost:5180', 'localhost:5180', 'localhost', '5180']);
  assert.deepEqual([g.location.pathname, g.location.search, g.location.hash], ['/scenes/4', '?x=1', '']);
  assert.equal(g.document.baseURI, g.location.href);
  assert.equal(g.document.URL, g.location.href);
  assert.equal(g.origin, 'http://localhost:5180');
  const plain = stubHost({search: '?play'});
  await bootPage(plain.host);
  assert.equal(g.location.href, 'http://localhost/?play', 'a game without an origin keeps the old address');
});

test('pushState and replaceState move the address in place and tell the host', async () => {
  const {host, seen} = stubHost({origin: 'http://localhost:5180'});
  await bootPage(host);
  g.history.pushState({at: 5}, '', '/scenes/5?y=2');
  assert.deepEqual([g.location.pathname, g.location.search, g.history.length], ['/scenes/5', '?y=2', 2]);
  assert.deepEqual(g.history.state, {at: 5});
  g.history.replaceState({}, '', 'http://localhost:5180/auth/callback');
  assert.equal(g.location.href, 'http://localhost:5180/auth/callback');
  assert.deepEqual(seen.addresses, ['/scenes/5?y=2', '/auth/callback']);
  assert.equal(seen.reloads, 0);
  assert.throws(() => g.history.pushState(null, '', 'https://example.com/'), /not on http:\/\/localhost:5180/);
  const pops = [];
  g.addEventListener('popstate', e => pops.push(e.state));
  g.history.back();
  assert.equal(g.location.pathname, '/');
  await tick();
  assert.deepEqual(pops, [null]);
  assert.equal(seen.reloads, 0);
});

test('a new hash stays on the page', async () => {
  const {host, seen} = stubHost({origin: 'http://localhost:5180', path: '/a'});
  await bootPage(host);
  const changes = [];
  g.addEventListener('hashchange', e => changes.push(e.newURL));
  g.location.hash = 'top';
  g.location.href = '#features';
  assert.equal(g.location.hash, '#features');
  await tick();
  assert.deepEqual(changes, ['http://localhost:5180/a#top', 'http://localhost:5180/a#features']);
  assert.equal(seen.reloads, 0);
});

test('another path on the same origin restarts the page there, with storage saved first', async () => {
  const {host, seen, store} = stubHost({origin: 'http://localhost:5180'});
  await bootPage(host);
  g.localStorage.setItem('saved', 'yes');
  g.location.assign('/legal/terms.html?from=menu');
  assert.equal(seen.reloads, 0, 'the page hears it is leaving and finishes its writes first');
  await restarted(seen, 1);
  assert.equal(seen.reloads, 1);
  assert.equal(seen.addresses.at(-1), '/legal/terms.html?from=menu');
  assert.equal(store.get('localStorage#saved'), '"yes"', 'written before the restart, not 250 ms later');
  // Stored items are properties too, as in a browser (auth0-spa-js lists its cache with Object.keys(localStorage)).
  g.localStorage.theme = 'dark';
  assert.deepEqual(Object.keys(g.localStorage), ['saved', 'theme']);
  delete g.localStorage.saved;
  assert.deepEqual([g.localStorage.getItem('saved'), 'theme' in g.localStorage, g.localStorage.length], [null, true, 1]);
  g.location.reload();
  await restarted(seen, 2);
  assert.deepEqual([seen.reloads, seen.addresses.at(-1)], [2, '/']);
  g.location = '/scenes/9';
  await restarted(seen, 3);
  assert.deepEqual([seen.reloads, seen.addresses.at(-1), typeof g.location.assign], [3, '/scenes/9', 'function']);
});

test('another origin opens in the system browser and the page stays', async () => {
  const {host, seen, store} = stubHost({origin: 'http://localhost:5180', path: '/editor'});
  await bootPage(host);
  g.sessionStorage.setItem('a0.spajs.txs.client', '{"state":"s"}');
  g.location.assign('https://auth.prechecklist.com/authorize?client_id=c&state=s');
  assert.deepEqual(seen.opened, ['https://auth.prechecklist.com/authorize?client_id=c&state=s']);
  assert.ok(store.has('sessionStorage#a0.spajs.txs.client'), 'the pending sign-in is saved before the browser opens');
  const win = g.open('https://prepvis.com/download', '_blank');
  assert.equal(seen.opened[1], 'https://prepvis.com/download');
  assert.equal(win.closed, false);
  assert.equal(g.open('/second-tab'), null);
  g.location.assign('//cdn.example.com/file.zip');
  assert.equal(seen.opened[2], 'http://cdn.example.com/file.zip', 'a scheme-relative URL takes the page scheme');
  g.location.href = 'mailto:support@example.com';
  assert.equal(seen.opened.length, 3, 'only http and https leave the game');
  assert.deepEqual([seen.reloads, g.location.pathname], [0, '/editor']);
});

test('a click on a link follows it unless the page cancels it', async () => {
  const {host, seen} = stubHost({origin: 'http://localhost:5180'});
  const page = await bootPage(host);
  g.document.body.innerHTML = '<a id="out" href="https://example.com/x"><span id="inner">Download</span></a><a id="hash" href="#pricing">Pricing</a><a id="kept" href="https://example.com/kept">Kept</a>';
  page.uiInput(JSON.stringify({type: 'click', selector: '#inner', button: 0}));
  assert.deepEqual(seen.opened, ['https://example.com/x']);
  page.uiInput(JSON.stringify({type: 'click', selector: '#hash', button: 0}));
  assert.equal(g.location.hash, '#pricing');
  g.document.querySelector('#kept').addEventListener('click', e => e.preventDefault());
  page.uiInput(JSON.stringify({type: 'click', selector: '#kept', button: 0}));
  assert.equal(seen.opened.length, 1);
});

test('the host brings the page back to a callback address on its own origin only', async () => {
  const {host, seen} = stubHost({origin: 'http://localhost:5180'});
  const page = await bootPage(host);
  assert.equal(page.navigateTo('/auth/callback?code=abc&state=x%2By%3D'), true);
  await restarted(seen, 1);
  assert.deepEqual([seen.reloads, seen.addresses.at(-1)], [1, '/auth/callback?code=abc&state=x%2By%3D']);
  assert.equal(page.navigateTo('https://example.com/auth/callback?code=abc'), false);
  assert.equal(seen.reloads, 1);
});

test("the runtime's URL ties searchParams to the URL and takes a new href", async () => {
  await bootPage(stubHost({origin: 'http://localhost:5180'}).host);
  assert.doesNotMatch(Function.prototype.toString.call(g.URL), /native code/, 'the runtime URL, as in Unreal');
  const url = new g.URL('http://localhost:5180/?app=signin&scene=4#x');
  url.searchParams.delete('app');
  assert.equal(url.href, 'http://localhost:5180/?scene=4#x');
  url.searchParams.set('code', 'a b');
  assert.equal(url.search, '?scene=4&code=a%20b');
  url.href = 'https://auth.example.com/authorize?state=1';
  assert.deepEqual([url.hostname, url.pathname, url.searchParams.get('state')], ['auth.example.com', '/authorize', '1']);
});

test('document.cookie keeps cookies across a restart and drops expired ones', async () => {
  const store = new Map();
  await bootPage(stubHost({origin: 'http://localhost:5180', store}).host);
  const future = new Date(Date.now() + 86400e3).toUTCString();
  g.document.cookie = `auth0.c.is.authenticated=true; expires=${future}; path=/`;
  g.document.cookie = 'theme=dark';
  g.document.cookie = 'gone=1; max-age=0';
  assert.equal(g.document.cookie, 'auth0.c.is.authenticated=true; theme=dark');
  await bootPage(stubHost({origin: 'http://localhost:5180', store}).host);
  assert.equal(g.document.cookie, 'auth0.c.is.authenticated=true; theme=dark');
  g.document.cookie = 'auth0.c.is.authenticated=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  assert.equal(g.document.cookie, 'theme=dark');
});

test('navigator.locks runs requests for one name one after the other', async () => {
  await bootPage(stubHost().host);
  const order = [];
  let release;
  const first = g.navigator.locks.request('token', async () => { order.push('first'); await new Promise(r => { release = r; }); order.push('first done'); });
  const second = g.navigator.locks.request('token', {mode: 'exclusive'}, async lock => { order.push('second ' + lock.name); });
  assert.equal(await g.navigator.locks.request('token', {ifAvailable: true}, lock => lock), null);
  const controller = new g.AbortController();
  const third = g.navigator.locks.request('token', {signal: controller.signal}, () => order.push('third'));
  controller.abort();
  await assert.rejects(third, e => e.name === 'AbortError');
  await tick();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'first done', 'second token']);
});
