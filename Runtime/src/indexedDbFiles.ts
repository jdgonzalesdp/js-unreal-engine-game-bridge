/** How IndexedDB (indexedDb.ts) lays its data out in the host's key/value store (host.storage: one file per key under
 *  Saved/JsGameBridge/<game>/Store, written in place, so a crash can leave a file cut short). Every entry starts with a
 *  header line naming what it is and a checksum of the line and the body, and an entry whose checksum fails is treated
 *  as never written. Nothing the current state depends on is ever written over:
 *  - head.<g % 2>: the pointer, {gen, parts, hash, length, prev} of snapshot generation g. The newest head that checks
 *    wins, so writing the next head can only fail back to the previous one. prev is how many journal entries the
 *    generation before had: a start may fall back to it only while they are all still there.
 *  - snap.<g % 2>.<i>: the snapshot of generation g in parts (all databases, schema and records).
 *  - log.<n>: the journal since that snapshot, one committed transaction per entry, numbered from 0 and stamped with the
 *    generation. Replay stops at the first entry that is missing, cut short or of another generation.
 *  - val.<id>.<i>: a large binary in base64 chunks, written once before the entry that refers to it.
 *  An entry that is no longer needed is removed (an empty file where the host can't remove one).
 *  Bodies are kept to ASCII (JSON escapes for anything else), so no text encoding step can change a checksummed byte. */
import {bytesBase64} from './base64';

export type Store = {load(key: string): string | null; save(key: string, data: string): void; remove?(key: string): void};
export type Head = {gen: number; parts: number; hash: string; length: number; prev?: number};

const P = 'indexedDB#';
/** Raw bytes per value entry: about 0.7 MB of text, a few milliseconds to encode and write. */
export const CHUNK = 512 * 1024;
/** Characters per snapshot entry. */
const PART = 4 * 1024 * 1024;

/** FNV-1a over UTF-16 units plus the total length: tells a whole entry from one a crash cut short. */
export function checksum(...texts: string[]): string {
  let h = 0x811c9dc5, n = 0;
  for (const t of texts) { n += t.length; for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193); }
  return (h >>> 0).toString(16) + '.' + n.toString(36);
}

const HAS_WIDE = /[^\x00-\x7f]/, WIDE = /[^\x00-\x7f]/g;
/** JSON text with every non-ASCII unit written as a \u escape (JSON.parse reads it back unchanged). */
export const ascii = (json: string) => HAS_WIDE.test(json) ? json.replace(WIDE, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) : json;

export const chunksOf = (size: number) => Math.max(1, Math.ceil(size / CHUNK));

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', SIX = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) SIX[B64.charCodeAt(i)] = i;
/** Decodes the base64 text from `start` (as bytesBase64 writes it) into out at `at`; the byte count, or -1 when the text
 *  is not clean base64. Four characters at a time, straight into place. */
function decodeInto(text: string, start: number, out: Uint8Array, at: number): number {
  const n = text.length - start;
  if (n % 4) return -1;
  let o = at;
  for (let i = start, end = text.length; i < end; i += 4) {
    const a = SIX[text.charCodeAt(i) & 127], b = SIX[text.charCodeAt(i + 1) & 127], c3 = text.charCodeAt(i + 2), d4 = text.charCodeAt(i + 3);
    const c = c3 === 61 ? 0 : SIX[c3 & 127], d = d4 === 61 ? 0 : SIX[d4 & 127];
    if ((a | b | c | d) < 0 || o + 1 > out.length) return -1;
    const v = a << 18 | b << 12 | c << 6 | d;
    out[o++] = v >> 16;
    if (c3 !== 61) { if (o >= out.length) return -1; out[o++] = v >> 8 & 255; }
    if (d4 !== 61) { if (o >= out.length) return -1; out[o++] = v & 255; }
  }
  return o - at;
}

export class Files {
  constructor(private store: Store) {}

  private read(key: string, head: string): string | null {
    const text = this.store.load(P + key);
    if (!text) return null;
    const nl = text.indexOf('\n'), sp = nl < 0 ? -1 : text.lastIndexOf(' ', nl);
    if (sp < 0 || text.slice(0, sp) !== head) return null;
    const body = text.slice(nl + 1);
    return text.slice(sp + 1, nl) === checksum(head, '\n', body) ? body : null;
  }
  private write(key: string, head: string, body: string) { this.store.save(P + key, `${head} ${checksum(head, '\n', body)}\n${body}`); }
  private blank(key: string) { if (this.store.remove) this.store.remove(P + key); else this.store.save(P + key, ''); }

  /** Heads that check, newest first. */
  heads(): Head[] {
    const out: Head[] = [];
    for (const slot of [0, 1]) {
      const body = this.read(`head.${slot}`, 'H');
      try { const h = body ? JSON.parse(body) as Head : null; if (h && h.gen % 2 === slot) out.push(h); } catch { /* unreadable: not a head */ }
    }
    return out.sort((a, b) => b.gen - a.gen);
  }
  writeHead(h: Head) { this.write(`head.${h.gen % 2}`, 'H', JSON.stringify(h)); }

  /** The snapshot a head names, or null when any part of it fails its check. */
  snapshot(h: Head): string | null {
    const parts: string[] = [];
    for (let i = 0; i < h.parts; i++) {
      const body = this.read(`snap.${h.gen % 2}.${i}`, `S ${h.gen} ${i} ${h.parts}`);
      if (body === null) return null;
      parts.push(body);
    }
    const text = parts.join('');
    return text.length === h.length && checksum(text) === h.hash ? text : null;
  }
  /** Writes snapshot text for generation gen; the head that names it is written after (writeHead). */
  writeSnapshot(gen: number, json: string): Head {
    const text = ascii(json), parts = Math.max(1, Math.ceil(text.length / PART));
    for (let i = 0; i < parts; i++) this.write(`snap.${gen % 2}.${i}`, `S ${gen} ${i} ${parts}`, text.slice(i * PART, (i + 1) * PART));
    return {gen, parts, hash: checksum(text), length: text.length};
  }
  dropSnapshotParts(gen: number, from: number, to: number) { for (let i = from; i < to; i++) this.blank(`snap.${gen % 2}.${i}`); }

  log(gen: number, n: number): string | null { return this.read(`log.${n}`, `L ${gen} ${n}`); }
  writeLog(gen: number, n: number, json: string): number { const text = ascii(json); this.write(`log.${n}`, `L ${gen} ${n}`, text); return text.length; }
  dropLogs(from: number, to: number) { for (let n = from; n < to; n++) this.blank(`log.${n}`); }

  /** All bytes of a stored value; throws when a part is missing or damaged. */
  value(id: number, size: number): Uint8Array {
    const out = new Uint8Array(size);
    for (let i = 0, n = chunksOf(size); i < n; i++) this.valuePart(id, size, i, out);
    return out;
  }
  /** Part i of a stored value, decoded into its place in `out`. A value is written whole before any entry names it, so
   *  a part is only checked for its header and its decoded length, not its checksum: reading stays fast. */
  valuePart(id: number, size: number, i: number, out: Uint8Array) {
    const chunks = chunksOf(size), text = this.store.load(P + `val.${id}.${i}`), head = `V ${id} ${i} ${chunks} ${size} `;
    const nl = text && text.startsWith(head) ? text.indexOf('\n') : -1;
    const length = Math.min(CHUNK, size - i * CHUNK);
    if (nl < 0 || decodeInto(text!, nl + 1, out, i * CHUNK) !== length) throw new Error(`IndexedDB: stored value ${id} is missing or damaged (part ${i + 1} of ${chunks})`);
  }
  writeValueChunk(id: number, size: number, i: number, bytes: Uint8Array) {
    const chunks = chunksOf(size);
    this.write(`val.${id}.${i}`, `V ${id} ${i} ${chunks} ${size}`, bytesBase64(bytes.subarray(i * CHUNK, Math.min(size, (i + 1) * CHUNK))));
  }
  dropValue(id: number, size: number) { for (let i = 0, n = chunksOf(size); i < n; i++) this.blank(`val.${id}.${i}`); }
  /** The size of a value whose first chunk is in the store (checked or not): a crash can leave one no entry names. */
  strayValue(id: number): number | null {
    const text = this.store.load(P + `val.${id}.0`);
    const m = text ? /^V \d+ 0 \d+ (\d+) /.exec(text) : null;
    return m ? Number(m[1]) : text ? CHUNK : null;
  }
}
