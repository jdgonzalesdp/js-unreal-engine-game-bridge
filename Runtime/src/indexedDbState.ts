/** IndexedDB's databases as fake-indexeddb holds them in memory, written out as text and rebuilt from it (indexedDb.ts).
 *  A database is its version, its object stores (name, key path, auto-increment and key generator, indexes) and their
 *  records in key order. Rebuilding goes straight into fake-indexeddb's own structures, synchronously, so a restored
 *  database is in place before the game's first line runs. */
import Database from '../node_modules/fake-indexeddb/build/esm/lib/Database.js';
import ObjectStore from '../node_modules/fake-indexeddb/build/esm/lib/ObjectStore.js';
import Index from '../node_modules/fake-indexeddb/build/esm/lib/Index.js';
import FDBKeyRange from '../node_modules/fake-indexeddb/build/esm/FDBKeyRange.js';
import {decode, encode, type Sink, type Source} from './indexedDbCodec';

export type Rec = {key: unknown; value: unknown};
type RawIndex = {name: string; keyPath: unknown; unique: boolean; multiEntry: boolean; initialized: boolean; storeRecord(r: Rec): void};
export type RawStore = {name: string; keyPath: unknown; autoIncrement: boolean; keyGenerator: {num: number} | null; rawIndexes: Map<string, RawIndex>;
  records: {put(r: Rec, noOverwrite?: boolean): unknown; values(): Iterable<Rec>};
  storeRecord(r: Rec, noOverwrite: boolean, rollbackLog?: unknown[]): unknown; deleteRecord(key: unknown, rollbackLog?: unknown[]): void; clear(rollbackLog?: unknown[]): void};
export type RawDatabase = {name: string; version: number; rawObjectStores: Map<string, RawStore>};
type Range = {lower: unknown; upper: unknown; lowerOpen: boolean; upperOpen: boolean};
/** The source large binaries of one store's records come from (lazy only where no key path or index reads values). */
export type Sources = (store: RawStore) => Source;

const str = JSON.stringify;
export { ObjectStore, FDBKeyRange };

/** A record as [key, value, plain] text: plain marks a value JSON.parse alone gives back. */
export function recordText(key: unknown, value: unknown, sink: Sink): string {
  const v = encode(value, sink);
  return `${encode(key, null).text},${v.text},${v.plain ? 1 : 0}`;
}

/** The [lower, upper, lowerOpen, upperOpen] text of a key or key range a delete names. */
export function rangeText(key: unknown): string {
  const r = key instanceof FDBKeyRange ? key as unknown as Range : {lower: key, upper: key, lowerOpen: false, upperOpen: false};
  return `${encode(r.lower, null).text},${encode(r.upper, null).text},${r.lowerOpen},${r.upperOpen}`;
}

export function dumpDatabase(db: RawDatabase, sink: Sink): string {
  const stores: string[] = [];
  for (const s of db.rawObjectStores.values()) {
    const indexes = [...s.rawIndexes.values()].map(i => str([i.name, i.keyPath ?? null, !!i.unique, !!i.multiEntry]));
    const records: string[] = [];
    for (const r of s.records.values()) records.push(`[${recordText(r.key, r.value, sink)}]`);
    stores.push(`{"n":${str(s.name)},"k":${str(s.keyPath ?? null)},"a":${s.autoIncrement === true},"g":${s.keyGenerator ? s.keyGenerator.num : null},`
      + `"i":[${indexes.join(',')}],"r":[${records.join(',')}]}`);
  }
  return `{"n":${str(db.name)},"v":${db.version},"s":[${stores.join(',')}]}`;
}

type Dump = {n: string; v: number; s: Array<{n: string; k: unknown; a: boolean; g: number | null; i: Array<[string, unknown, boolean, boolean]>; r: Array<[unknown, unknown, number]>}>};

export function buildDatabase(dump: Dump, sources: Sources, report: (text: string) => void): RawDatabase {
  const db = new Database(dump.n, dump.v) as unknown as RawDatabase;
  for (const s of dump.s) {
    const store = new ObjectStore(db, s.n, s.k, s.a) as unknown as RawStore;
    if (store.keyGenerator && s.g !== null) store.keyGenerator.num = s.g;
    for (const [name, keyPath, unique, multiEntry] of s.i) store.rawIndexes.set(name, new Index(store, name, keyPath, multiEntry, unique) as unknown as RawIndex);
    db.rawObjectStores.set(s.n, store);
    const source = sources(store);
    for (const [k, v, plain] of s.r) store.records.put({key: decode(k, source), value: plain ? v : decode(v, source)});
    for (const index of store.rawIndexes.values()) {
      for (const r of store.records.values()) {
        try { index.storeRecord(r); } catch (e) { report(`IndexedDB ${dump.n}/${s.n}: index ${index.name} skipped a record (${e})`); }
      }
      index.initialized = true;
    }
  }
  return db;
}

/** Applies a committed transaction's record changes, in the order they were made. */
export function applyOps(db: RawDatabase, ops: unknown[][], sources: Sources) {
  for (const op of ops) {
    const store = db.rawObjectStores.get(op[1] as string);
    if (!store) throw new Error(`object store ${String(op[1])} is missing`);
    const source = sources(store);
    switch (op[0]) {
      case 'p': store.storeRecord({key: decode(op[2], source), value: op[4] ? op[3] : decode(op[3], source)}, false); break;
      case 'd': store.deleteRecord(new FDBKeyRange(decode(op[2], source), decode(op[3], source), op[4], op[5])); break;
      case 'c': store.clear(); break;
      case 'g': if (store.keyGenerator) store.keyGenerator.num = op[2] as number; break;
      default: throw new Error(`unknown change ${String(op[0])}`);
    }
  }
}
