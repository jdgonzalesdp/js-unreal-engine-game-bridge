/** WritableStream, TransformStream and the two queuing strategies of the WHATWG Streams standard, for an engine without
 *  them (Puerts' V8). Pipes (streamsReadable.ts) write into them, and the text and compression streams
 *  (streamsCodec.ts) are transform streams. Writes run one at a time in order; a writer's ready promise waits while
 *  the queue is at its high-water mark; a sink that fails errors the stream and every queued write. */
import {ReadableStream, type ReadableStreamDefaultController} from './streamsReadable';

const g = globalThis as Record<string, any>;
type Sink = {start?(c: unknown): unknown; write?(chunk: unknown, c: unknown): unknown; close?(): unknown; abort?(reason: unknown): unknown};
type Strategy = {highWaterMark?: number; size?(chunk: unknown): number};
type Item = {chunk?: unknown; size: number; close?: boolean; resolve(): void; reject(e: unknown): void};

const handled = <T>(p: Promise<T>) => { p.catch(() => undefined); return p; };
function deferred() {
  let resolve!: () => void, reject!: (e: unknown) => void;
  const promise = handled(new Promise<void>((a, b) => { resolve = a; reject = b; }));
  return {promise, resolve, reject};
}

export class WritableStream {
  /** @internal */ _state: 'writable' | 'closed' | 'errored' = 'writable';
  /** @internal */ _writer: WritableStreamDefaultWriter | null = null;
  /** @internal */ _error: unknown;
  /** @internal */ _size = 0;
  /** @internal */ readonly _hwm: number;
  private queue: Item[] = []; private writing = false; private started = false; private closing = false;
  private sizeOf: (chunk: unknown) => number; private abortController = g.AbortController ? new g.AbortController() : null;
  private controller: {error(e?: unknown): void; signal: unknown};
  constructor(private sink: Sink | null = {}, strategy: Strategy | null = {}) {
    this._hwm = strategy?.highWaterMark ?? 1;
    if (!(this._hwm >= 0)) throw new RangeError('highWaterMark must be a non-negative number.');
    this.sizeOf = strategy?.size ? strategy.size.bind(strategy) : () => 1;
    this.controller = {error: e => this._fail(e), signal: this.abortController?.signal};
    const sinkObject = this.sink ?? {};
    Promise.resolve(sinkObject.start?.call(sinkObject, this.controller)).then(() => { this.started = true; this.advance(); }, e => this._fail(e));
  }
  get locked() { return this._writer !== null; }
  abort(reason?: unknown) { return this.locked ? Promise.reject(new TypeError('A locked stream cannot be aborted.')) : this._abort(reason); }
  close() { return this.locked ? Promise.reject(new TypeError('A locked stream cannot be closed.')) : this._close(); }
  getWriter() { return new WritableStreamDefaultWriter(this); }

  /** @internal */ _write(chunk: unknown): Promise<void> {
    if (this._state === 'errored') return Promise.reject(this._error);
    if (this._state === 'closed' || this.closing) return Promise.reject(new TypeError('The stream is closed or closing.'));
    let size: number;
    try { size = Number(this.sizeOf(chunk)); if (!(size >= 0)) throw new RangeError('A chunk size must be a non-negative number.'); }
    catch (e) { this._fail(e); return Promise.reject(e); }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({chunk, size, resolve, reject}); this._size += size;
      this._writer?._backpressure();
      this.advance();
    });
  }
  /** @internal */ _close(): Promise<void> {
    if (this._state === 'errored') return Promise.reject(this._error);
    if (this._state === 'closed' || this.closing) return Promise.reject(new TypeError('The stream is already closed or closing.'));
    this.closing = true;
    return new Promise<void>((resolve, reject) => { this.queue.push({size: 0, close: true, resolve, reject}); this.advance(); });
  }
  /** @internal */ _abort(reason: unknown): Promise<void> {
    if (this._state !== 'writable') return Promise.resolve();
    this.abortController?.abort(reason);
    this._fail(reason);
    const sinkObject = this.sink ?? {};
    try { return Promise.resolve(sinkObject.abort?.call(sinkObject, reason)).then(() => undefined); } catch (e) { return Promise.reject(e); }
  }
  /** @internal */ _fail(e: unknown) {
    if (this._state !== 'writable') return;
    this._state = 'errored'; this._error = e;
    for (const item of this.queue.splice(0)) item.reject(e);
    this._size = 0;
    this._writer?._settle(e);
  }
  private advance() {
    if (!this.started || this.writing || !this.queue.length || this._state !== 'writable') return;
    const item = this.queue[0], sinkObject = this.sink ?? {};
    this.writing = true;
    const step = () => item.close ? sinkObject.close?.call(sinkObject) : sinkObject.write?.call(sinkObject, item.chunk, this.controller);
    Promise.resolve().then(step).then(() => {
      this.writing = false;
      if (this._state !== 'writable') { item.reject(this._error); return; }
      this.queue.shift(); this._size -= item.size;
      item.resolve();
      if (item.close) { this._state = 'closed'; this._writer?._settle(null); return; }
      this._writer?._backpressure();
      this.advance();
    }, e => { this.writing = false; this.queue.shift(); item.reject(e); this._fail(e); });
  }
}

export class WritableStreamDefaultWriter {
  private stream: WritableStream | null;
  private readyState = deferred(); private closedState = deferred(); private isReady = true;
  constructor(stream: WritableStream) {
    if (!(stream instanceof WritableStream)) throw new TypeError('WritableStreamDefaultWriter needs a WritableStream.');
    if (stream.locked) throw new TypeError('This stream is already locked to a writer.');
    stream._writer = this; this.stream = stream;
    if (stream._state === 'errored') { this.readyState.reject(stream._error); this.closedState.reject(stream._error); }
    else if (stream._state === 'closed') { this.readyState.resolve(); this.closedState.resolve(); }
    else { this.readyState.resolve(); this._backpressure(); }
  }
  get closed() { return this.closedState.promise; }
  get ready() { return this.readyState.promise; }
  get desiredSize() { const s = this.stream; if (!s) throw new TypeError('This writer has been released.'); return s._state === 'errored' ? null : s._state === 'closed' ? 0 : s._hwm - s._size; }
  write(chunk?: unknown) { return this.stream ? this.stream._write(chunk) : Promise.reject(new TypeError('This writer has been released.')); }
  close() { return this.stream ? this.stream._close() : Promise.reject(new TypeError('This writer has been released.')); }
  abort(reason?: unknown) { return this.stream ? this.stream._abort(reason) : Promise.reject(new TypeError('This writer has been released.')); }
  releaseLock() {
    const s = this.stream;
    if (!s) return;
    const e = new TypeError('The writer was released.');
    this.readyState = deferred(); this.readyState.reject(e);
    this.closedState = deferred(); this.closedState.reject(e);
    s._writer = null; this.stream = null;
  }
  /** @internal The ready promise waits while the queue is full and settles once it has room. */
  _backpressure() {
    const s = this.stream;
    if (!s || s._state !== 'writable') return;
    const full = s._hwm - s._size <= 0;
    if (full && this.isReady) this.readyState = deferred();
    else if (!full) this.readyState.resolve();
    this.isReady = !full;
  }
  /** @internal The stream closed (e null) or failed: a pending ready promise rejects, a settled one is replaced. */
  _settle(e: unknown) {
    if (e === null) { this.readyState.resolve(); this.closedState.resolve(); return; }
    if (this.isReady) this.readyState = deferred();
    this.readyState.reject(e); this.isReady = false;
    this.closedState.reject(e);
  }
}

type TransformController = {enqueue(c?: unknown): void; error(e?: unknown): void; terminate(): void; readonly desiredSize: number | null};
type Transformer = {start?(c: TransformController): unknown; transform?(chunk: unknown, c: TransformController): unknown; flush?(c: TransformController): unknown;
  cancel?(reason: unknown): unknown; readableType?: unknown; writableType?: unknown};

export class TransformStream {
  readonly readable: ReadableStream; readonly writable: WritableStream;
  constructor(transformer: Transformer | null = {}, writableStrategy: Strategy = {}, readableStrategy: Strategy = {}) {
    const t = transformer ?? {};
    let out!: ReadableStreamDefaultController, started!: Promise<unknown>;
    // Backpressure starts on: a write waits until the readable side is read from.
    let backpressure = true, change = deferred();
    const setBackpressure = (on: boolean) => { if (on !== backpressure) { change.resolve(); change = deferred(); } backpressure = on; };
    const controller: TransformController = {
      enqueue: chunk => { out.enqueue(chunk); const full = (out.desiredSize ?? 0) <= 0; if (full !== backpressure) setBackpressure(full); },
      error: e => { out.error(e); this.writable._fail(e); },
      terminate: () => { try { out.close(); } catch { /* already closed */ } this.writable._fail(new TypeError('The transform stream was terminated.')); },
      get desiredSize() { return out.desiredSize; },
    };
    // A transformer that throws, at once or later, errors both sides.
    const run = (chunk: unknown) => Promise.resolve().then(() => t.transform ? t.transform.call(t, chunk, controller) : controller.enqueue(chunk));
    this.readable = new ReadableStream({
      start(c) { out = c; },
      pull() { setBackpressure(false); return change.promise; },
      cancel: reason => { this.writable._fail(reason); return Promise.resolve(t.cancel?.call(t, reason)).then(() => undefined); },
    }, {highWaterMark: readableStrategy?.highWaterMark ?? 0, size: readableStrategy?.size});
    this.writable = new WritableStream({
      start: () => started,
      write: chunk => (backpressure ? change.promise.then(() => run(chunk)) : run(chunk)).catch(e => { controller.error(e); throw e; }),
      close: () => Promise.resolve().then(() => t.flush?.call(t, controller)).then(() => { try { out.close(); } catch { /* cancelled */ } }, e => { out.error(e); throw e; }),
      abort: reason => { out.error(reason); return t.cancel?.call(t, reason); },
    }, {highWaterMark: writableStrategy?.highWaterMark ?? 1, size: writableStrategy?.size});
    started = Promise.resolve(t.start?.call(t, controller));
  }
}

export class CountQueuingStrategy {
  readonly highWaterMark: number;
  constructor(init: {highWaterMark: number}) { this.highWaterMark = Number(init?.highWaterMark); }
  get size() { return () => 1; }
}
export class ByteLengthQueuingStrategy {
  readonly highWaterMark: number;
  constructor(init: {highWaterMark: number}) { this.highWaterMark = Number(init?.highWaterMark); }
  get size() { return (chunk: {byteLength: number}) => chunk.byteLength; }
}

/** Installs the classes where the engine has none. */
export function installWritableStreams() {
  g.WritableStream ??= WritableStream;
  g.WritableStreamDefaultWriter ??= WritableStreamDefaultWriter;
  g.TransformStream ??= TransformStream;
  g.CountQueuingStrategy ??= CountQueuingStrategy;
  g.ByteLengthQueuingStrategy ??= ByteLengthQueuingStrategy;
}
