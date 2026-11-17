/** The text an IndexedDB key or value is kept as in the host's store (indexedDb.ts). Plain data is plain JSON; anything
 *  JSON can't hold is a tagged object {"$": tag, ...}: undefined, NaN, -0 and the infinities, bigints, Date, RegExp, Map,
 *  Set, boxed primitives, errors, sparse arrays, and binaries (ArrayBuffer, typed arrays, DataView, Blob, File) as
 *  base64. A binary of BIG bytes or more (a Blob from BIG_BLOB) is written once into its own host entries and named by
 *  its value id. A key starting with "$" gets one more "$". An object seen twice is written once and referred to by
 *  its order of first appearance ({"$":"@"}), so shared references and cycles come back as they were. */
import {StoredBytes, StoredView} from './indexedDbLazy';
import {dataCloneError} from './structuredClone';
import {base64Bytes, bytesBase64} from './base64';

const g = globalThis as Record<string, any>;
export const BIG = 32 * 1024;
/** Blobs never change, so one stored apart is never written again: from 4 KB they stay out of journal entries and
 *  snapshots, which a compaction rewrites and every start reads. */
export const BIG_BLOB = 4 * 1024;

/** Where large binaries go while encoding: the value id that names the binary owned by `owner`. */
export interface Sink { binary(owner: object, size: number, bytes: () => Uint8Array): number }
/** Where large binaries come from while decoding. */
export interface Source {
  buffer(id: number, size: number): ArrayBuffer | StoredBytes;
  blob(id: number, size: number, type: string, file?: {name: string; lastModified: number}): object;
}
export type Encoded = {text: string; plain: boolean};

const VIEWS = new Set(['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'DataView']);
const ERRORS = new Set(['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError']);
const str = JSON.stringify;

/** Bytes of a Blob, read synchronously: the runtime's Blob keeps them (polyfills.ts). */
function blobBytes(blob: {bytes?: unknown}): Uint8Array {
  if (blob.bytes instanceof Uint8Array) return blob.bytes;
  throw dataCloneError('A Blob whose bytes cannot be read synchronously');
}

/** Encodes a value; sink null keeps every binary inline (keys). plain: no tags, so JSON.parse alone decodes it. */
export function encode(value: unknown, sink: Sink | null): Encoded {
  const seen = new Map<object, number>();
  let plain = true;
  const tag = (t: string, rest = '') => { plain = false; return `{"$":"${t}"${rest}}`; };
  const binary = (owner: object, size: number, bytes: () => Uint8Array, min = BIG) => sink && size >= min
    ? `,"x":${sink.binary(owner, size, bytes)},"n":${size}` : `,"b":"${bytesBase64(bytes())}"`;
  const walk = (v: any): string => {
    switch (typeof v) {
      case 'string': return str(v);
      case 'boolean': return v ? 'true' : 'false';
      case 'number': return Number.isFinite(v) && !Object.is(v, -0) ? String(v) : tag('n', `,"v":"${Object.is(v, -0) ? '-0' : String(v)}"`);
      case 'undefined': return tag('u');
      case 'bigint': return tag('i', `,"v":"${v}"`);
      case 'object': break;
      default: throw dataCloneError(typeof v);
    }
    if (v === null) return 'null';
    const ref = seen.get(v);
    if (ref !== undefined) return tag('@', `,"i":${ref}`);
    seen.set(v, seen.size);
    if (v instanceof StoredBytes) return tag('ab', binary(v, v.size, () => v.bytes));
    if (v instanceof StoredView) return tag('v', `,"t":"${v.type}","o":${v.offset},"l":${v.length},"b":${walk(v.source)}`);
    if (g.Blob && v instanceof g.Blob) {
      const file = g.File && v instanceof g.File ? `,"f":${str(String(v.name))},"m":${Number(v.lastModified) || 0}` : '';
      return tag('B', `,"t":${str(String(v.type ?? ''))}${file}${binary(v, v.size, () => blobBytes(v), BIG_BLOB)}`);
    }
    const t = Object.prototype.toString.call(v).slice(8, -1);
    if (t === 'ArrayBuffer') return tag('ab', binary(v, v.byteLength, () => new Uint8Array(v)));
    if (VIEWS.has(t) && ArrayBuffer.isView(v)) {
      const length = t === 'DataView' ? v.byteLength : (v as Uint8Array).length;
      return tag('v', `,"t":"${t}","o":${v.byteOffset},"l":${length},"b":${walk(v.buffer)}`);
    }
    if (t === 'Date') { const ms = v.getTime(); return tag('d', `,"v":${Number.isNaN(ms) ? 'null' : ms}`); }
    if (t === 'RegExp') return tag('r', `,"s":${str(v.source)},"f":${str(v.flags)}`);
    if (t === 'Map') { const parts: string[] = []; for (const [k, x] of v) parts.push(walk(k), walk(x)); return tag('m', `,"v":[${parts.join(',')}]`); }
    if (t === 'Set') { const parts: string[] = []; for (const x of v) parts.push(walk(x)); return tag('s', `,"v":[${parts.join(',')}]`); }
    if (t === 'Boolean' || t === 'Number' || t === 'String' || t === 'BigInt') return tag('o', `,"t":"${t}","v":${walk(v.valueOf())}`);
    if (v instanceof Error) {
      const kind = g.DOMException && v instanceof g.DOMException ? 'DOMException' : ERRORS.has(v.name) ? v.name : 'Error';
      return tag('e', `,"c":"${kind}","t":${str(String(v.name))},"m":${str(String(v.message ?? ''))},"k":${str(String(v.stack ?? ''))}`);
    }
    const keys = Object.keys(v);
    if (Array.isArray(v)) {
      // Dense: as many keys as elements, the last of them the last index (index keys come first, in order).
      if (keys.length === v.length && (!keys.length || keys[keys.length - 1] === String(v.length - 1))) { const parts = new Array<string>(v.length); for (let i = 0; i < v.length; i++) parts[i] = walk(v[i]); return `[${parts.join(',')}]`; }
      return tag('a', `,"n":${v.length},"v":${object(v, keys)}`);
    }
    return object(v, keys);
  };
  const object = (v: Record<string, unknown>, keys: string[]) => {
    const parts = new Array<string>(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.charCodeAt(0) === 36) plain = false;
      parts[i] = str(k.charCodeAt(0) === 36 ? '$' + k : k) + ':' + walk(v[k]);
    }
    return `{${parts.join(',')}}`;
  };
  const text = walk(value);
  return {text, plain};
}

/** Rebuilds a value from its parsed text (JSON.parse of encode's text). */
export function decode(shape: unknown, source: Source): unknown {
  const refs: unknown[] = [];
  const own = (out: Record<string, unknown>, k: string, v: unknown) => {
    if (k === '__proto__') Object.defineProperty(out, k, {value: v, writable: true, enumerable: true, configurable: true});
    else out[k] = v;
  };
  const fill = (out: Record<string, unknown>, s: Record<string, unknown>) => {
    for (const k of Object.keys(s)) own(out, k.charCodeAt(0) === 36 ? k.slice(1) : k, walk(s[k]));
    return out;
  };
  const bytes = (s: any) => s.x === undefined ? base64Bytes(s.b) : null;
  const walk = (s: any): any => {
    if (s === null || typeof s !== 'object') return s;
    if (Array.isArray(s)) { const out = new Array(s.length); refs.push(out); for (let i = 0; i < s.length; i++) out[i] = walk(s[i]); return out; }
    const t = s.$;
    if (t === undefined) { const out = {}; refs.push(out); return fill(out, s); }
    switch (t) {
      case 'u': return undefined;
      case 'n': return Number(s.v);
      case 'i': return BigInt(s.v);
      case '@': return refs[s.i];
    }
    const at = refs.push(undefined) - 1;
    const keep = (v: unknown) => { refs[at] = v; return v; };
    switch (t) {
      case 'ab': { const b = bytes(s); return keep(b ? b.slice().buffer : source.buffer(s.x, s.n)); }
      case 'v': {
        const buffer = walk(s.b);
        return keep(buffer instanceof StoredBytes ? new StoredView(s.t, buffer, s.o, s.l) : new g[s.t](buffer, s.o, s.l));
      }
      case 'B': {
        const file = s.f === undefined ? undefined : {name: s.f, lastModified: s.m};
        const b = bytes(s);
        if (!b) return keep(source.blob(s.x, s.n, s.t, file));
        if (file && g.File) return keep(new g.File([b], file.name, {type: s.t, lastModified: file.lastModified}));
        return keep(file ? Object.assign(new g.Blob([b], {type: s.t}), file) : new g.Blob([b], {type: s.t}));
      }
      case 'd': return keep(new Date(s.v === null ? NaN : s.v));
      case 'r': return keep(new RegExp(s.s, s.f));
      case 'm': { const out = keep(new Map()) as Map<unknown, unknown>; for (let i = 0; i < s.v.length; i += 2) out.set(walk(s.v[i]), walk(s.v[i + 1])); return out; }
      case 's': { const out = keep(new Set()) as Set<unknown>; for (const x of s.v) out.add(walk(x)); return out; }
      case 'o': return keep(Object(walk(s.v)));
      case 'e': {
        const out = s.c === 'DOMException' ? new g.DOMException(s.m, s.t) : new (ERRORS.has(s.c) ? g[s.c] : Error)(s.m);
        if (s.k) Object.defineProperty(out, 'stack', {value: s.k, writable: true, configurable: true});
        return keep(out);
      }
      case 'a': { const out = keep(new Array(s.n)) as Record<string, unknown>; return fill(out, s.v); }
    }
    throw new Error(`IndexedDB store: unknown value tag ${String(t)}`);
  };
  return walk(shape);
}
