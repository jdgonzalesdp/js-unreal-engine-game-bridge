/** ReadableStream as the WHATWG Streams standard defines it, for an engine without one (Puerts' V8). A fetch body is
 *  one (fetchStream.ts, fetchCore.ts), and so are Blob.stream(), the text and compression streams (streamsCodec.ts)
 *  and anything a page builds itself: three.js's FileLoader rewraps every download in one to report progress, and the
 *  Spark splat reader decodes a PLY header through one. A source's start, pull and cancel run as the standard orders
 *  them: pull only after start settles, again only when a reader is waiting or the queue is under its high-water
 *  mark, never twice at once. A 'bytes' source is taken as a default one whose chunks must be views (byobRequest is
 *  null); a BYOB reader copies from the queue into the caller's view. */
import {iterate, pipeStream, teeStream} from './streamsPipe';

const g = globalThis as Record<string, any>;

type Result = {value: unknown; done: boolean};
type Request = {resolve(r: Result): void; reject(e: unknown): void};
type Source = {start?(c: Controller): unknown; pull?(c: Controller): unknown; cancel?(reason: unknown): unknown; type?: string; autoAllocateChunkSize?: number};
type Strategy = {highWaterMark?: number; size?(chunk: unknown): number};

const handled = <T>(p: Promise<T>) => { p.catch(() => undefined); return p; };
const typeError = (m: string) => new TypeError(m);

export class ReadableStreamDefaultController {
  /** @internal */ _queue: {value: unknown; size: number}[] = [];
  /** @internal */ _size = 0;
  /** @internal */ _closeRequested = false;
  private started = false; private pulling = false; private pullAgain = false;
  constructor(/** @internal */ readonly _stream: ReadableStream, private source: Source, private hwm: number,
    private sizeOf: (chunk: unknown) => number, /** @internal */ readonly _bytes: boolean) {}

  get desiredSize(): number | null { const s = this._stream._state; return s === 'errored' ? null : s === 'closed' ? 0 : this.hwm - this._size; }
  get byobRequest() { return null; }

  enqueue(chunk: unknown) {
    if (this._closeRequested || this._stream._state !== 'readable') throw typeError('The stream is closed or closing and cannot take more chunks.');
    if (this._bytes && !ArrayBuffer.isView(chunk)) throw typeError('A byte stream takes only ArrayBuffer views.');
    const reader = this._stream._reader;
    if (reader && reader._requests.length) reader._requests.shift()!.resolve({value: chunk, done: false});
    else {
      let size: number;
      try { size = Number(this.sizeOf(chunk)); if (!(size >= 0) || size === Infinity) throw new RangeError('A chunk size must be a finite, non-negative number.'); }
      catch (e) { this.error(e); throw e; }
      this._queue.push({value: chunk, size}); this._size += size;
    }
    this._pullIfNeeded();
  }
  close() {
    if (this._closeRequested || this._stream._state !== 'readable') throw typeError('The stream is already closed or closing.');
    this._closeRequested = true;
    if (!this._queue.length) closeStream(this._stream);
  }
  error(e?: unknown) {
    if (this._stream._state !== 'readable') return;
    this._queue = []; this._size = 0;
    errorStream(this._stream, e);
  }

  /** @internal */ _start() {
    const result = this.source.start?.call(this.source, this);
    Promise.resolve(result).then(() => { this.started = true; this._pullIfNeeded(); }, e => this.error(e));
  }
  /** @internal */ _pullIfNeeded() {
    const stream = this._stream;
    if (!this.started || this._closeRequested || stream._state !== 'readable') return;
    const waiting = !!stream._reader?._requests.length;
    if (!waiting && !((this.desiredSize ?? 0) > 0)) return;
    if (this.pulling) { this.pullAgain = true; return; }
    this.pulling = true;
    let p: Promise<unknown>;
    try { p = Promise.resolve(this.source.pull?.call(this.source, this)); } catch (e) { p = Promise.reject(e); }
    p.then(() => { this.pulling = false; if (this.pullAgain) { this.pullAgain = false; this._pullIfNeeded(); } }, e => this.error(e));
  }
  /** @internal */ _read(reader: ReadableStreamDefaultReader): Promise<Result> {
    if (this._queue.length) {
      const {value, size} = this._queue.shift()!;
      this._size = this._queue.length ? this._size - size : 0;
      if (this._closeRequested && !this._queue.length) closeStream(this._stream); else this._pullIfNeeded();
      return Promise.resolve({value, done: false});
    }
    const p = new Promise<Result>((resolve, reject) => reader._requests.push({resolve, reject}));
    this._pullIfNeeded();
    return p;
  }
  /** @internal */ _cancel(reason: unknown): Promise<void> {
    this._queue = []; this._size = 0;
    try { return Promise.resolve(this.source.cancel?.call(this.source, reason)).then(() => undefined); } catch (e) { return Promise.reject(e); }
  }
}

function closeStream(stream: ReadableStream) {
  stream._state = 'closed';
  const reader = stream._reader;
  if (!reader) return;
  for (const r of reader._requests.splice(0)) r.resolve({value: undefined, done: true});
  reader._settle(null);
}
function errorStream(stream: ReadableStream, e: unknown) {
  stream._state = 'errored'; stream._error = e;
  const reader = stream._reader;
  if (!reader) return;
  for (const r of reader._requests.splice(0)) r.reject(e);
  reader._settle(e, true);
}
function cancelStream(stream: ReadableStream, reason: unknown): Promise<void> {
  stream._disturbed = true;
  if (stream._state === 'closed') return Promise.resolve();
  if (stream._state === 'errored') return Promise.reject(stream._error);
  closeStream(stream);
  return stream._ctrl._cancel(reason);
}

export class ReadableStreamDefaultReader {
  /** @internal */ _requests: Request[] = [];
  /** @internal */ _stream: ReadableStream | null;
  private closedPromise!: Promise<void>; private closedDone!: (e: unknown, failed?: boolean) => void;
  constructor(stream: ReadableStream) {
    if (!(stream instanceof ReadableStream)) throw typeError('ReadableStreamDefaultReader needs a ReadableStream.');
    if (stream.locked) throw typeError('This stream is already locked to a reader.');
    stream._reader = this; this._stream = stream;
    this.newClosed();
    if (stream._state === 'closed') this._settle(null);
    else if (stream._state === 'errored') this._settle(stream._error, true);
  }
  get closed() { return this.closedPromise; }
  read(): Promise<Result> {
    const s = this._stream;
    if (!s) return Promise.reject(typeError('This reader has been released.'));
    s._disturbed = true;
    if (s._state === 'closed') return Promise.resolve({value: undefined, done: true});
    if (s._state === 'errored') return Promise.reject(s._error);
    return s._ctrl._read(this);
  }
  cancel(reason?: unknown): Promise<void> { return this._stream ? cancelStream(this._stream, reason) : Promise.reject(typeError('This reader has been released.')); }
  releaseLock() {
    const s = this._stream;
    if (!s) return;
    const e = typeError('The reader was released.');
    for (const r of this._requests.splice(0)) r.reject(e);
    if (s._state === 'readable') this._settle(e, true); else { this.newClosed(); this._settle(e, true); }
    s._reader = null; this._stream = null;
  }
  /** @internal */ _settle(e: unknown, failed = false) { this.closedDone(e, failed); }
  private newClosed() {
    let resolve!: () => void, reject!: (e: unknown) => void, done = false;
    this.closedPromise = handled(new Promise<void>((a, b) => { resolve = a; reject = b; }));
    this.closedDone = (e, failed) => { if (done) return; done = true; if (failed) reject(e); else resolve(); };
  }
}

/** A BYOB reader: each read fills the caller's view from the next queued bytes and keeps the rest queued. */
export class ReadableStreamBYOBReader extends ReadableStreamDefaultReader {
  constructor(stream: ReadableStream) {
    if (!stream?._ctrl?._bytes) throw typeError('A BYOB reader needs a byte stream.');
    super(stream);
  }
  async read(view?: unknown): Promise<Result> {
    if (!ArrayBuffer.isView(view) || !view.byteLength) throw typeError('read() needs a non-empty ArrayBuffer view.');
    const into = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const r = await super.read();
    const Kind = (view as {constructor: new (b: ArrayBufferLike, o: number, n: number) => unknown}).constructor;
    const per = (view as unknown as {BYTES_PER_ELEMENT?: number}).BYTES_PER_ELEMENT ?? 1;
    if (r.done) return {value: new Kind(view.buffer, view.byteOffset, 0), done: true};
    const v = r.value as ArrayBufferView, src = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    let n = Math.min(into.length, src.length);
    if (per > 1 && n >= per) n -= n % per;
    into.set(src.subarray(0, n));
    if (n < src.length) { const c = this._stream?._ctrl; if (c) { c._queue.unshift({value: src.slice(n), size: src.length - n}); c._size += src.length - n; } }
    return {value: new Kind(view.buffer, view.byteOffset, Math.floor(n / per)), done: false};
  }
}

export class ReadableStream {
  /** @internal */ _state: 'readable' | 'closed' | 'errored' = 'readable';
  /** @internal */ _reader: ReadableStreamDefaultReader | null = null;
  /** @internal */ _error: unknown;
  /** @internal */ _disturbed = false;
  /** @internal */ _ctrl: ReadableStreamDefaultController;
  constructor(source: Source | null = {}, strategy: Strategy | null = {}) {
    const src = source ?? {}, type = src.type === undefined ? undefined : String(src.type);
    if (type !== undefined && type !== 'bytes') throw new RangeError(`Invalid type ${type} for a ReadableStream source.`);
    const bytes = type === 'bytes', hwm = strategy?.highWaterMark ?? (bytes ? 0 : 1);
    if (!(hwm >= 0)) throw new RangeError('highWaterMark must be a non-negative number.');
    const size = bytes ? (c: unknown) => (c as ArrayBufferView).byteLength : strategy?.size ? strategy.size.bind(strategy) : () => 1;
    this._ctrl = new ReadableStreamDefaultController(this, src, hwm, size, bytes);
    this._ctrl._start();
  }
  get locked() { return this._reader !== null; }
  cancel(reason?: unknown): Promise<void> { return this.locked ? Promise.reject(typeError('A locked stream cannot be cancelled.')) : cancelStream(this, reason); }
  getReader(options?: {mode?: string}) {
    if (options?.mode === undefined) return new ReadableStreamDefaultReader(this);
    if (options.mode === 'byob') return new ReadableStreamBYOBReader(this);
    throw new RangeError(`Invalid reader mode ${options.mode}.`);
  }
  pipeThrough(transform: {readable: ReadableStream; writable: unknown}, options: Record<string, unknown> = {}) {
    if (this.locked) throw typeError('A locked stream cannot be piped.');
    handled(this.pipeTo(transform.writable as never, options));
    return transform.readable;
  }
  pipeTo(dest: unknown, options: Record<string, unknown> = {}): Promise<void> { return pipeStream(this, dest as never, options); }
  tee(): [ReadableStream, ReadableStream] { return teeStream(this); }
  values(options: {preventCancel?: boolean} = {}) { return iterate(this, !!options?.preventCancel); }
  [Symbol.asyncIterator](options: {preventCancel?: boolean} = {}) { return iterate(this, !!options?.preventCancel); }
  static from(items: AsyncIterable<unknown> | Iterable<unknown>) {
    const it = (items as AsyncIterable<unknown>)[Symbol.asyncIterator]?.() ?? (items as Iterable<unknown>)[Symbol.iterator]?.();
    if (!it) throw typeError('ReadableStream.from needs an iterable.');
    return new ReadableStream({
      async pull(c) { const r = await it.next(); if (r.done) c.close(); else c.enqueue(await r.value); },
      async cancel(reason) { await it.return?.(reason); },
    }, {highWaterMark: 0});
  }
}

/** Installs the classes where the engine has no ReadableStream. */
export function installReadableStream() {
  if (g.ReadableStream) return;
  g.ReadableStream = ReadableStream;
  g.ReadableStreamDefaultReader = ReadableStreamDefaultReader;
  g.ReadableStreamBYOBReader = ReadableStreamBYOBReader;
  g.ReadableStreamDefaultController = ReadableStreamDefaultController;
}
