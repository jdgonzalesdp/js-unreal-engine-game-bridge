/** structuredClone as a browser does it, for V8 builds without one (Puerts' V8 9.4). IndexedDB clones every value on
 *  the way in and on the way out with it, so it keeps what a browser keeps: Blob and File, ArrayBuffer, every typed
 *  array and DataView (views of one buffer stay views of one buffer), Date, RegExp, Map, Set, boxed primitives, errors,
 *  sparse arrays, shared references and cycles. Functions, symbols, promises and weak collections throw DataCloneError,
 *  as in a browser. A Blob is immutable, so its clone is the same Blob. */
import './domException';

const g = globalThis as Record<string, any>;

/** An object standing in for a value it can produce (indexedDbLazy.ts: bytes still in the host's store): its clone is
 *  the clone of that value. */
export const CLONE_AS = Symbol.for('jsgb.cloneAs');

const VIEWS = new Set(['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array']);
const ERRORS = new Set(['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError']);
const UNCLONEABLE = new Set(['Promise', 'WeakMap', 'WeakSet', 'WeakRef', 'Function', 'AsyncFunction', 'GeneratorFunction', 'Symbol']);

export function dataCloneError(what: string): Error {
  return new g.DOMException(`${what} could not be cloned.`, 'DataCloneError');
}

const setOwn = (out: Record<string, unknown>, k: string, v: unknown) => {
  if (k === '__proto__') Object.defineProperty(out, k, {value: v, writable: true, enumerable: true, configurable: true});
  else out[k] = v;
};

export function cloneValue(value: unknown): unknown {
  const seen = new Map<object, unknown>();
  const walk = (v: any): any => {
    if (typeof v === 'function') throw dataCloneError(`${v.name || 'A function'}`);
    if (typeof v === 'symbol') throw dataCloneError(String(v));
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return seen.get(v);
    if (typeof v[CLONE_AS] === 'function') { const out = walk(v[CLONE_AS]()); seen.set(v, out); return out; }
    if (g.Blob && v instanceof g.Blob) { seen.set(v, v); return v; }
    const tag = Object.prototype.toString.call(v).slice(8, -1);
    let out: any;
    if (tag === 'ArrayBuffer') out = (v as ArrayBuffer).slice(0);
    else if (tag === 'DataView') out = new DataView(walk(v.buffer), v.byteOffset, v.byteLength);
    else if (VIEWS.has(tag) && ArrayBuffer.isView(v)) out = new g[tag](walk((v as Uint8Array).buffer), v.byteOffset, (v as Uint8Array).length);
    else if (tag === 'Date') out = new Date(v.getTime());
    else if (tag === 'RegExp') out = new RegExp(v.source, v.flags);
    else if (tag === 'Boolean' || tag === 'Number' || tag === 'String' || tag === 'BigInt') out = Object(v.valueOf());
    else if (tag === 'Map') { out = new Map(); seen.set(v, out); for (const [k, x] of v) out.set(walk(k), walk(x)); return out; }
    else if (tag === 'Set') { out = new Set(); seen.set(v, out); for (const x of v) out.add(walk(x)); return out; }
    else if (g.DOMException && v instanceof g.DOMException) out = new g.DOMException(v.message, v.name);
    else if (tag === 'Error' || v instanceof Error) {
      const name = ERRORS.has(v.name) ? v.name : 'Error';
      out = new g[name](String(v.message ?? ''));
      if (typeof v.stack === 'string') Object.defineProperty(out, 'stack', {value: v.stack, writable: true, configurable: true});
    } else if (UNCLONEABLE.has(tag)) throw dataCloneError(tag);
    else {
      out = Array.isArray(v) ? new Array(v.length) : {};
      seen.set(v, out);
      for (const k of Object.keys(v)) setOwn(out, k, walk(v[k]));
      return out;
    }
    seen.set(v, out);
    return out;
  };
  return walk(value);
}

const installed = (value: unknown) => cloneValue(value);
/** Installs structuredClone where the engine has none. */
export function installStructuredClone() {
  if (typeof g.structuredClone !== 'function') g.structuredClone = installed;
}
/** True when structuredClone is this one, which knows the stand-ins of CLONE_AS. */
export const ownsStructuredClone = () => g.structuredClone === installed;
