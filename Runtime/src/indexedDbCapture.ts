/** Watches fake-indexeddb's transactions so committed changes can be kept (indexedDb.ts). Record changes are seen where
 *  fake-indexeddb applies them (ObjectStore storeRecord, deleteRecord and clear, called with the transaction's rollback
 *  log while a request of that transaction runs), so a request that failed and was rolled back never shows up. A
 *  transaction ends in _markFinished: after _abort it was aborted and its changes are dropped, otherwise it committed.
 *  That happens before its complete event fires, so a commit can be on disk before the page hears of it, and a commit
 *  that can't be kept is turned into an abort the page hears instead. */
import FDBTransaction from '../node_modules/fake-indexeddb/build/esm/FDBTransaction.js';
import {ObjectStore, type RawDatabase, type RawStore, type Rec} from './indexedDbState';

export type Tx = {mode: string; durability?: string; _rollbackLog: unknown[]; _scope: Set<string>; db: {_rawDatabase: RawDatabase}};
export interface CaptureEvents {
  put(tx: Tx, store: RawStore, record: Rec): void;
  delete(tx: Tx, store: RawStore, key: unknown): void;
  clear(tx: Tx, store: RawStore): void;
  /** A readwrite or versionchange transaction committed. */
  commit(tx: Tx): void;
  abort(tx: Tx): void;
  /** deleteDatabase removed a database. */
  dropped(name: string): void;
  report(text: string): void;
}

type Proto = Record<string, (...args: any[]) => any>;
let installed = false;

export function installCapture(databases: Map<string, unknown>, on: CaptureEvents) {
  current = on;
  const dbs = databases as Map<string, unknown> & {delete(name: string): boolean};
  const drop = dbs.delete.bind(dbs);
  dbs.delete = (name: string) => { const had = drop(name); if (had) current.dropped(name); return had; };
  // The hooks go on fake-indexeddb's classes once per runtime.
  if (installed) return;
  installed = true;
  const T = FDBTransaction.prototype as unknown as Proto, S = ObjectStore.prototype as unknown as Proto;
  const start = T._start, abort = T._abort, finish = T._markFinished;
  T._start = function (this: Tx) { const prev = running; running = this; try { return start.call(this); } finally { running = prev; } };
  T._abort = function (this: Tx, ...args: unknown[]) { aborted.add(this); return abort.apply(this, args); };
  T._markFinished = function (this: Tx) {
    if (!aborted.has(this) && this.mode !== 'readonly') {
      try { current.commit(this); } catch (e) {
        // Not kept, so not committed: the page hears abort (UnknownError) and keeps its unsaved state. _abort rolls
        // the changes back and comes back here as an aborted transaction.
        current.report(`IndexedDB: a transaction could not be kept and is aborted (${e instanceof Error ? e.stack : e})`);
        aborted.add(this);
        return abort.call(this, 'UnknownError');
      }
    }
    if (aborted.has(this)) { try { current.abort(this); } catch { /* nothing kept */ } }
    return finish.call(this);
  };
  // A change counts only when made by the running transaction's own request (not a rollback, not a restore).
  const mine = (rollbackLog: unknown) => running && rollbackLog && rollbackLog === running._rollbackLog && running.mode === 'readwrite' ? running : null;
  const storeRecord = S.storeRecord, deleteRecord = S.deleteRecord, clear = S.clear;
  S.storeRecord = function (this: RawStore, record: Rec, noOverwrite: boolean, rollbackLog?: unknown[]) {
    const tx = mine(rollbackLog), mark = rollbackLog?.length ?? 0;
    const key = storeRecord.call(this, record, noOverwrite, rollbackLog);
    if (tx) {
      // A record that can't be kept is not stored either, as fake-indexeddb undoes a ConstraintError: memory and the
      // journal stay the same even when the page prevents the error and commits the rest.
      try { current.put(tx, this, record); } catch (e) { for (const undo of (rollbackLog as Array<() => void>).splice(mark).reverse()) undo(); throw e; }
    }
    return key;
  };
  S.deleteRecord = function (this: RawStore, key: unknown, rollbackLog?: unknown[]) {
    const out = deleteRecord.call(this, key, rollbackLog), tx = mine(rollbackLog);
    if (tx) current.delete(tx, this, key);
    return out;
  };
  S.clear = function (this: RawStore, rollbackLog?: unknown[]) {
    const out = clear.call(this, rollbackLog), tx = mine(rollbackLog);
    if (tx) current.clear(tx, this);
    return out;
  };
}

let current: CaptureEvents;
let running: Tx | null = null;
const aborted = new WeakSet<Tx>();
