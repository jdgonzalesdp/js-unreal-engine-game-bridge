/** Stored binaries that stay in the host's store until a page reads them (indexedDb.ts). A database restored at start
 *  can hold far more image and model bytes than a page ever reads in one session, so a large Blob comes back as a Blob
 *  whose bytes load on first use, and a large ArrayBuffer (or a view of one) as a stand-in that IndexedDB's clone on the
 *  way out turns into the real buffer. Every read of a record goes through that clone, so the page never sees one. */
import {CLONE_AS} from './structuredClone';

const g = globalThis as Record<string, any>;
/** Reads a stored value: all at once, or one part at a time into its place. */
export type ValueReader = {all(id: number, size: number): Uint8Array; part(id: number, size: number, i: number, out: Uint8Array): void; parts(size: number): number};

/** Value ids of stored binaries, so a binary already in the host's store is referenced again, not written again. */
export const valueIds = new WeakMap<object, number>();

function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer as ArrayBuffer : bytes.slice().buffer;
}

/** An ArrayBuffer at rest. Loaded once, then kept: a record's buffer never changes. */
export class StoredBytes {
  private loaded: ArrayBuffer | null = null;
  constructor(readonly id: number, readonly size: number, private read: ValueReader) { valueIds.set(this, id); }
  get buffer(): ArrayBuffer { return this.loaded ??= ownBuffer(this.read.all(this.id, this.size)); }
  get bytes(): Uint8Array { return new Uint8Array(this.buffer); }
  [CLONE_AS]() { return this.buffer; }
}

/** A typed array or DataView over a stored buffer. */
export class StoredView {
  constructor(readonly type: string, readonly source: StoredBytes, readonly offset: number, readonly length: number) {}
  [CLONE_AS]() { return new g[this.type](this.source.buffer, this.offset, this.length); }
}

/** True when Blobs are the runtime's own (polyfills.ts), whose bytes a lazy Blob can stand in for. */
export function lazyBlobsWork(): boolean {
  try { return typeof g.Blob === 'function' && new g.Blob([]).bytes instanceof Uint8Array; } catch { return false; }
}

/** Lazy Blobs by value id, held weakly: one the page still holds is loaded before its stored bytes are dropped. */
const lazyBlobs = new Map<number, {deref(): object | undefined}>();
const Weak = g.WeakRef as (new (o: object) => {deref(): object | undefined}) | undefined;

const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));

/** A Blob (or File, with name and lastModified) whose bytes stay in the host's store until first read. arrayBuffer()
 *  and text() read them a part per timer turn, so even a very large Blob never holds the page; anything that needs
 *  the bytes at once (the runtime's own Blob users) reads them whole. */
export function storedBlob(id: number, size: number, type: string, read: ValueReader, file?: {name: string; lastModified: number}): object {
  if (!lazyBlobsWork()) {
    const bytes = read.all(id, size);
    const blob = file && g.File ? new g.File([bytes], file.name, {type, lastModified: file.lastModified}) : new g.Blob([bytes], {type});
    if (file && !g.File) Object.assign(blob, file);
    valueIds.set(blob, id);
    return blob;
  }
  const blob = Object.create((file && g.File ? g.File : g.Blob).prototype) as Record<string, unknown>;
  let bytes: Uint8Array | null = null, loading: Promise<Uint8Array> | null = null;
  const load = async () => {
    const out = new Uint8Array(size);
    for (let i = 0, n = read.parts(size); i < n && !bytes; i++) { if (i) await nextTurn(); if (!bytes) read.part(id, size, i, out); }
    return bytes ??= out;
  };
  const loaded = () => bytes ? Promise.resolve(bytes) : loading ??= load();
  Object.defineProperty(blob, 'bytes', {get: () => bytes ??= read.all(id, size), enumerable: true, configurable: true});
  Object.defineProperty(blob, 'size', {value: size, enumerable: true, configurable: true});
  Object.defineProperty(blob, 'arrayBuffer', {value: async () => (await loaded()).slice().buffer, writable: true, configurable: true});
  Object.defineProperty(blob, 'text', {value: async () => new g.TextDecoder().decode(await loaded()), writable: true, configurable: true});
  blob.type = type;
  if (file) { blob.name = file.name; blob.lastModified = file.lastModified; }
  valueIds.set(blob, id);
  lazyBlobs.set(id, Weak ? new Weak(blob) : {deref: () => blob});
  return blob;
}

/** Before a value's stored bytes are dropped: a lazy Blob of it that is still alive reads them now. */
export function loadBeforeDrop(id: number) {
  const blob = lazyBlobs.get(id)?.deref() as {bytes?: Uint8Array} | undefined;
  if (blob) void blob.bytes;
  lazyBlobs.delete(id);
}
