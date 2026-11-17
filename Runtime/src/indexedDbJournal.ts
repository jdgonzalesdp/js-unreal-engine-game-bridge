/** Keeps IndexedDB's committed transactions in the host's store and brings them back at start (indexedDb.ts).
 *  - A readwrite transaction's record changes (puts with their final keys, deletes by key range, clears, key generator
 *    state) become one journal entry; a versionchange transaction becomes the whole database it upgraded (schema and
 *    records); deleteDatabase becomes a drop. An aborted transaction leaves nothing, and a commit that can't be kept
 *    (a value whose bytes can't be read) aborts with UnknownError instead.
 *  - An entry is written when its transaction commits, before the complete event, unless large binaries queued ahead
 *    of it carry more than SYNC_BYTES: those go out SLICE_BYTES per timer turn, in order, so a large binary never stalls
 *    the page. Large binaries are written before the entry that names them, so a stored entry never names a value that
 *    isn't there. A write the host store refuses is tried again later, and nothing after it is written first.
 *  - Compaction and clean-up run in idle turns (indexedDbCompact.ts). */
import {Files, CHUNK, chunksOf} from './indexedDbFiles';
import {applyOps, buildDatabase, dumpDatabase, rangeText, recordText, type RawDatabase, type RawStore, type Sources} from './indexedDbState';
import {StoredBytes, storedBlob, valueIds, type ValueReader} from './indexedDbLazy';
import {Compactor} from './indexedDbCompact';
import type {Sink, Source} from './indexedDbCodec';
import type {CaptureEvents, Tx} from './indexedDbCapture';

type ValueJob = {value: number; size: number; bytes: () => Uint8Array; data?: Uint8Array; next: number};
type Job = ValueJob | {log: string};
type Stage = {ops: string[]; ids: Map<object, number>; jobs: ValueJob[]};

export const SYNC_BYTES = 2 << 20;
export const SLICE_BYTES = CHUNK;
/** How long a write the host store refused waits before it is tried again. */
const RETRY_MS = 1000;
const str = JSON.stringify;

export class Journal extends Compactor implements CaptureEvents {
  private readonly queue: Job[] = [];
  private readonly stages = new WeakMap<Tx, Stage>();
  private draining = false; private failing = false;

  constructor(files: Files, databases: Map<string, RawDatabase>, private lazy: boolean, readonly report: (text: string) => void) { super(files, databases); }

  // ---- start: snapshot, then journal ----
  private readonly read: ValueReader = {all: (id, size) => this.files.value(id, size), parts: chunksOf,
    part: (id, size, i, out) => this.files.valuePart(id, size, i, out)};
  private readonly lazySource: Source = {
    buffer: (id, size) => { this.known.set(id, size); return new StoredBytes(id, size, this.read); },
    blob: (id, size, type, file) => { this.known.set(id, size); return storedBlob(id, size, type, this.read, file); },
  };
  private readonly eagerSource: Source = {
    buffer: (id, size) => { this.known.set(id, size); const b = this.read.all(id, size).buffer as ArrayBuffer; valueIds.set(b, id); return b; },
    blob: this.lazySource.blob,
  };
  /** A key path or index reads record values, so those stores get their buffers in memory. */
  private readonly sources: Sources = (store: RawStore) =>
    this.lazy && store.keyPath === null && store.rawIndexes.size === 0 ? this.lazySource : this.eagerSource;

  /** Rebuilds every database. Throws, leaving the store untouched, when anything stored can't be read back. */
  restore(): {databases: number; entries: number} {
    const heads = this.files.heads();
    for (const h of heads) this.slotParts[h.gen % 2] = Math.max(this.slotParts[h.gen % 2], h.parts);
    let text: string | null = null, newer: {gen: number; prev?: number} | null = null;
    for (const h of heads) {
      text = this.files.snapshot(h);
      if (text !== null) { this.gen = h.gen; break; }
      this.report(`IndexedDB: snapshot ${h.gen} failed its check; trying the one before it`);
      newer = h;
    }
    if (heads.length && text === null) throw new Error('no stored IndexedDB snapshot passes its check');
    if (text !== null) {
      const snap = JSON.parse(text) as {v: number; next: number; stale?: number; drop?: Array<[number, number]>; d: never[]};
      if (snap.v !== 1) throw new Error(`IndexedDB snapshot format ${snap.v} is newer than this runtime`);
      this.nextId = snap.next; this.snapChars = text.length;
      // Clean-up the last session may not have finished: old journal entries and values nothing refers to.
      this.staleLogs = snap.stale ?? 0; this.garbage = snap.drop ?? [];
      for (const d of snap.d) { const db = buildDatabase(d, this.sources, this.report); this.databases.set(db.name, db); }
    }
    const inSnapshot = new Set(this.known.keys());
    for (const id of inSnapshot) this.liveValueBytes += this.known.get(id)!;
    for (let body: string | null; (body = this.files.log(this.gen, this.logs)) !== null; this.logs++) {
      this.logChars += body.length;
      try { this.apply(JSON.parse(body)); } catch (e) { throw new Error(`IndexedDB journal entry ${this.logs} could not be applied: ${e instanceof Error ? e.message : e}`); }
    }
    // The generation before a damaged snapshot is whole only while its journal is, and the clean-up after a
    // compaction removes that journal: replaying less of it than it had would quietly bring back older data.
    if (newer && !(this.logs >= (newer.prev ?? Infinity))) {
      throw new Error(`snapshot ${newer.gen} is damaged and the journal before it is gone (${this.logs} of ${newer.prev ?? 'an unknown number of'} entries)`);
    }
    for (const [id, size] of this.known) { this.nextId = Math.max(this.nextId, id + 1); if (!inSnapshot.has(id)) this.valueBytesSince += size; }
    // Entries past the first damaged or missing one are not part of the state, yet they would replay once the page
    // writes past the gap: they go before it does.
    for (let n = this.logs + 1, misses = 0; misses < 16; n++) {
      if (this.files.log(this.gen, n) !== null) { misses = 0; this.files.dropLogs(n, n + 1); } else misses++;
    }
    // Values a crash left with no entry naming them: skip their ids and drop them later.
    for (let id = this.nextId, misses = 0; misses < 16; id++) {
      const size = this.files.strayValue(id);
      if (size === null) { misses++; continue; }
      misses = 0; this.garbage.push([id, size]); this.nextId = id + 1;
    }
    if (this.garbage.length || this.staleLogs > this.logs) this.scheduleTidy(0);
    return {databases: this.databases.size, entries: this.logs};
  }

  private apply(e: {t: string; n: string; o: unknown[][]; d: never}) {
    if (e.t === 'v') { const db = buildDatabase(e.d, this.sources, this.report); this.databases.set(db.name, db); }
    else if (e.t === 'x') this.databases.delete(e.n);
    else if (e.t === 'w') {
      const db = this.databases.get(e.n);
      // Deleted while that transaction ran (Journal.commit no longer keeps such a commit): nothing to apply.
      if (!db) { this.report(`IndexedDB: journal entry ${this.logs} names database ${e.n}, deleted before it; skipped`); return; }
      applyOps(db, e.o, this.sources);
    } else throw new Error(`unknown entry ${e.t}`);
  }

  // ---- capture: one stage per transaction until it commits or aborts ----
  private stage(tx: Tx): Stage {
    let s = this.stages.get(tx);
    if (!s) this.stages.set(tx, s = {ops: [], ids: new Map(), jobs: []});
    return s;
  }
  private sink(tx: Tx): Sink {
    const stage = this.stage(tx);
    return {binary: (owner, size, bytes) => {
      const kept = valueIds.get(owner);
      if (kept !== undefined && this.known.has(kept)) return kept;
      let id = stage.ids.get(owner);
      if (id === undefined) { id = this.nextId++; stage.ids.set(owner, id); stage.jobs.push({value: id, size, bytes, next: 0}); }
      return id;
    }};
  }
  put(tx: Tx, store: RawStore, record: {key: unknown; value: unknown}) {
    this.stage(tx).ops.push(`["p",${str(store.name)},${recordText(record.key, record.value, this.sink(tx))}]`);
  }
  delete(tx: Tx, store: RawStore, key: unknown) { this.stage(tx).ops.push(`["d",${str(store.name)},${rangeText(key)}]`); }
  clear(tx: Tx, store: RawStore) { this.stage(tx).ops.push(`["c",${str(store.name)}]`); }
  abort(tx: Tx) { this.stages.delete(tx); }
  dropped(name: string) { this.enqueue(`{"t":"x","n":${str(name)}}`, false); }

  commit(tx: Tx) {
    const db = tx.db._rawDatabase;
    // deleteDatabase counts a connection that is closing as closed, so a transaction on it can commit after the drop.
    // Its writes went to a database no longer in memory: kept, they would replay after the drop (and fail the start)
    // or into a new database of that name.
    if (this.databases.get(db.name) !== db) { this.stages.delete(tx); return; }
    let entry: string;
    if (tx.mode === 'versionchange') entry = `{"t":"v","d":${dumpDatabase(db, this.sink(tx))}}`;
    else {
      const ops = this.stages.get(tx)?.ops;
      if (!ops?.length) return;
      for (const name of tx._scope) { const s = db.rawObjectStores.get(name); if (s?.keyGenerator) ops.push(`["g",${str(name)},${s.keyGenerator.num}]`); }
      entry = `{"t":"w","n":${str(db.name)},"o":[${ops.join(',')}]}`;
    }
    const stage = this.stages.get(tx);
    // Bytes are taken now: a value that can't be read fails this commit (the transaction aborts), not the queue.
    for (const job of stage?.jobs ?? []) job.data = job.bytes();
    this.stages.delete(tx);
    for (const [owner, id] of stage?.ids ?? []) valueIds.set(owner, id);
    for (const job of stage?.jobs ?? []) { this.known.set(job.value, job.size); this.queue.push(job); this.valueBytesSince += job.size; }
    this.enqueue(entry, tx.durability === 'strict');
    if (tx.mode === 'readwrite') this.compactAtCommit(tx, this.report);
  }

  // ---- writing ----
  private enqueue(entry: string, strict: boolean) {
    this.queue.push({log: entry});
    // Only binaries go out in slices; an entry is written whole either way, so with none ahead of it, it goes now and
    // is on disk before the page hears complete, whatever its size.
    let pending = 0;
    for (const j of this.queue) if (!('log' in j)) pending += j.size - j.next * CHUNK;
    if (strict || pending <= SYNC_BYTES) this.drain(Infinity); else this.scheduleDrain();
  }
  protected drain(limit: number) {
    let done = 0;
    try {
      while (this.queue.length && done < limit) {
        const job = this.queue[0];
        if ('log' in job) {
          const n = this.files.writeLog(this.gen, this.logs, job.log);
          this.logs++; this.logChars += n; done += n; this.queue.shift();
        } else {
          job.data ??= job.bytes();
          this.files.writeValueChunk(job.value, job.size, job.next, job.data);
          job.next++; done += CHUNK;
          if (job.next >= chunksOf(job.size)) this.queue.shift();
        }
      }
    } catch (e) {
      // Nothing is skipped: the same write is tried again later, and everything after it waits, in order.
      if (!this.failing) this.report(`IndexedDB: a write to the host store failed; trying again every ${RETRY_MS} ms (${e instanceof Error ? e.message : e})`);
      this.failing = true;
      this.scheduleDrain(RETRY_MS);
      return;
    }
    if (this.failing) { this.failing = false; this.report('IndexedDB: writes to the host store work again'); }
    if (this.queue.length) this.scheduleDrain(); else this.scheduleTidy(0);
  }
  private scheduleDrain(ms = 0) {
    if (this.draining) return;
    this.draining = true;
    setTimeout(() => { this.draining = false; this.drain(SLICE_BYTES); }, ms);
  }
  protected queued(): boolean { return this.queue.length > 0; }
  /** Everything committed so far, written now (a reload or navigation is about to drop the page's timers). */
  flush() { this.drain(Infinity); }
  /** A write transaction is open or a commit is not on disk yet: a page that is leaving waits for these (leave.ts). */
  busy(): boolean { return this.queue.length > 0 || this.writing(); }

  stats() {
    return {generation: this.gen, journalEntries: this.logs, journalChars: this.logChars, snapshotChars: this.snapChars,
      storedValues: this.known.size, queued: this.queue.length, garbage: this.garbage.length,
      valueBytesSince: this.valueBytesSince, liveValueBytes: this.liveValueBytes};
  }
}
