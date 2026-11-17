// Leaving the page (Runtime/src/leave.ts) with IndexedDB: a web app keeps its unsaved work in beforeunload, pagehide
// and visibilitychange handlers, and what they start runs on later turns. A restart the page asks for, and a quit the
// host drives, both wait for it before storage is written out. The host store is copied at the moment the page would
// be torn down, as the next start sees it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bootIdb, completed, done, hostStore, openDb, settle} from './indexed-db-page.mjs';

async function readDoc(store) {
  const {idb} = await bootIdb(store);
  const db = await openDb(idb, 'local', undefined);
  const doc = await done(db.transaction('meta', 'readonly').objectStore('meta').get('doc'));
  db.close();
  return doc;
}
/** A page with a saved document whose leave handlers save the edit the way a local-first app does: one handler writes
 *  on a connection held ahead of time, the other opens the database first (a promise step), then writes. */
async function editedPage(store) {
  const page = await bootIdb(store), {idb, g} = page;
  const fired = [];
  for (const type of ['beforeunload', 'pagehide']) g.addEventListener(type, () => fired.push(type));
  g.document.addEventListener('visibilitychange', () => fired.push('visibilitychange:' + g.document.visibilityState));
  const held = await openDb(idb, 'local', 1, d => d.createObjectStore('meta'));
  let tx = held.transaction('meta', 'readwrite');
  tx.objectStore('meta').put('v1', 'doc');
  await completed(tx);
  g.addEventListener('beforeunload', () => {
    const t = held.transaction('meta', 'readwrite');
    t.objectStore('meta').put({at: 'leave'}, 'leave-journal');
    t.commit();
  });
  g.addEventListener('pagehide', () => {
    void (async () => {
      const db = await openDb(idb, 'local', 1);
      const t = db.transaction('meta', 'readwrite');
      t.objectStore('meta').put('v2-edited', 'doc');
      t.commit();
    })();
  });
  return {...page, fired};
}

test('a restart the page asks for fires the leave events and keeps what their handlers write', async () => {
  const store = hostStore();
  const {g, fired} = await editedPage(store);
  let atReload = null;
  g.__jsgbHost.reload = () => { atReload = new Map(store.map); };
  g.location.reload();
  assert.equal(atReload, null, 'the restart waits for the page');
  for (let i = 0; i < 400 && !atReload; i++) await settle(5);
  assert.ok(atReload, 'the host was asked to restart within 2 s');
  assert.deepEqual(fired, ['beforeunload', 'pagehide', 'visibilitychange:hidden']);
  assert.equal(g.document.hidden, true);
  assert.equal(await readDoc(hostStore(atReload)), 'v2-edited');
  const {idb} = await bootIdb(hostStore(atReload));
  const db = await openDb(idb, 'local', undefined);
  assert.deepEqual(await done(db.transaction('meta', 'readonly').objectStore('meta').get('leave-journal')), {at: 'leave'});
  db.close();
});

test('a quit the host drives: leave steps until the page has settled, then storage is written out', async () => {
  const store = hostStore();
  const {g, fired, page} = await editedPage(store);
  const steps = [];
  let flushed = 0, answer = false;
  const flush = () => { flushed++; page.flushStorage(); };
  // The host calls one step at a time (JsgbHost.cpp LeavePage); here Node's event loop runs the page between calls.
  for (let i = 0; i < 400 && !answer; i++) { answer = page.leaveStep(flush, () => steps.push(i)); if (!answer) await settle(5); }
  assert.equal(answer, true);
  assert.deepEqual(fired, ['beforeunload', 'pagehide', 'visibilitychange:hidden'], 'fired once, on the first step');
  assert.equal(flushed, 1);
  assert.ok(steps.length >= 1, 'the page\'s timers ran between steps');
  assert.equal(await readDoc(hostStore(new Map(store.map))), 'v2-edited');
  // A later step (the host's hot reload after the page restarted itself) only writes storage out again.
  assert.equal(page.leaveStep(flush, () => assert.fail('no more waiting')), true);
  assert.equal(fired.length, 3);
});

test('a host that runs out of time forces the last step, which writes out what there is', async () => {
  const store = hostStore();
  const {page} = await editedPage(store);
  assert.equal(page.leaveStep(page.flushStorage, () => {}), false, 'the page has just heard it is leaving');
  assert.equal(page.leaveStep(page.flushStorage, () => {}, true), true);
});

test('a leave write still running after the shortest wait holds the restart until it commits', async () => {
  const store = hostStore();
  const {idb, g} = await bootIdb(store);
  const db = await openDb(idb, 'slow', 1, d => d.createObjectStore('s'));
  // 120 requests one after another, each success handler taking 1 ms: well past the 50 ms every leave waits.
  g.addEventListener('pagehide', () => {
    const s = db.transaction('s', 'readwrite').objectStore('s');
    let n = 0;
    const next = () => { const end = performance.now() + 1; while (performance.now() < end) { /* work */ } if (++n < 120) s.put(n, n).onsuccess = next; };
    s.put(0, 0).onsuccess = next;
  });
  let atReload = null;
  g.__jsgbHost.reload = () => { atReload = new Map(store.map); };
  g.location.reload();
  for (let i = 0; i < 400 && !atReload; i++) await settle(5);
  const next = await bootIdb(hostStore(atReload));
  const back = await openDb(next.idb, 'slow', undefined);
  assert.equal((await done(back.transaction('s', 'readonly').objectStore('s').getAllKeys())).length, 120);
  back.close();
});

test('a leave handler that works longer than the shortest wait, then writes after a promise step, is still waited for', async () => {
  // A large account's capture takes longer than LEAVE_MIN_MS inside the handler; its write starts on the next promise
  // job. The wait counts from when the handlers returned, so neither a quit nor a restart settles before that job.
  const slowPage = async store => {
    const page = await bootIdb(store), {idb, g} = page;
    const held = await openDb(idb, 'local', 1, d => d.createObjectStore('meta'));
    const tx = held.transaction('meta', 'readwrite'); tx.objectStore('meta').put('v1', 'doc'); await completed(tx);
    g.addEventListener('pagehide', () => {
      const end = performance.now() + 80; while (performance.now() < end) { /* capture */ }
      void (async () => { await Promise.resolve(); const t = held.transaction('meta', 'readwrite'); t.objectStore('meta').put('v2-edited', 'doc'); t.commit(); })();
    });
    return page;
  };
  const quit = hostStore(), {page} = await slowPage(quit);
  assert.equal(page.leaveStep(page.flushStorage, () => {}), false, 'the call that fired the events does not settle');
  let answer = false;
  for (let i = 0; i < 400 && !answer; i++) { await settle(5); answer = page.leaveStep(page.flushStorage, () => {}); }
  const atQuit = new Map(quit.map);
  await settle(20);
  assert.equal(await readDoc(hostStore(atQuit)), 'v2-edited');
  const restart = hostStore(), {g} = await slowPage(restart);
  let atReload = null;
  g.__jsgbHost.reload = () => { atReload = new Map(restart.map); };
  g.location.reload();
  assert.equal(atReload, null, 'location.reload() does not restart from inside the handlers');
  for (let i = 0; i < 400 && !atReload; i++) await settle(5);
  await settle(20);
  assert.equal(await readDoc(hostStore(atReload)), 'v2-edited');
});
