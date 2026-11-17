// IndexedDB under the runtime's own timer pump (Runtime/src/timers.ts), as Unreal runs it: one pumpFrame(8) per host
// tick, with Node's event loop only between frames. fake-indexeddb steps through setImmediate, and after each step
// the pump lets the promise jobs it started run, as a browser's microtask checkpoint does; a host quit drives the
// page's leave one step at a time (JsgbHost.cpp LeavePage).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bootIdb, done, hostStore, openDb} from './indexed-db-page.mjs';

// Node's own, taken before the runtime's timers replace them.
const nodeImmediate = setImmediate, nodeTimeout = setTimeout;
const turn = (ms = -1) => new Promise(resolve => ms < 0 ? nodeImmediate(resolve) : nodeTimeout(resolve, ms));

async function pumpedPage(store) {
  const b = await bootIdb(store, {pump: true});
  const frame = async () => { await b.page.pumpFrame(8); await turn(); };
  /** Frames until the promise settles. */
  const until = async (promise, limit = 2000) => {
    let settled = false, value, error;
    promise.then(v => { settled = true; value = v; }, e => { settled = true; error = e; });
    for (let i = 0; i < limit && !settled; i++) await frame();
    if (!settled) throw new Error(`still waiting after ${limit} frames`);
    if (error) throw error;
    return value;
  };
  return {...b, frame, until};
}

test('a request awaited through promise wrappers finds its transaction still active', async () => {
  const {idb, until} = await pumpedPage(hostStore());
  const db = await until(openDb(idb, 'hops', 1, d => d.createObjectStore('s')));
  const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  for (const depth of [0, 1, 2, 3]) {
    const tx = db.transaction('s', 'readwrite'), store = tx.objectStore('s');
    // As helper libraries wrap a request: depth more async functions around its promise.
    let get = key => request(store.get(key));
    for (let i = 0; i < depth; i++) { const inner = get; get = async key => await inner(key); }
    const ended = new Promise((resolve, reject) => { tx.oncomplete = () => resolve('complete'); tx.onabort = () => reject(tx.error); });
    await until((async () => { const v = await get('a'); store.put((v ?? 0) + 1, 'a'); })());
    assert.equal(await until(ended), 'complete', `awaited ${depth} deep`);
  }
  assert.equal(await until(done(db.transaction('s').objectStore('s').get('a'))), 4);
});

test('a host quit: leave steps run the page\'s timers until its leave writes are on disk', async () => {
  const store = hostStore();
  const {idb, g, page, until} = await pumpedPage(store);
  const held = await until(openDb(idb, 'local', 1, d => d.createObjectStore('meta')));
  const tx = held.transaction('meta', 'readwrite');
  tx.objectStore('meta').put('v1', 'doc');
  await until(new Promise(resolve => { tx.oncomplete = resolve; }));
  // The edit is kept on leave the slow way: open the database (a promise step), then write.
  g.addEventListener('pagehide', () => {
    void (async () => {
      const db = await openDb(idb, 'local', 1);
      const t = db.transaction('meta', 'readwrite');
      t.objectStore('meta').put('v2-edited', 'doc');
      t.commit();
    })();
  });
  // No more frames: only the host's leave calls, each followed by the promise jobs it started (as V8 runs them when a
  // call from the host returns).
  let answer = false, steps = 0;
  for (; steps < 400 && !answer; steps++) { answer = page.leaveStep(page.flushStorage, () => { void page.runTimers(4); }); await turn(1); }
  assert.equal(answer, true);
  assert.ok(steps > 1, 'the page was given steps to finish');
  // The next start (on the runtime's timers too: they stay installed in this process).
  const next = await pumpedPage(hostStore(new Map(store.map)));
  const db = await next.until(openDb(next.idb, 'local', undefined));
  assert.equal(await next.until(done(db.transaction('meta', 'readonly').objectStore('meta').get('doc'))), 'v2-edited');
});
