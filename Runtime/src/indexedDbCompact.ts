/** Compaction and clean-up of IndexedDB's host store (indexedDbJournal.ts), in idle turns of the page.
 *  - When the journal is worth folding into a new snapshot (due) and no write transaction is open, every database is
 *    written as the next generation's snapshot, then the head that points at it.
 *  - Then, a little per turn, the old journal and the values nothing refers to any more are removed. What is left to
 *    remove is named in the new snapshot, so a start after a quit finishes it. */
import {Files, chunksOf} from './indexedDbFiles';
import {dumpDatabase, type RawDatabase} from './indexedDbState';
import {loadBeforeDrop, valueIds} from './indexedDbLazy';
import type {Sink} from './indexedDbCodec';
import type {Tx} from './indexedDbCapture';

/** A snapshot is rewritten at COMPACT_LOGS entries (unless they are tiny next to it), at MAX_LOGS whatever their size,
 *  at COMPACT_CHARS of journal text (or the snapshot's size), and at COMPACT_VALUE_BYTES of values written since it. */
const COMPACT_LOGS = 500, MAX_LOGS = 4000, COMPACT_CHARS = 4 << 20, COMPACT_VALUE_BYTES = 64 << 20;
const str = JSON.stringify;

/** The journal's state on disk, and keeping it small. */
export abstract class Compactor {
  protected gen = 0; protected logs = 0; protected logChars = 0; protected snapChars = 0; protected nextId = 1;
  /** Value id to size, for every value in the store or queued ahead of the entry that names it. */
  protected readonly known = new Map<number, number>();
  protected readonly slotParts = [0, 0];
  protected garbage: Array<[number, number]> = [];
  protected staleLogs = 0;
  /** Value bytes written since the snapshot, and those of the values the snapshot keeps. Overwritten and deleted
   *  values stay on disk until the next snapshot, so the first bounds how much of the store is dead. */
  protected valueBytesSince = 0; protected liveValueBytes = 0;
  private tidying = false;
  /** Compaction was due but a write was queued or a write transaction open: back-to-back writes leave no idle turn, so
   *  the next commit with no other write transaction open compacts instead (compactAtCommit). */
  private held = false;

  constructor(protected files: Files, protected databases: Map<string, RawDatabase>) {}
  /** Writes queued work, in order, up to about `limit` bytes. */
  protected abstract drain(limit: number): void;
  /** Writes are queued that are not on disk yet. */
  protected abstract queued(): boolean;

  protected scheduleTidy(ms: number) {
    if (this.tidying) return;
    this.tidying = true;
    setTimeout(() => { this.tidying = false; this.tidy(); }, ms);
  }
  /** A snapshot costs its whole size to rewrite, so it is rewritten only once the journal is as large (or 4 MB), holds
   *  many entries that are not tiny next to it, or very many entries (each a file the next start reads), or once the
   *  values written since it outweigh both it and the values it keeps. */
  private due(): boolean {
    const many = this.logs >= COMPACT_LOGS && this.logChars * 16 > this.snapChars;
    return this.logChars > Math.max(COMPACT_CHARS, this.snapChars) || many || this.logs >= MAX_LOGS
      || this.valueBytesSince > Math.max(COMPACT_VALUE_BYTES, this.liveValueBytes, this.snapChars);
  }
  private tidy() {
    if (this.queued()) { if (this.due()) this.held = true; return; }
    if (this.due()) {
      if (this.writing()) { this.held = true; this.scheduleTidy(25); return; }
      this.compact();
    }
    let budget = 64;
    for (; budget > 0 && this.garbage.length; budget--) { const [id, size] = this.garbage.pop()!; loadBeforeDrop(id); this.files.dropValue(id, size); }
    for (; budget > 0 && this.staleLogs > this.logs; budget--) { this.staleLogs--; this.files.dropLogs(this.staleLogs, this.staleLogs + 1); }
    if (this.garbage.length || this.staleLogs > this.logs) this.scheduleTidy(0);
  }
  /** A write transaction is open: its changes are already in memory, and a snapshot must not hold them yet. */
  protected writing(except?: Tx): boolean {
    for (const db of this.databases.values()) {
      for (const t of (db as unknown as {transactions: Array<Tx & {_state: string}>}).transactions) if (t !== except && t.mode !== 'readonly' && t._state !== 'finished') return true;
    }
    return false;
  }
  /** As `tx` commits (its changes in memory and its entry queued), when tidy was held back and no other write is open. */
  protected compactAtCommit(tx: Tx, report: (text: string) => void) {
    if (!this.held || !this.due() || this.writing(tx)) return;
    try { this.compact(tx); } catch (e) { report(`IndexedDB: compaction failed (${e instanceof Error ? e.message : e})`); }
  }
  /** Writes a snapshot of every database as the next generation and switches the head to it. `committing`: the
   *  transaction whose commit this runs in, whose changes the snapshot keeps. */
  compact(committing?: Tx) {
    this.drain(Infinity);
    // An entry still queued would replay on top of the snapshot that already holds it.
    if (this.queued()) throw new Error('IndexedDB: cannot compact while writes to the host store are failing');
    if (this.writing(committing)) throw new Error('IndexedDB: cannot compact while a write transaction is open');
    this.held = false;
    const live = new Set<number>();
    const sink: Sink = {binary: (owner, size, bytes) => {
      let id = valueIds.get(owner);
      if (id === undefined || !this.known.has(id)) {
        id = this.nextId++;
        const data = bytes();
        for (let i = 0; i < chunksOf(size); i++) this.files.writeValueChunk(id, size, i, data);
        valueIds.set(owner, id); this.known.set(id, size);
      }
      live.add(id);
      return id;
    }};
    const dumps: string[] = [];
    for (const db of this.databases.values()) if (db.version > 0) dumps.push(dumpDatabase(db, sink));
    // What the new generation no longer uses is named in it, so a start after a quit still drops it.
    const unused = [...this.known].filter(([id]) => !live.has(id)), drop = [...this.garbage, ...unused];
    const stale = Math.max(this.staleLogs, this.logs), gen = this.gen + 1;
    const head = this.files.writeSnapshot(gen, `{"v":1,"next":${this.nextId},"stale":${stale},"drop":${str(drop)},"d":[${dumps.join(',')}]}`);
    // prev: the journal length of the generation before, which a start that has to fall back to it must find whole.
    this.files.writeHead({...head, prev: this.logs});
    // The new generation is in place: what only the old one used can go.
    this.files.dropSnapshotParts(gen, head.parts, this.slotParts[gen % 2]);
    this.slotParts[gen % 2] = head.parts;
    for (const [id] of unused) this.known.delete(id);
    this.liveValueBytes = 0;
    for (const id of live) this.liveValueBytes += this.known.get(id) ?? 0;
    this.valueBytesSince = 0;
    this.garbage = drop; this.staleLogs = stale;
    this.gen = gen; this.logs = 0; this.logChars = 0; this.snapChars = head.length;
    if (this.garbage.length || this.staleLogs) this.scheduleTidy(0);
  }
}
