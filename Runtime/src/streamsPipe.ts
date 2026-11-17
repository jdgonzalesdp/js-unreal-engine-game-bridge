/** The parts of ReadableStream that move chunks elsewhere (streamsReadable.ts): pipeTo and pipeThrough, tee and async
 *  iteration, as the WHATWG Streams standard has them. */
import type {ReadableStream, ReadableStreamDefaultReader, ReadableStreamDefaultController} from './streamsReadable';

const g = globalThis as Record<string, any>;
type Result = {value: unknown; done: boolean};
const typeError = (m: string) => new TypeError(m);

export async function* iterate(stream: ReadableStream, preventCancel: boolean) {
  const reader = stream.getReader() as ReadableStreamDefaultReader;
  let finished = false;
  try {
    for (;;) { const r = await reader.read(); if (r.done) { finished = true; return; } yield r.value; }
  } catch (e) { finished = true; throw e; } finally {
    if (!finished && !preventCancel) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Two branches that each get every chunk; a byte stream's second branch gets copies, as the standard has it. */
export function teeStream(stream: ReadableStream): [ReadableStream, ReadableStream] {
  const reader = stream.getReader() as ReadableStreamDefaultReader, bytes = stream._ctrl._bytes;
  const canceled = [false, false], reasons: unknown[] = [undefined, undefined], ctrls: ReadableStreamDefaultController[] = [];
  let reading = false, ended = false, cancelDone!: () => void;
  const cancelled = new Promise<void>(r => { cancelDone = r; });
  const pull = () => {
    if (reading || ended) return Promise.resolve();
    reading = true;
    reader.read().then(({value, done}) => {
      reading = false;
      if (done) { ended = true; ctrls.forEach((c, i) => { if (!canceled[i]) c.close(); }); cancelDone(); return; }
      ctrls.forEach((c, i) => {
        if (canceled[i]) return;
        const copy = i === 1 && bytes && ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice() : value;
        try { c.enqueue(copy); } catch { /* a branch closed meanwhile */ }
      });
    }, e => { reading = false; ended = true; ctrls.forEach(c => c.error(e)); cancelDone(); });
    return Promise.resolve();
  };
  const Stream = stream.constructor as typeof ReadableStream;
  const branch = (i: number) => new Stream({
    type: bytes ? 'bytes' : undefined,
    start(c) { ctrls[i] = c; },
    pull,
    cancel(reason) {
      canceled[i] = true; reasons[i] = reason;
      if (canceled[0] && canceled[1]) reader.cancel(reasons).then(cancelDone, cancelDone);
      return cancelled;
    },
  });
  return [branch(0), branch(1)];
}

type Writer = {ready: Promise<void>; closed: Promise<void>; write(c: unknown): Promise<void>; close(): Promise<void>; abort(r: unknown): Promise<void>; releaseLock(): void};
type Writable = {locked: boolean; getWriter(): Writer; _state?: string};

export function pipeStream(source: ReadableStream, dest: Writable, options: Record<string, unknown>): Promise<void> {
  if (source.locked) return Promise.reject(typeError('A locked stream cannot be piped.'));
  if (!dest || typeof dest.getWriter !== 'function') return Promise.reject(typeError('pipeTo needs a WritableStream.'));
  if (dest.locked) return Promise.reject(typeError('The destination is locked.'));
  const {preventClose = false, preventAbort = false, preventCancel = false} = options as Record<string, boolean>;
  const signal = options.signal as {aborted?: boolean; reason?: unknown; addEventListener?(t: string, f: () => void): void; removeEventListener?(t: string, f: () => void): void} | undefined;
  const reader = source.getReader() as ReadableStreamDefaultReader, writer = dest.getWriter();
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (error?: unknown, failed = false) => {
      if (done) return;
      done = true;
      signal?.removeEventListener?.('abort', onAbort);
      try { writer.releaseLock(); } catch { /* already released */ }
      try { reader.releaseLock(); } catch { /* already released */ }
      if (failed) reject(error); else resolve();
    };
    const onAbort = () => {
      const e = signal?.reason ?? new (g.DOMException ?? Error)('The pipe was aborted.', 'AbortError');
      const steps: Promise<unknown>[] = [];
      if (!preventAbort) steps.push(writer.abort(e).catch(() => undefined));
      if (!preventCancel) steps.push(reader.cancel(e).catch(() => undefined));
      Promise.all(steps).then(() => finish(e, true));
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener?.('abort', onAbort);
    // The destination failing (its writer's closed rejects) cancels the source.
    writer.closed.catch(e => { if (done) return; (preventCancel ? Promise.resolve() : reader.cancel(e).catch(() => undefined)).then(() => finish(e, true)); });
    (async () => {
      for (;;) {
        try { await writer.ready; } catch { return; }
        let r: Result;
        try { r = await reader.read(); } catch (e) {
          if (done) return;
          if (!preventAbort) await writer.abort(e).catch(() => undefined);
          finish(e, true); return;
        }
        if (done) return;
        if (r.done) {
          if (preventClose) { finish(); return; }
          try { await writer.close(); finish(); } catch (e) { finish(e, true); }
          return;
        }
        writer.write(r.value).catch(() => undefined);
      }
    })();
  });
}
