// IndexedDB's host store under failure (Runtime/src/indexedDbJournal.ts): aborted transactions leave no trace, a crash
// keeps whole transactions only, compaction can be cut off at any write, and large binaries never stall the page. A
// crash is a copy of the host store taken at that moment, booted as the next start.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {bootIdb, completed, done, hostStore, openDb, settle} from './indexed-db-page.mjs';

const stats = g => g.__jsgbIndexedDb.stats();
const aborted = tx => new Promise(resolve => { tx.onabort = () => resolve(tx.error); });
const crash = store => hostStore(new Map(store.map));
async function read(idb, name, store, key) {
  const db = await openDb(idb, name, undefined), tx = db.transaction(store, 'readonly');
  const value = await done(key === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(key));
  db.close();
  return value;
}
const valueKeys = map => [...map].filter(([k, v]) => k.startsWith('indexedDB#val.') && v).map(([k]) => k);

test('an aborted transaction leaves the host store exactly as it was', async () => {
  const store = hostStore();
  let {idb, g} = await bootIdb(store);
  let db = await openDb(idb, 'a', 1, d => { d.createObjectStore('s'); d.createObjectStore('n', {autoIncrement: true}); });
  let tx = db.transaction(['s', 'n'], 'readwrite');
  tx.objectStore('s').put('one', 1);
  tx.objectStore('n').add('first');
  await completed(tx);
  await settle(5);
  const before = new Map(store.map);
  // Aborted by the page after its requests succeeded.
  tx = db.transaction(['s', 'n'], 'readwrite');
  tx.objectStore('s').put('changed', 1);
  tx.objectStore('s').put(new g.Blob([new Uint8Array(100_000)]), 2);
  tx.objectStore('n').add('second');
  await done(tx.objectStore('s').clear());
  tx.abort();
  await aborted(tx);
  // Aborted by a failed request.
  tx = db.transaction('s', 'readwrite');
  tx.objectStore('s').put('x', 3);
  tx.objectStore('s').add('duplicate', 1);
  assert.equal((await aborted(tx)).name, 'ConstraintError');
  // An upgrade the page aborted.
  db.close();
  const request = idb.open('a', 2);
  request.onupgradeneeded = () => { request.result.createObjectStore('extra').put('y', 1); request.transaction.abort(); };
  await assert.rejects(done(request), e => e.name === 'AbortError');
  await settle(5);
  assert.deepEqual(store.map, before);

  ({idb, g} = await bootIdb(store));
  db = await openDb(idb, 'a', 1, () => assert.fail('still version 1'));
  tx = db.transaction(['s', 'n'], 'readwrite');
  assert.deepEqual(await done(tx.objectStore('s').getAll()), ['one']);
  assert.equal(await done(tx.objectStore('n').add('second')), 2, 'the aborted add did not move the key generator');
  // A failed request whose error the page prevents: the rest of the transaction commits.
  const dup = tx.objectStore('s').add('again', 1);
  dup.onerror = e => e.preventDefault();
  tx.objectStore('s').put('three', 3);
  await completed(tx);
  db.close();
  ({idb} = await bootIdb(store));
  assert.deepEqual(await read(idb, 'a', 's'), ['one', 'three']);
});

test('a crash keeps whole transactions only: an entry cut short is as if never written', async () => {
  const store = hostStore();
  let {idb, g} = await bootIdb(store);
  const db = await openDb(idb, 'c', 1, d => d.createObjectStore('s'));
  let tx = db.transaction('s', 'readwrite');
  tx.objectStore('s').put('a', 'a');
  await completed(tx);
  tx = db.transaction('s', 'readwrite');
  tx.objectStore('s').put('b', 'b');
  tx.objectStore('s').put('b2', 'b2');
  await completed(tx);
  const last = `indexedDB#log.${stats(g).journalEntries - 1}`;
  const crashed = crash(store);
  crashed.map.set(last, crashed.map.get(last).slice(0, -7));
  ({idb, g} = await bootIdb(crashed));
  assert.deepEqual(await read(idb, 'c', 's'), ['a']);
  // The next commit takes the damaged entry's place.
  const again = await openDb(idb, 'c', 1);
  tx = again.transaction('s', 'readwrite');
  tx.objectStore('s').put('c', 'c');
  await completed(tx);
  again.close();
  ({idb} = await bootIdb(crash(crashed)));
  assert.deepEqual(await read(idb, 'c', 's'), ['a', 'c']);
});

test('a large value cut off before its entry leaves the database as it was, and its parts are dropped', async () => {
  const store = hostStore();
  let {idb, g} = await bootIdb(store);
  let db = await openDb(idb, 'v', 1, d => d.createObjectStore('s'));
  let tx = db.transaction('s', 'readwrite');
  tx.objectStore('s').put('small', 'x');
  await completed(tx);
  tx = db.transaction('s', 'readwrite');
  tx.objectStore('s').put(new g.Blob([new Uint8Array(5 << 20).fill(3)]), 'big');
  await completed(tx);
  assert.ok(stats(g).queued > 0, 'a large commit is written in slices after its complete event');
  await new Promise(resolve => setTimeout(resolve, 0));
  const crashed = crash(store);
  assert.ok(valueKeys(crashed.map).length > 0, 'the crash came after some of the value was written');
  ({idb, g} = await bootIdb(crashed));
  assert.equal(await read(idb, 'v', 's', 'big'), undefined);
  assert.equal(await read(idb, 'v', 's', 'x'), 'small');
  await settle(5);
  assert.deepEqual(valueKeys(crashed.map), [], 'the stray parts were dropped');
  db = await openDb(idb, 'v', 1);
  tx = db.transaction('s', 'readwrite');
  tx.objectStore('s').put(new g.Blob([new Uint8Array(200_000).fill(4)]), 'later');
  await completed(tx);
  db.close();
  ({idb} = await bootIdb(crash(crashed)));
  assert.deepEqual(new Uint8Array(await (await read(idb, 'v', 's', 'later')).arrayBuffer()), new Uint8Array(200_000).fill(4));
});

test('compaction: a snapshot replaces the journal, unused values go, and a crash at any write keeps everything', async () => {
  const store = hostStore();
  let {idb, g} = await bootIdb(store);
  let db = await openDb(idb, 'k', 1, d => d.createObjectStore('s'));
  for (let i = 0; i < 600; i++) {
    const tx = db.transaction('s', 'readwrite');
    tx.objectStore('s').put({i, text: 'record ' + i}, i);
    await completed(tx);
  }
  await settle(100);
  assert.ok(stats(g).generation >= 1, 'the journal was compacted on its own');
  assert.ok(stats(g).journalEntries < 600);
  let tx = db.transaction('s', 'readwrite');
  tx.objectStore('s').put(new g.Blob([new Uint8Array(300_000).fill(1)]), 'blob');
  await completed(tx);
  const blobKeys = valueKeys(store.map);
  assert.ok(blobKeys.length > 0);
  tx = db.transaction('s', 'readwrite');
  tx.objectStore('s').delete('blob');
  tx.objectStore('s').put('kept', 'last');
  await completed(tx);
  const before = new Map(store.map), gen = stats(g).generation;
  g.__jsgbIndexedDb.compact();
  const after = new Map(store.map);
  assert.equal(stats(g).generation, gen + 1);
  await settle(20);
  assert.deepEqual(valueKeys(store.map), [], 'the deleted blob is gone from the store');
  db.close();

  const check = async (map, label) => {
    ({idb} = await bootIdb(hostStore(new Map(map))));
    const rows = await read(idb, 'k', 's');
    assert.equal(rows.length, 601, label);
    assert.equal(await read(idb, 'k', 's', 'last'), 'kept', label);
    assert.equal(await read(idb, 'k', 's', 'blob'), undefined, label);
  };
  const head = `indexedDB#head.${(gen + 1) % 2}`;
  await check(store.map, 'after compaction and clean-up');
  await check(new Map([...after, [head, after.get(head).slice(0, 20)]]), 'a crash while the new head was written');
  await check(new Map([...after, [head, before.get(head) ?? '']]), 'a crash before the new head was written');
  // A quit right after compaction, before the clean-up turns ran: the next start finishes the clean-up.
  const quit = hostStore(new Map(after));
  assert.ok(valueKeys(quit.map).length > 0);
  await bootIdb(quit);
  await settle(20);
  assert.deepEqual(valueKeys(quit.map), [], 'the next start dropped what the compaction left behind');
  assert.ok(![...quit.map].some(([k, v]) => /^indexedDB#log\./.test(k) && v), 'and blanked the old journal');
});

test('large and many: a 20 MB Blob and thousands of records never hold the page for long', async () => {
  const store = hostStore();
  let {idb, g} = await bootIdb(store);
  // A heartbeat on every turn of the event loop: the longest gap between beats is the longest the page was held,
  // timer callbacks and promise jobs alike.
  let longest = 0, last = performance.now(), beating = true;
  const beat = () => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; if (beating) setImmediate(beat); };
  setImmediate(beat);
  try {
    const db = await openDb(idb, 'big', 1, d => d.createObjectStore('s'));
    const bytes = new Uint8Array(20 << 20);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i >> 12;
    let t0 = last = performance.now();
    longest = 0;
    let tx = db.transaction('s', 'readwrite');
    tx.objectStore('s').put(new g.Blob([bytes], {type: 'video/mp4'}), 'clip');
    await completed(tx);
    const completeMs = performance.now() - t0;
    while (stats(g).queued) await settle(0);
    const writtenMs = performance.now() - t0, blobLongest = longest;
    longest = 0; t0 = last = performance.now();
    tx = db.transaction('s', 'readwrite');
    for (let i = 0; i < 10_000; i++) tx.objectStore('s').put({i, name: 'row ' + i, tags: ['a', 'b'], at: i * 3}, 'row' + i);
    await completed(tx);
    const manyMs = performance.now() - t0, manyLongest = longest;
    longest = 0; t0 = last = performance.now();
    for (let i = 0; i < 1000; i++) { const t = db.transaction('s', 'readwrite'); t.objectStore('s').put(i, 'single' + i); await completed(t); }
    const singlesMs = performance.now() - t0, singlesLongest = longest;
    db.close();
    // The journal is now due for compaction: it runs in an idle turn of this page. (Every runtime in this process shares
    // one global object, so it has to be done before the next start replaces the page's classes.)
    longest = 0; last = performance.now();
    await settle(150);
    const compactLongest = longest;
    assert.ok(stats(g).generation >= 1);
    t0 = performance.now();
    ({idb, g} = await bootIdb(crash(store)));
    const bootMs = performance.now() - t0;
    t0 = last = performance.now(); longest = 0;
    const clip = await read(idb, 'big', 's', 'clip');
    const back = new Uint8Array(await clip.arrayBuffer());
    const readMs = performance.now() - t0, readLongest = longest;
    assert.equal(clip.type, 'video/mp4');
    assert.equal(Buffer.compare(Buffer.from(back), Buffer.from(bytes)), 0);
    assert.equal((await read(idb, 'big', 's', 'row9999')).name, 'row 9999');
    assert.equal(await read(idb, 'big', 's', 'single999'), 999);
    const f = v => v.toFixed(1);
    console.log(`20 MB Blob: complete after ${f(completeMs)} ms, on disk after ${f(writtenMs)} ms, longest task ${f(blobLongest)} ms; `
      + `10,000 records in one transaction: ${f(manyMs)} ms, longest task ${f(manyLongest)} ms; 1,000 single-record transactions: ${f(singlesMs)} ms, `
      + `longest task ${f(singlesLongest)} ms; compaction ${f(compactLongest)} ms; restart ${f(bootMs)} ms; first read of the 20 MB Blob ${f(readMs)} ms, longest task ${f(readLongest)} ms`);
    assert.ok(blobLongest < 250, `writing a 20 MB Blob held the page ${f(blobLongest)} ms`);
    assert.ok(readLongest < 250, `reading a 20 MB Blob held the page ${f(readLongest)} ms`);
  } finally { beating = false; }
});

test('strict durability writes before the complete event, and a reload writes whatever is still queued', async () => {
  const store = hostStore();
  let {idb, g, page} = await bootIdb(store);
  const db = await openDb(idb, 'd', 1, d => d.createObjectStore('s'));
  let tx = db.transaction('s', 'readwrite', {durability: 'strict'});
  tx.objectStore('s').put(new g.Blob([new Uint8Array(3 << 20).fill(7)]), 'strict');
  let queuedAtComplete = -1;
  tx.addEventListener('complete', () => { queuedAtComplete = stats(g).queued; });
  await completed(tx);
  assert.equal(queuedAtComplete, 0);
  tx = db.transaction('s', 'readwrite');
  tx.objectStore('s').put(new g.Blob([new Uint8Array(3 << 20).fill(8)]), 'relaxed');
  await completed(tx);
  assert.ok(stats(g).queued > 0);
  page.flushStorage();
  assert.equal(stats(g).queued, 0);
  ({idb} = await bootIdb(crash(store)));
  assert.equal((await read(idb, 'd', 's', 'relaxed')).size, 3 << 20);
  assert.equal((await read(idb, 'd', 's', 'strict')).size, 3 << 20);
});
