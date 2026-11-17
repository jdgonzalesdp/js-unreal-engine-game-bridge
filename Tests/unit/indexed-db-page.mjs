// Boots the runtime's page with IndexedDB (indexed-db-fixture.ts) in Node the way the Unreal host starts it. Node's own
// web globals are removed first, so the runtime installs its own (structuredClone, DOMException, Blob, IndexedDB), and
// every boot is a fresh copy of the runtime, as every restart is a fresh JavaScript environment. The host's store is a
// Map the test keeps, as the Unreal host's store outlives restarts, quits and crashes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const esbuild = await import(pathToFileURL(path.join(root, 'Runtime/node_modules/esbuild/lib/main.js')).href);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgb-idb-'));
process.on('exit', () => fs.rmSync(out, {recursive: true, force: true}));
const bundle = path.join(out, 'page.mjs');
await esbuild.build({entryPoints: [path.join(root, 'Tests/unit/indexed-db-fixture.ts')], outfile: bundle, bundle: true, format: 'esm',
  platform: 'node', logLevel: 'warning'});
/** The same page on the runtime's own timers (indexed-db-pump-fixture.ts), built on first use. */
let pumpBundle = null;
async function pumped() {
  if (pumpBundle) return pumpBundle;
  const file = path.join(out, 'pump.mjs');
  await esbuild.build({entryPoints: [path.join(root, 'Tests/unit/indexed-db-pump-fixture.ts')], outfile: file, bundle: true, format: 'esm',
    platform: 'node', logLevel: 'warning'});
  return pumpBundle = file;
}

// Node defines some of these lazily through its fetch (undici), which fails to load once File is gone: all go first.
const WEB = ['ErrorEvent', 'CloseEvent', 'EventSource', 'WebSocket', 'WebSocketStream', 'BroadcastChannel', 'MessageChannel', 'MessagePort',
  'PopStateEvent', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'structuredClone', 'Blob', 'File', 'fetch', 'Response', 'Headers', 'Request',
  'AbortController', 'AbortSignal', 'navigator', 'Navigator', 'atob', 'btoa', 'Event', 'EventTarget', 'CustomEvent', 'MessageEvent', 'DOMException',
  'crypto', 'localStorage', 'sessionStorage', 'Storage', 'location', 'history', 'document', 'open', 'origin', 'XMLHttpRequest', 'FormData',
  'indexedDB', 'IDBFactory', 'IDBDatabase', 'IDBTransaction', 'IDBObjectStore', 'IDBIndex', 'IDBCursor', 'IDBCursorWithValue', 'IDBKeyRange',
  'IDBRequest', 'IDBOpenDBRequest', 'IDBVersionChangeEvent', 'IDBRecord', '__jsgbIndexedDb'];

/** A host store: a Map, with every load that found something and every save counted by key prefix. */
export function hostStore(map = new Map()) {
  const counts = {loads: new Map(), saves: new Map()};
  const bump = (m, k) => { const p = k.replace(/[.\d]+$/, ''); m.set(p, (m.get(p) ?? 0) + 1); };
  return {map, counts, storage: {
    load: k => { const v = map.get(k); if (!v) return null; bump(counts.loads, k); return v; },
    save: (k, v) => { bump(counts.saves, k); map.set(k, v); },
  }};
}

let boots = 0;
// Node's clock, kept apart: the runtime's timers.ts points performance.now at the host's now.
const nodeNow = performance.now.bind(performance);
/** A fresh page over this store: the runtime's exports, and what it logged. With pump, the page runs on the runtime's
 *  timers (timers.ts), which then replace Node's setTimeout and setImmediate in this process: the test drives it with
 *  page.pumpFrame. */
export async function bootIdb(store, {pump = false} = {}) {
  for (const k of WEB) try { delete globalThis[k]; } catch { /* not deletable */ }
  const logs = [];
  globalThis.__jsgbHost = {registry: '', search: '', now: nodeNow, readFile: () => null, reload() {},
    log: (level, text) => { logs.push(`${level} ${text}`); }, storage: store.storage};
  const page = await import(pathToFileURL(pump ? await pumped() : bundle).href + '?boot=' + ++boots);
  return {page, logs, idb: globalThis.indexedDB, g: globalThis};
}

/** A request's result, or its error. */
export const done = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
/** A transaction's completion; rejects when it aborts (a request error the page prevents doesn't abort it). */
export const completed = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error ?? new Error('aborted'));
});
/** Opens a database, running upgrade(db, oldVersion, tx) when the version moves. */
export function openDb(idb, name, version, upgrade = () => {}) {
  const request = idb.open(name, version);
  request.onupgradeneeded = e => upgrade(request.result, e.oldVersion, request.transaction);
  return done(request);
}
/** Lets the page's queued work run (Node's timers drive the page here). */
export const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
