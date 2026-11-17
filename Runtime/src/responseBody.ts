/** A Response's body as a browser has it (fetchCore.ts uses these): `body` is a real byte ReadableStream, the same one
 *  on every read of the property, and a Response can be built from a stream (a network reply still arriving, or a
 *  stream the page made) and read whole with arrayBuffer(), text(), json() or blob() once it ends.
 *  The file a body came from follows its bytes through a stream: three.js's FileLoader rewraps each download in a
 *  stream of its own and reads that, and the audio decoder names the sound file it plays from the buffer's origin. */
const g = globalThis as Record<string, any>;

/** Which URL a body chunk's buffer was read from. */
const chunkOrigin = new WeakMap<ArrayBufferLike, string>();

export const isReadableStream = (x: unknown): x is {getReader(): {read(): Promise<{value?: unknown; done: boolean}>; releaseLock(): void}; locked: boolean} =>
  !!x && typeof (x as {getReader?: unknown}).getReader === 'function' && typeof (x as {pipeTo?: unknown}).pipeTo === 'function';

/** The body stream of bytes already in memory: one chunk, a view of them (the Response hands them over, as a browser
 *  hands a body over once). Null without a ReadableStream class (the older buffered body then serves). */
export function bytesStream(bytes: ArrayBuffer, url: string): unknown {
  if (!g.ReadableStream) return null;
  if (url) chunkOrigin.set(bytes, url);
  return new g.ReadableStream({type: 'bytes', start(c: {enqueue(v: Uint8Array): void; close(): void}) { if (bytes.byteLength) c.enqueue(new Uint8Array(bytes)); c.close(); }});
}

/** Reads a stream to its end: the bytes, and the URL they came from when every chunk came from the same one. */
export async function readStream(stream: unknown): Promise<{bytes: ArrayBuffer; origin: string}> {
  if (!isReadableStream(stream)) throw new TypeError('The body is not a readable stream.');
  if (stream.locked) throw new TypeError('The body has already been read.');
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let total = 0, origin: string | undefined;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      const v = value as ArrayBufferView | ArrayBuffer | string;
      const chunk = typeof v === 'string' ? new g.TextEncoder().encode(v) as Uint8Array : v instanceof ArrayBuffer ? new Uint8Array(v)
        : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null;
      if (!chunk) throw new TypeError('A body chunk must be bytes.');
      const from = chunkOrigin.get(chunk.buffer) ?? '';
      origin = origin === undefined ? from : origin === from ? origin : '';
      chunks.push(chunk); total += chunk.byteLength;
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return {bytes: out.buffer, origin: origin ?? ''};
}

/** Marks a body chunk as coming from url (fetchStream.ts, for network chunks). */
export function markChunk(chunk: Uint8Array, url: string) { if (url) chunkOrigin.set(chunk.buffer, url); }
