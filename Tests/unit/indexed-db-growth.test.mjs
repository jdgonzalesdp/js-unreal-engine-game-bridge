// How large IndexedDB's host store grows (Runtime/src/indexedDbCompact.ts): values overwritten again and again are
// reclaimed by compaction, spent entries are removed rather than left as empty files, and many tiny commits don't
// rewrite a large snapshot each few hundred commits.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bootIdb, completed, done, hostStore, openDb, settle} from './indexed-db-page.mjs';

const stats = g => g.__jsgbIndexedDb.stats();
/** A host store that can remove entries, as the Unreal host's does (UJsgbBridge::RemoveStore). */
function removingStore() {
  const store = hostStore();
  store.storage.remove = k => { store.map.delete(k); };
  return store;
}
const disk = map => {
  let chars = 0, files = 0, empty = 0;
  for (const [k, v] of map) if (k.startsWith('indexedDB#')) { files++; chars += v.length; if (!v) empty++; }
  return {chars, files, empty};
};
/** The page goes idle: queued writes go out, then compaction (which waits for a turn with no write transaction open)
 *  and clean-up run. */
const idle = async g => {
  while (stats(g).queued) await settle(0);
  await settle(1);
  for (let i = 0; i < 40 && stats(g).garbage; i++) await settle(0);
};

test('re-rendering one shot again and again: the store stays near its live size, with no empty files', async () => {
  const store = removingStore();
  const {idb, g} = await bootIdb(store);
  const db = await openDb(idb, 'renders', 1, d => d.createObjectStore('frames'));
  const frames = 12, frameBytes = 20_000, clipBytes = 2_000_000, renders = 60;
  const fill = (n, seed) => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 997) b[i] = (i + seed) & 255; return b; };
  let largest = 0, compactions = 0, gen = 0;
  for (let r = 0; r < renders; r++) {
    const tx = db.transaction('frames', 'readwrite'), os = tx.objectStore('frames');
    for (let f = 0; f < frames; f++) os.put(new g.Blob([fill(frameBytes, r + f)], {type: 'image/jpeg'}), `shot-1:frame:${f}`);
    os.put(new g.Blob([fill(clipBytes, r)], {type: 'video/mp4'}), 'shot-1:pov');
    os.put({frames, render: r}, 'shot-1:manifest');
    await completed(tx);
    await idle(g);
    largest = Math.max(largest, disk(store.map).chars);
    if (stats(g).generation !== gen) { compactions++; gen = stats(g).generation; }
  }
  const written = renders * (frames * frameBytes + clipBytes), live = frames * frameBytes + clipBytes;
  // Values written since the last snapshot reach 64 MB (or the live size) before one is due, as base64 text.
  const bound = (64 * 2 ** 20 + 2 * live) * 4 / 3 + (1 << 20);
  assert.ok(compactions >= 1, 'value bytes alone made a compaction due');
  assert.ok(largest < bound, `the store reached ${(largest / 1e6).toFixed(1)} M chars for ${(written / 1e6).toFixed(0)} MB written`);
  assert.equal(disk(store.map).empty, 0, 'spent entries are removed, not blanked');
  db.close();
  // And the next start reads the last render.
  const next = await bootIdb(hostStore(new Map(store.map)));
  const back = await openDb(next.idb, 'renders', 1);
  const manifest = await done(back.transaction('frames', 'readonly').objectStore('frames').get('shot-1:manifest'));
  assert.deepEqual(manifest, {frames, render: renders - 1});
  back.close();
});

test('many tiny commits don\'t rewrite a large snapshot every few hundred commits, only at MAX_LOGS', async () => {
  const store = removingStore();
  const {idb, g} = await bootIdb(store);
  const db = await openDb(idb, 'doc', 1, d => d.createObjectStore('s'));
  let tx = db.transaction('s', 'readwrite');
  for (let i = 0; i < 400; i++) tx.objectStore('s').put({i, body: 'x'.repeat(12_000)}, 'scene:' + i);
  await completed(tx);
  await idle(g);
  await settle(5);
  const base = stats(g);
  assert.equal(base.generation, 1, 'a journal larger than 4 MB is compacted');
  assert.ok(base.snapshotChars > 4 << 20);
  const saves = () => store.counts.saves.get('indexedDB#snap') ?? 0;
  const snapSaves = saves();
  for (let i = 0; i < 600; i++) { tx = db.transaction('s', 'readwrite'); tx.objectStore('s').put(i, 'meta'); await completed(tx); }
  await settle(5);
  assert.equal(stats(g).generation, 1, '600 tiny entries next to a 5 MB snapshot are not worth rewriting it');
  assert.equal(saves(), snapSaves);
  for (let i = 600; i < 4000; i++) { tx = db.transaction('s', 'readwrite'); tx.objectStore('s').put(i, 'meta'); await completed(tx); }
  await settle(5);
  assert.equal(stats(g).generation, 2, 'at MAX_LOGS entries (each a file a start reads) it is');
  assert.equal(disk(store.map).empty, 0);
  db.close();
});

test('back-to-back re-renders with no idle turn between them still compact, as a commit lands', async () => {
  const store = removingStore();
  const {idb, g} = await bootIdb(store);
  const db = await openDb(idb, 'renders', 1, d => d.createObjectStore('frames'));
  const clipBytes = 4_000_000, renders = 40;
  const fill = (n, seed) => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 997) b[i] = (i + seed) & 255; return b; };
  let largest = 0;
  for (let r = 0; r < renders; r++) {
    const tx = db.transaction('frames', 'readwrite');
    tx.objectStore('frames').put(new g.Blob([fill(clipBytes, r)], {type: 'video/mp4'}), 'shot-1:pov');
    await completed(tx);
    // Only until the writes are out: the next render's transaction opens at once, so tidy never finds an idle turn.
    while (stats(g).queued) await settle(0);
    largest = Math.max(largest, disk(store.map).chars);
  }
  // As above, plus a render or two: it compacts at the first commit after tidy found no idle turn.
  const bound = (64 * 2 ** 20 + 4 * clipBytes) * 4 / 3 + (1 << 20);
  assert.ok(stats(g).generation >= 1, 'compacted with no idle turn');
  assert.ok(largest < bound, `the store reached ${(largest / 1e6).toFixed(1)} M chars for ${(renders * clipBytes / 1e6).toFixed(0)} MB written`);
  db.close();
});
