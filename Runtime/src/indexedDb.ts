/** IndexedDB for the page, kept in the host's store so it outlives a restart, a quit and a crash.
 *
 *  Puerts' V8 has no IndexedDB, and a local-first web app keeps its unsaved work there and may refuse to open without
 *  it. fake-indexeddb runs the whole IndexedDB API in memory: versions and upgrades, indexes, cursors, key ranges,
 *  auto-increment keys, getAll and count, blocked and versionchange events. What it commits is
 *  journaled into the host's store (indexedDbJournal.ts) and replayed here, synchronously, before the game's module
 *  runs. Every name is installed only where the engine has none. Workers get no IndexedDB: each JavaScript environment
 *  would hold its own copy, and two copies of one database would drift apart. */
import './domException';
import {installStructuredClone, ownsStructuredClone} from './structuredClone';
import * as fake from '../node_modules/fake-indexeddb/build/esm/index.js';
import {host} from './host';
import {onFlushStorage} from './dom';
import {onLeaveBusy} from './leave';
import {Files, type Store} from './indexedDbFiles';
import {Journal} from './indexedDbJournal';
import {installCapture} from './indexedDbCapture';
import type {RawDatabase} from './indexedDbState';

const g = globalThis as Record<string, any>;
installStructuredClone();

/** The session-only store of a host without one: data lasts until the game stops. */
function memoryStore(): Store {
  host.log('warn', 'IndexedDB: this host has no persistent store, so databases last only until the game stops');
  const m = new Map<string, string>();
  return {load: k => m.get(k) ?? null, save: (k, v) => { m.set(k, v); }, remove: k => { m.delete(k); }};
}

if (typeof g.indexedDB === 'undefined') {
  const report = (text: string) => host.log('error', text);
  const databases = (fake.indexedDB as unknown as {_databases: Map<string, RawDatabase>})._databases;
  // A host whose save answers false (SaveStore could not write the file: a full disk) gets a throw, so the journal keeps
  // the write queued and tries it again instead of going on as if it were on disk.
  const hs = host.storage;
  const store: Store = hs ? {load: k => hs.load(k), remove: hs.remove && (k => hs.remove!(k)),
    save: (k, v) => { if (hs.save(k, v) === false) throw new Error(`the host store could not write ${k}`); }} : memoryStore();
  const journal = new Journal(new Files(store), databases, ownsStructuredClone(), report);
  const t0 = host.now();
  let restored: {databases: number; entries: number} | null = null;
  try { restored = journal.restore(); } catch (e) {
    // Writing on top of a state that didn't come back whole would replace the stored one at the next compaction, so
    // the page gets no IndexedDB and the stored data stays exactly as it is for a runtime that can read it.
    report(`IndexedDB is unavailable: the stored databases could not be read back (${e instanceof Error ? e.stack : e}). They are left untouched.`);
  }
  if (restored) {
    installCapture(databases, journal);
    const names = {indexedDB: fake.indexedDB, IDBFactory: fake.IDBFactory, IDBDatabase: fake.IDBDatabase, IDBTransaction: fake.IDBTransaction,
      IDBObjectStore: fake.IDBObjectStore, IDBIndex: fake.IDBIndex, IDBCursor: fake.IDBCursor, IDBCursorWithValue: fake.IDBCursorWithValue,
      IDBKeyRange: fake.IDBKeyRange, IDBRequest: fake.IDBRequest, IDBOpenDBRequest: fake.IDBOpenDBRequest,
      IDBVersionChangeEvent: fake.IDBVersionChangeEvent, IDBRecord: fake.IDBRecord};
    for (const [name, value] of Object.entries(names)) g[name] ??= value;
    // A reload or navigation drops the page's timers: whatever is still queued is written first.
    onFlushStorage(() => journal.flush());
    // A page that is leaving waits for its open write transactions and queued writes (leave.ts).
    onLeaveBusy(() => journal.busy());
    g.__jsgbIndexedDb = {stats: () => journal.stats(), flush: () => journal.flush(), compact: () => journal.compact(), busy: () => journal.busy()};
    if (restored.databases || restored.entries) {
      host.log('log', `IndexedDB: ${restored.databases} database(s) restored, ${restored.entries} journal entries replayed, in ${Math.round(host.now() - t0)} ms`);
    }
  }
}
