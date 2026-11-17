// IndexedDB's host store when things go wrong (Runtime/src/indexedDbJournal.ts): a database deleted under a write, a
// host store that refuses writes for a while, a value that can't be kept, entries lost to an OS crash, and a damaged
// newest snapshot. A crash is a copy of the host store taken at that moment, booted as the next start.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bootIdb, completed, done, hostStore, openDb, settle} from './indexed-db-page.mjs';
import {checksum} from '../../Runtime/src/indexedDbFiles';

const stats = g => g.__jsgbIndexedDb.stats();
const crash = store => hostStore(new Map(store.map));
const keysOf = async (idb, name) => {
  const db = await openDb(idb, name, undefined);
  const keys = await done(db.transaction('s', 'readonly').objectStore('s').getAllKeys());
  db.close();
  return keys;
};
const ended = tx => new Promise(resolve => { tx.oncomplete = () => resolve('complete'); tx.onabort = () => resolve(`abort ${tx.error?.name}`); });

test('a write that lands after its database was deleted is not kept, and the next start still has IndexedDB', async () => {
  const store = hostStore();
  let {idb, logs} = await bootIdb(store);
  // A connection that closes on versionchange (a local repository does this) counts as closed at once, so the
  // deleteDatabase goes first and the transaction already under way commits after it.
  const db = await openDb(idb, 'race', 1, d => d.createObjectStore('s'));
  db.onversionchange = () => db.close();
  const tx = db.transaction('s', 'readwrite');
  for (let i = 0; i < 5; i++) tx.objectStore('s').put('v' + i, 'k' + i);
  const order = [];
  idb.deleteDatabase('race').onsuccess = () => order.push('deleted');
  order.push(await ended(tx));
  await settle(10);
  assert.deepEqual(order, ['deleted', 'complete'], 'the race this test is about');
  const second = crash(store);
  ({idb, logs} = await bootIdb(second));
  assert.equal(typeof idb, 'object', 'IndexedDB is there');
  assert.deepEqual((await idb.databases()).map(d => d.name), []);
  assert.deepEqual(logs.filter(l => l.startsWith('error')), []);
  // Deleted and made again at once: the old connection's write does not reach the new database.
  const old = await openDb(idb, 'again', 1, d => d.createObjectStore('s'));
  old.onversionchange = () => old.close();
  const late = old.transaction('s', 'readwrite');
  for (let i = 0; i < 5; i++) late.objectStore('s').put('stale write', 'k' + i);
  const steps = [];
  idb.deleteDatabase('again').onsuccess = () => steps.push('deleted');
  const lateEnd = ended(late).then(r => steps.push(r));
  const fresh = await openDb(idb, 'again', 1, d => d.createObjectStore('s'));
  await lateEnd;
  await settle(10);
  assert.deepEqual(steps, ['deleted', 'complete']);
  assert.deepEqual(await done(fresh.transaction('s').objectStore('s').getAllKeys()), []);
  fresh.close();
  ({idb} = await bootIdb(crash(second)));
  assert.deepEqual(await keysOf(idb, 'again'), []);
});

test('a journal entry naming a database deleted before it is skipped at start, not fatal', async () => {
  const store = hostStore();
  let {idb, g} = await bootIdb(store);
  const db = await openDb(idb, 'gone', 1, d => d.createObjectStore('s'));
  const tx = db.transaction('s', 'readwrite');
  tx.objectStore('s').put('x', 'k');
  await completed(tx);
  db.close();
  await done(idb.deleteDatabase('gone'));
  // What an earlier build wrote for the race: the drop, then a write to the dropped database.
  const n = stats(g).journalEntries, gen = stats(g).generation;
  const write = store.map.get(`indexedDB#log.${n - 2}`);
  assert.match(write, /"t":"w"/);
  const body = write.slice(write.indexOf('\n') + 1), head = `L ${gen} ${n}`;
  store.map.set(`indexedDB#log.${n}`, `${head} ${checksum(head, '\n', body)}\n${body}`);
  let logs;
  ({idb, logs} = await bootIdb(crash(store)));
  assert.equal(typeof idb, 'object');
  assert.ok(logs.some(l => /deleted before it; skipped/.test(l)), logs.join('\n'));
});

test('a host store that refuses writes for a while: later commits wait in order, then all of them are written', async () => {
  const store = hostStore();
  let {idb, g, logs} = await bootIdb(store);
  const db = await openDb(idb, 'jam', 1, d => d.createObjectStore('s'));
  const save = store.storage.save;
  let refusing = true;
  store.storage.save = (k, v) => { if (refusing && k.startsWith('indexedDB#log.')) throw new Error('disk full'); save(k, v); };
  for (let i = 0; i < 3; i++) {
    const tx = db.transaction('s', 'readwrite');
    tx.objectStore('s').put('edit ' + i, 'doc');
    tx.objectStore('s').put(i, 'n' + i);
    await completed(tx);
  }
  assert.equal(stats(g).queued, 3, 'nothing was skipped');
  assert.equal(logs.filter(l => /write to the host store failed/.test(l)).length, 1, 'reported once, not per try');
  refusing = false;
  for (let i = 0; i < 300 && stats(g).queued; i++) await settle(10);
  assert.equal(stats(g).queued, 0, 'the queue moved again on its own');
  assert.ok(logs.some(l => /work again/.test(l)));
  db.close();
  ({idb} = await bootIdb(crash(store)));
  assert.deepEqual(await keysOf(idb, 'jam'), ['doc', 'n0', 'n1', 'n2']);
  const again = await openDb(idb, 'jam', 1);
  assert.equal(await done(again.transaction('s', 'readonly').objectStore('s').get('doc')), 'edit 2');
  again.close();
});

test('a commit that can\'t be kept aborts with UnknownError, and the queue goes on', async () => {
  const store = hostStore();
  let {idb, g} = await bootIdb(store);
  const db = await openDb(idb, 'bad', 1, d => d.createObjectStore('s'));
  // A Blob (instanceof) whose bytes can't be read synchronously, large enough to be stored apart: read at commit.
  const odd = Object.create(g.Blob.prototype);
  Object.defineProperty(odd, 'size', {value: 100_000});
  let tx = db.transaction('s', 'readwrite');
  tx.objectStore('s').put('before', 'doc');
  tx.objectStore('s').put(odd, 'thumb');
  assert.equal(await ended(tx), 'abort UnknownError', 'the page keeps its unsaved state');
  assert.equal(await done(db.transaction('s').objectStore('s').get('doc')), undefined, 'rolled back in memory too');
  // A small one fails its own put: the page prevents the error and commits the rest, without the failed record.
  tx = db.transaction('s', 'readwrite');
  const small = Object.create(g.Blob.prototype);
  Object.defineProperty(small, 'size', {value: 100});
  const req = tx.objectStore('s').put(small, 'tiny');
  req.onerror = e => e.preventDefault();
  tx.objectStore('s').put('edit 2', 'doc');
  assert.equal(await ended(tx), 'complete');
  assert.equal(req.error?.name, 'DataCloneError');
  assert.deepEqual(await done(db.transaction('s').objectStore('s').getAllKeys()), ['doc']);
  assert.equal(stats(g).queued, 0);
  db.close();
  ({idb} = await bootIdb(crash(store)));
  assert.deepEqual(await keysOf(idb, 'bad'), ['doc']);
});

test('a commit of plain records over 2 MB is on disk before its complete event', async () => {
  const store = hostStore();
  const {idb, g} = await bootIdb(store);
  const db = await openDb(idb, 'big', 1, d => d.createObjectStore('s'));
  const tx = db.transaction('s', 'readwrite');
  for (let i = 0; i < 250; i++) tx.objectStore('s').put({shapes: Array.from({length: 300}, (_, k) => ({id: 'sh' + k, x: k, label: 'Prop ' + k}))}, 'scene:' + i);
  let queuedAtComplete = -1;
  tx.addEventListener('complete', () => { queuedAtComplete = stats(g).queued; });
  await completed(tx);
  assert.ok(stats(g).journalChars > 2 << 20);
  assert.equal(queuedAtComplete, 0);
});

test('journal entries past one an OS crash lost are removed, so they never replay after newer ones', async () => {
  const store = hostStore();
  let {idb} = await bootIdb(store);
  let db = await openDb(idb, 'gap', 1, d => d.createObjectStore('s'));
  const put = async (k, v) => { const tx = db.transaction('s', 'readwrite'); tx.objectStore('s').put(v, k); await completed(tx); };
  await put('a', 1); await put('b', 2); await put('c', 3); await put('x', 'never seen by the next start');
  db.close();
  // log.2 (b) was lost: no fsync, so a later file can outlive an earlier one.
  store.map.set('indexedDB#log.2', store.map.get('indexedDB#log.2').slice(0, 20));
  ({idb} = await bootIdb(store));
  assert.deepEqual(await keysOf(idb, 'gap'), ['a']);
  db = await openDb(idb, 'gap', 1);
  await put('d', 4); await put('e', 5);
  db.close();
  ({idb} = await bootIdb(crash(store)));
  assert.deepEqual(await keysOf(idb, 'gap'), ['a', 'd', 'e'], 'as the page left it');
});

test('a damaged newest snapshot falls back only while the journal before it is whole', async () => {
  const store = hostStore();
  const {idb, g} = await bootIdb(store);
  const db = await openDb(idb, 'c', 1, d => d.createObjectStore('s'));
  const put = async k => { const tx = db.transaction('s', 'readwrite'); tx.objectStore('s').put('v' + k, k); await completed(tx); };
  await put(1);
  g.__jsgbIndexedDb.compact();
  await settle(10);
  for (let i = 2; i <= 6; i++) await put(i);
  g.__jsgbIndexedDb.compact();
  const gen = stats(g).generation, part = `indexedDB#snap.${gen % 2}.0`;
  const damaged = map => { const m = new Map(map); m.set(part, m.get(part).slice(0, 40)); return hostStore(m); };
  // Before the clean-up turns ran, the older generation's journal is all there: falling back to it loses nothing.
  let next = await bootIdb(damaged(store.map));
  assert.deepEqual(await keysOf(next.idb, 'c'), [1, 2, 3, 4, 5, 6]);
  // After clean-up (and once newer commits reuse its entries) it is not: the store is left alone, and IndexedDB off.
  await settle(20);
  next = await bootIdb(damaged(store.map));
  assert.equal(next.idb, undefined);
  assert.ok(next.logs.some(l => /journal before it is gone/.test(l)), next.logs.join('\n'));
});
