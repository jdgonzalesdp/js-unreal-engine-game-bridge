/** The streams that encode as they go: TextDecoderStream and TextEncoderStream (the Spark splat reader decodes a PLY
 *  header through one), CompressionStream and DecompressionStream (a page gzips a scene upload with
 *  new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))), and Blob.prototype.stream(). Each is a
 *  TransformStream underneath (streamsWritable.ts), compressing with fflate's streaming coders chunk by chunk. */
import {Gzip, Gunzip, Zlib, Unzlib, Deflate, Inflate, gzipSync, gunzipSync, zlibSync, unzlibSync, deflateSync, inflateSync} from 'fflate';

const g = globalThis as Record<string, any>;
type Coder = {ondata: (data: Uint8Array, final: boolean) => void; push(chunk: Uint8Array, final?: boolean): void};
type Controller = {enqueue(chunk: unknown): void};

const viewBytes = (chunk: unknown): Uint8Array => {
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  throw new TypeError('The chunk must be an ArrayBuffer or a view of one.');
};

/** A text, compression or other coding stream: readable and writable sides over one TransformStream. */
class CodingStream {
  readonly readable: unknown; readonly writable: unknown;
  constructor(transformer: {transform(chunk: unknown, c: Controller): void; flush?(c: Controller): void}) {
    const t = new g.TransformStream(transformer);
    this.readable = t.readable; this.writable = t.writable;
  }
}

export class TextDecoderStream extends CodingStream {
  readonly encoding: string; readonly fatal: boolean; readonly ignoreBOM: boolean;
  constructor(label = 'utf-8', options: {fatal?: boolean; ignoreBOM?: boolean} = {}) {
    const decoder = new g.TextDecoder(label, options);
    super({
      transform(chunk, c) { const text = decoder.decode(viewBytes(chunk), {stream: true}); if (text) c.enqueue(text); },
      flush(c) { const text = decoder.decode(); if (text) c.enqueue(text); },
    });
    this.encoding = decoder.encoding; this.fatal = decoder.fatal; this.ignoreBOM = decoder.ignoreBOM;
  }
}

export class TextEncoderStream extends CodingStream {
  readonly encoding = 'utf-8';
  constructor() {
    const encoder = new g.TextEncoder();
    // A high surrogate at the end of a chunk waits for its pair at the start of the next.
    let held = '';
    super({
      transform(chunk, c) {
        let text = held + String(chunk); held = '';
        const last = text.charCodeAt(text.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) { held = text.slice(-1); text = text.slice(0, -1); }
        if (text) c.enqueue(encoder.encode(text));
      },
      flush(c) { if (held) c.enqueue(new Uint8Array([0xef, 0xbf, 0xbd])); },
    });
  }
}

const CODERS: Record<string, [() => Coder, () => Coder, (b: Uint8Array) => Uint8Array, (b: Uint8Array) => Uint8Array]> = {
  gzip: [() => new Gzip() as unknown as Coder, () => new Gunzip() as unknown as Coder, gzipSync, gunzipSync],
  deflate: [() => new Zlib() as unknown as Coder, () => new Unzlib() as unknown as Coder, zlibSync, unzlibSync],
  'deflate-raw': [() => new Deflate() as unknown as Coder, () => new Inflate() as unknown as Coder, deflateSync, inflateSync],
};

/** fflate's streaming coder as a transformer: every pushed chunk's output goes out as soon as fflate makes it. */
function coding(format: string, decode: boolean) {
  const kind = CODERS[String(format)];
  if (!kind) throw new TypeError(`Unsupported compression format: '${format}'`);
  const coder = (decode ? kind[1] : kind[0])();
  let out: Controller | null = null, ended = false;
  coder.ondata = (data: Uint8Array, final: boolean) => { if (data.length) out?.enqueue(data.slice()); if (final) ended = true; };
  const push = (bytes: Uint8Array, final: boolean, c: Controller) => {
    out = c;
    try { coder.push(bytes, final); } catch (e) { throw new TypeError(`The ${format} data could not be ${decode ? 'decompressed' : 'compressed'}: ${(e as Error)?.message ?? e}`); }
  };
  return {
    sync: (b: Uint8Array) => (decode ? kind[3] : kind[2])(b),
    transformer: {
      transform(chunk: unknown, c: Controller) { const b = viewBytes(chunk); if (b.length) push(b.slice(), false, c); },
      flush(c: Controller) { push(new Uint8Array(0), true, c); if (decode && !ended) throw new TypeError(`The ${format} data ended early.`); },
    },
  };
}

export class CompressionStream extends CodingStream {
  /** The whole-buffer coder, for the runtime's older buffered body (fetchCore.ts BufferedStream.pipeThrough). */
  readonly __transform: (b: Uint8Array) => Uint8Array;
  constructor(format: string) { const c = coding(format, false); super(c.transformer); this.__transform = c.sync; }
}
export class DecompressionStream extends CodingStream {
  readonly __transform: (b: Uint8Array) => Uint8Array;
  constructor(format: string) { const c = coding(format, true); super(c.transformer); this.__transform = c.sync; }
}

/** Installs the coding streams and Blob.prototype.stream where the engine has none. Blob.stream reads through the
 *  blob's own arrayBuffer(), so a file still on disk (fileApi.ts) is read when the stream is, not before. */
export function installCodingStreams() {
  g.TextDecoderStream ??= TextDecoderStream;
  g.TextEncoderStream ??= TextEncoderStream;
  g.CompressionStream ??= CompressionStream;
  g.DecompressionStream ??= DecompressionStream;
  const BP = g.Blob?.prototype as Record<string, any> | undefined;
  if (BP && !BP.stream) {
    BP.stream = function (this: {arrayBuffer(): Promise<ArrayBuffer>}) {
      const blob = this;
      return new g.ReadableStream({type: 'bytes', async pull(c: {enqueue(b: Uint8Array): void; close(): void}) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes.length) c.enqueue(bytes);
        c.close();
      }});
    };
  }
}
