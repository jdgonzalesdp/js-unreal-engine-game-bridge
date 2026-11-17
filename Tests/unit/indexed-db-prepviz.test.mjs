// PrepViz's own IndexedDB code on the runtime (Runtime/src/indexedDb.ts), unchanged from its source: the per-account
// database helpers its workspace gate opens (ownerIdb.ts), the local repository (localDb.ts) and the shot render cache
// (shotRenderIdb.ts: Blobs put many to a transaction, a key-cursor sweep that deletes as it walks). The leave journal's
// synchronous write and the trash and cancelled-save key-range reads are written the way leaveJournal.ts,
// cancelCloudSave.ts and sceneTrashMarkers.ts write them. Each start is a fresh runtime and a fresh copy of PrepViz's
// modules over the same host store. Skipped when the PrepViz checkout named in Games/prepviz.json isn't there.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {bootIdb, hostStore, settle} from './indexed-db-page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Games/prepviz.json is a local file, so another checkout may have neither it nor PrepViz: the test is skipped there.
const gameFile = path.join(root, 'Games/prepviz.json');
const game = fs.existsSync(gameFile) ? JSON.parse(fs.readFileSync(gameFile, 'utf8')) : null;
const src = game ? path.resolve(root, game.repo, 'src') : '';
const present = !!game && fs.existsSync(path.join(src, 'state/ownerIdb.ts'));
let bundle = null;
if (present) {
  const esbuild = await import(pathToFileURL(path.join(root, 'Runtime/node_modules/esbuild/lib/main.js')).href);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgb-prepviz-idb-'));
  process.on('exit', () => fs.rmSync(out, {recursive: true, force: true}));
  bundle = path.join(out, 'prepviz-idb.mjs');
  await esbuild.build({stdin: {resolveDir: src, loader: 'ts', contents: `
    export {openOwnerDatabase, ownerTransaction, ownerPutMany} from './state/ownerIdb.ts';
    export {openLocalDb, completedTransaction, LOCAL_STORES} from './state/localRepository/localDb.ts';
    export {storeRenderBundle, readRenderManifest, deleteRenderBundle, readPovFrameBlob, storePovVideo, readPovVideo} from './state/shotRenderIdb.ts';
    export {capturePersistenceSession} from './state/persistenceSession.ts';`},
  outfile: bundle, bundle: true, format: 'esm', platform: 'neutral', logLevel: 'warning'});
}

let copies = 0;
async function start(store) {
  const {g} = await bootIdb(store);
  return {g, pv: await import(pathToFileURL(bundle).href + '?copy=' + ++copies)};
}
const jpeg = (n, seed) => new Uint8Array(n).map((_, i) => (i * 31 + seed) & 255);
const bytesOf = async blob => new Uint8Array(await blob.arrayBuffer());

test('PrepViz\'s device storage: account databases, the local repository and the render cache survive restarts', {skip: !present && 'the PrepViz checkout is not here'}, async () => {
  const store = hostStore();
  let {g, pv} = await start(store);
  let session = pv.capturePersistenceSession();
  // The workspace gate's first open: a per-account database created at version 1.
  const asset = {revision: {id: 'r1', version: 3}, files: [['model.glb', jpeg(120_000, 1)], ['notes.txt', jpeg(300, 2)]]};
  await pv.ownerTransaction('prepvis.artist-assets', 'revisions', 'readwrite', s => s.put(asset, 'asset-1'), session);
  // The local repository: one transaction over several stores, then the same reads PrepViz makes.
  let db = await pv.openLocalDb(session);
  assert.deepEqual([...db.objectStoreNames].sort(), [...pv.LOCAL_STORES].sort());
  let tx = db.transaction(['documents', 'meta', 'outbox'], 'readwrite');
  tx.objectStore('documents').put({id: 'doc-1', body: {scenes: [{id: 's1', name: 'Kitchen ☕'}]}, revision: 4}, 'doc-1');
  tx.objectStore('meta').put({deletedAt: 1, operationIds: ['op-1']}, 'project-delete:p1');
  tx.objectStore('meta').put({deletedAt: 2, operationIds: []}, 'project-delete:p2');
  tx.objectStore('meta').put({projectId: 'p1', sceneId: 's9', deletedAt: 3}, 'scene-delete:p1:s9');
  tx.objectStore('meta').put({at: 1}, 'trash:p3');
  tx.objectStore('outbox').put({operationId: 'op-2', projectId: 'p1'}, 'op-2');
  await pv.completedTransaction(db, tx, session, () => undefined);
  // The leave journal: written synchronously as the page goes, committed explicitly, never awaited.
  db = await pv.openLocalDb(session);
  tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({v: 1, at: 5, seq: 7, generation: session.generation, bytes: jpeg(2000, 3)}, 'leave-journal:1');
  tx.commit?.();
  // The render cache: a manifest, then frames many to a transaction, and a POV clip.
  const ref = 'render-idb:shot-1:abc';
  const frames = {top: [jpeg(40_000, 4), jpeg(40_000, 5)].map(b => new g.Blob([b], {type: 'image/jpeg'})), ref: [],
    pov: new Map([['cam-a', Array.from({length: 60}, (_, i) => new g.Blob([jpeg(35_000, i)], {type: 'image/jpeg'}))]])};
  await pv.storeRenderBundle(ref, {topCount: 2, refCount: 0, povCounts: {'cam-a': 60}, isStatic: false}, frames, session);
  await pv.storePovVideo(ref, 'cam-a', new g.Blob([jpeg(2_000_000, 9)], {type: 'video/mp4'}), session);
  await pv.storeRenderBundle('render-idb:shot-2:def', {topCount: 1, refCount: 0, povCounts: {}, isStatic: true},
    {top: [new g.Blob([jpeg(50_000, 7)], {type: 'image/jpeg'})], ref: [], pov: new Map()}, session);
  await settle(5);

  ({g, pv} = await start(store));
  session = pv.capturePersistenceSession();
  const back = await pv.ownerTransaction('prepvis.artist-assets', 'revisions', 'readonly', s => s.get('asset-1'), session);
  assert.deepEqual(back, asset);
  db = await pv.openLocalDb(session);
  tx = db.transaction(['documents', 'meta', 'outbox'], 'readonly');
  const docs = tx.objectStore('documents').getAll();
  const cancelled = tx.objectStore('meta').getAllKeys(g.IDBKeyRange.bound('project-delete:', 'project-delete;'));
  const sceneMarks = tx.objectStore('meta').getAll(g.IDBKeyRange.bound('scene-delete:p1:', 'scene-delete:p1:￿'));
  const trash = tx.objectStore('meta').getAll(g.IDBKeyRange.bound('trash:', 'trash;'));
  const leave = tx.objectStore('meta').get('leave-journal:1');
  const outbox = tx.objectStore('outbox').count();
  await pv.completedTransaction(db, tx, session, () => undefined);
  assert.equal(docs.result[0].body.scenes[0].name, 'Kitchen ☕');
  assert.deepEqual(cancelled.result, ['project-delete:p1', 'project-delete:p2']);
  assert.deepEqual(sceneMarks.result.map(m => m.sceneId), ['s9']);
  assert.equal(trash.result.length, 1);
  assert.deepEqual(leave.result.bytes, jpeg(2000, 3));
  assert.equal(outbox.result, 1);
  assert.deepEqual(await pv.readRenderManifest(ref, session), {topCount: 2, refCount: 0, povCounts: {'cam-a': 60}, isStatic: false});
  assert.deepEqual(await bytesOf(await pv.readPovFrameBlob(ref, 'cam-a', 59, session)), jpeg(35_000, 59));
  const clip = await pv.readPovVideo(ref, 'cam-a', session);
  assert.equal(clip.type, 'video/mp4');
  assert.deepEqual(await bytesOf(clip), jpeg(2_000_000, 9));
  // Deleting a render sweeps its keys with a key cursor, deleting as it goes; the other render stays.
  await pv.deleteRenderBundle(ref, session);
  g.__jsgbIndexedDb.compact();
  await settle(20);

  ({g, pv} = await start(store));
  session = pv.capturePersistenceSession();
  assert.equal(await pv.readRenderManifest(ref, session), null);
  assert.equal(await pv.readPovFrameBlob(ref, 'cam-a', 0, session), null);
  assert.equal(await pv.readPovVideo(ref, 'cam-a', session), null);
  assert.equal((await pv.readRenderManifest('render-idb:shot-2:def', session)).topCount, 1);
  const stored = [...store.map].filter(([k, v]) => k.startsWith('indexedDB#val.') && v).length;
  assert.ok(stored <= 2, `only the kept render's frame and the asset file remain stored as values (found ${stored})`);
});
