// IndexedDB on the runtime (Runtime/src/indexedDb.ts): the API a web app uses, and everything it stored coming back
// after a restart. Each start is a fresh runtime over the same host store, as each Unreal restart is.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bootIdb, completed, done, hostStore, openDb} from './indexed-db-page.mjs';

const names = rows => rows.map(r => r.name);

test('versions, upgrades, indexes, cursors, key ranges and auto-increment keys survive a restart', async () => {
  const store = hostStore();
  let {idb, g} = await bootIdb(store);
  let db = await openDb(idb, 'shop', 1, d => {
    const items = d.createObjectStore('items', {keyPath: 'id', autoIncrement: true});
    items.createIndex('byName', 'name', {unique: true});
    items.createIndex('byTag', 'tags', {multiEntry: true});
    d.createObjectStore('kv');
  });
  let tx = db.transaction(['items', 'kv'], 'readwrite');
  for (const [name, tags] of [['apple', ['fruit', 'red']], ['beet', ['veg', 'red']], ['carrot', ['veg']]]) tx.objectStore('items').add({name, tags});
  tx.objectStore('kv').put({when: new Date(5)}, 'meta');
  tx.objectStore('kv').put('array key', ['a', 1]);
  await completed(tx);
  db.close();
  db = await openDb(idb, 'shop', 2, (d, oldVersion, upgrade) => {
    assert.equal(oldVersion, 1);
    const items = upgrade.objectStore('items');
    items.deleteIndex('byTag');
    items.createIndex('tagged', 'tags', {multiEntry: true});
    d.createObjectStore('log', {autoIncrement: true}).add('upgraded');
  });
  db.close();

  ({idb, g} = await bootIdb(store));
  assert.deepEqual(await idb.databases(), [{name: 'shop', version: 2}]);
  db = await openDb(idb, 'shop', 2, () => assert.fail('a stored database at its version needs no upgrade'));
  assert.deepEqual([...db.objectStoreNames], ['items', 'kv', 'log']);
  tx = db.transaction(['items', 'kv', 'log'], 'readwrite');
  const items = tx.objectStore('items');
  assert.deepEqual([...items.indexNames], ['byName', 'tagged']);
  assert.equal(items.keyPath, 'id');
  assert.equal(items.autoIncrement, true);
  assert.equal((await done(items.index('byName').get('beet'))).id, 2);
  assert.deepEqual(names(await done(items.index('tagged').getAll('red'))), ['apple', 'beet']);
  assert.equal(await done(items.count(g.IDBKeyRange.bound(2, 3))), 2);
  assert.deepEqual(await done(items.getAllKeys(g.IDBKeyRange.lowerBound(1, true))), [2, 3]);
  assert.deepEqual(await done(items.index('byName').getAllKeys(g.IDBKeyRange.bound('b', 'c￿'))), [2, 3]);
  // A cursor walking backwards renames one record and deletes another.
  const seen = [];
  await new Promise((resolve, reject) => {
    const request = items.openCursor(null, 'prev');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      seen.push(cursor.key);
      if (cursor.value.name === 'beet') cursor.update({...cursor.value, name: 'beetroot'});
      if (cursor.value.name === 'carrot') cursor.delete();
      cursor.continue();
    };
  });
  assert.deepEqual(seen, [3, 2, 1]);
  assert.equal(await done(items.add({name: 'date', tags: []})), 4, 'the key generator carries on from the stored one');
  const meta = await done(tx.objectStore('kv').get('meta'));
  assert.ok(meta.when instanceof Date);
  assert.equal(meta.when.getTime(), 5);
  assert.equal(await done(tx.objectStore('kv').get(['a', 1])), 'array key');
  assert.equal(await done(tx.objectStore('log').get(1)), 'upgraded');
  assert.equal(await done(tx.objectStore('log').add('again')), 2);
  await completed(tx);
  db.close();

  ({idb, g} = await bootIdb(store));
  db = await openDb(idb, 'shop', 2);
  tx = db.transaction('items', 'readwrite');
  assert.deepEqual(names(await done(tx.objectStore('items').getAll())), ['apple', 'beetroot', 'date']);
  assert.equal((await done(tx.objectStore('items').index('byName').get('beetroot'))).id, 2);
  // The unique index came back whole: a second "apple" is refused.
  await assert.rejects(done(tx.objectStore('items').add({name: 'apple', tags: []})), e => e.name === 'ConstraintError');
  await assert.rejects(completed(tx));
  db.close();
});

test('values keep their types through a restart: binaries, dates, maps, sets, shared references and odd numbers', async () => {
  const store = hostStore();
  let {idb, g} = await bootIdb(store);
  const big = new Uint8Array(100_000).map((_, i) => (i * 7) & 255);
  const shared = new ArrayBuffer(64);
  new Uint8Array(shared).set([9, 8, 7]);
  const value = {
    photo: new g.Blob([big], {type: 'image/jpeg'}), note: new g.Blob(['hi'], {type: 'text/plain'}),
    buffer: big.slice(10).buffer, floats: new Float32Array([1.5, -2]), view: new DataView(new ArrayBuffer(8), 2, 4),
    pair: [new Uint8Array(shared, 0, 8), new Uint16Array(shared, 8, 4)], bigView: new Uint8Array(big.buffer, 1000, 50_000),
    when: new Date(1234), never: new Date(NaN), pattern: /a+b/gi, map: new Map([[1, {a: 1}], ['k', new Set([1, 'x'])]]),
    odd: [NaN, -0, Infinity, -Infinity, undefined, 10n], dollars: {$: 1, $$: 2, $x: {$: 3}}, sparse: [1, , 3],
    text: 'é ☃ 😀 \u0000 \ud800', error: new TypeError('bad'), boxed: Object('s'),
  };
  value.self = value;
  const plain = {deep: {list: [1, 'two', {three: 3}], none: null, yes: true}};
  let db = await openDb(idb, 'values', 1, d => d.createObjectStore('v'));
  let tx = db.transaction('v', 'readwrite');
  tx.objectStore('v').put(value, 'odd');
  tx.objectStore('v').put(plain, 'plain');
  tx.objectStore('v').put(big.buffer, 'raw');
  await completed(tx);
  db.close();

  ({idb, g} = await bootIdb(store));
  assert.equal(store.counts.loads.get('indexedDB#val') ?? 0, 0, 'large binaries stay in the store until read');
  db = await openDb(idb, 'values', 1);
  tx = db.transaction('v', 'readonly');
  const back = await done(tx.objectStore('v').get('odd'));
  assert.deepEqual(await done(tx.objectStore('v').get('plain')), plain);
  const raw = await done(tx.objectStore('v').get('raw'));
  assert.ok(raw instanceof ArrayBuffer);
  assert.deepEqual(new Uint8Array(raw), big);
  assert.ok(back.photo instanceof g.Blob);
  assert.equal(back.photo.type, 'image/jpeg');
  assert.equal(back.photo.size, big.length);
  assert.deepEqual(new Uint8Array(await back.photo.arrayBuffer()), big);
  assert.equal(await back.note.text(), 'hi');
  assert.deepEqual(new Uint8Array(back.buffer), big.slice(10));
  assert.ok(back.floats instanceof Float32Array);
  assert.deepEqual([...back.floats], [1.5, -2]);
  assert.ok(back.view instanceof DataView);
  assert.deepEqual([back.view.byteOffset, back.view.byteLength, back.view.buffer.byteLength], [2, 4, 8]);
  assert.equal(back.pair[0].buffer, back.pair[1].buffer, 'two views of one buffer still share it');
  assert.deepEqual([...back.pair[0].slice(0, 3)], [9, 8, 7]);
  assert.ok(back.bigView instanceof Uint8Array);
  assert.deepEqual([back.bigView.byteOffset, back.bigView.length], [1000, 50_000]);
  assert.deepEqual(back.bigView, new Uint8Array(big.buffer, 1000, 50_000));
  assert.equal(back.when.getTime(), 1234);
  assert.ok(Number.isNaN(back.never.getTime()));
  assert.equal(String(back.pattern), '/a+b/gi');
  assert.deepEqual(back.map, new Map([[1, {a: 1}], ['k', new Set([1, 'x'])]]));
  assert.ok(Number.isNaN(back.odd[0]));
  assert.ok(Object.is(back.odd[1], -0));
  assert.deepEqual(back.odd.slice(2), [Infinity, -Infinity, undefined, 10n]);
  assert.equal(back.odd.length, 6);
  assert.ok(4 in back.odd, 'a stored undefined is still there');
  assert.deepEqual(back.dollars, {$: 1, $$: 2, $x: {$: 3}});
  assert.ok(!(1 in back.sparse), 'a hole stays a hole');
  assert.equal(back.text, value.text);
  assert.ok(back.error instanceof TypeError);
  assert.equal(back.error.message, 'bad');
  assert.equal(back.boxed.valueOf(), 's');
  assert.equal(back.self, back, 'a cycle comes back as a cycle');
  db.close();
});

test('deleteDatabase lasts, and a database nothing committed to is not kept', async () => {
  const store = hostStore();
  let {idb} = await bootIdb(store);
  let db = await openDb(idb, 'gone', 1, d => d.createObjectStore('s'));
  db.close();
  db = await openDb(idb, 'kept', 3, d => d.createObjectStore('s'));
  db.close();
  await done(idb.deleteDatabase('gone'));
  ({idb} = await bootIdb(store));
  assert.deepEqual(await idb.databases(), [{name: 'kept', version: 3}]);
});
