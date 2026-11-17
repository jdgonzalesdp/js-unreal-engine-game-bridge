/** Image files from canvas pixels, as canvas.toBlob, toDataURL and OffscreenCanvas.convertToBlob write them: JPEG for
 *  "image/jpeg", PNG for everything else (a browser that can't write a type writes PNG, and says so in the type).
 *  The host encodes when it can (JsgbMedia.cpp); Web Workers and hosts without it encode here. */
import {zlibSync} from 'fflate';
import jpeg from 'jpeg-js';
import {media, type Pixels} from './media';
import {OffscreenCanvasImpl} from './canvas2d';

export type Encoded = {bytes: Uint8Array; type: 'image/jpeg' | 'image/png'};

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array, from: number, to: number): number { let c = 0xffffffff; for (let i = from; i < to; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** An RGBA PNG: each row with filter 0, deflated. */
export function encodePng(p: Pixels): Uint8Array {
  const row = p.width * 4, raw = new Uint8Array((row + 1) * p.height);
  for (let y = 0; y < p.height; y++) raw.set(p.data.subarray(y * row, y * row + row), y * (row + 1) + 1);
  const idat = zlibSync(raw, {level: 6});
  const chunks: [string, Uint8Array][] = [['IHDR', new Uint8Array(13)], ['IDAT', idat], ['IEND', new Uint8Array(0)]];
  const hdr = new DataView(chunks[0][1].buffer);
  hdr.setUint32(0, p.width); hdr.setUint32(4, p.height); chunks[0][1][8] = 8; chunks[0][1][9] = 6;
  const out = new Uint8Array(8 + chunks.reduce((n, [, d]) => n + 12 + d.length, 0)), dv = new DataView(out.buffer);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let o = 8;
  for (const [name, data] of chunks) {
    dv.setUint32(o, data.length); for (let i = 0; i < 4; i++) out[o + 4 + i] = name.charCodeAt(i);
    out.set(data, o + 8); dv.setUint32(o + 8 + data.length, crc32(out, o + 4, o + 8 + data.length)); o += 12 + data.length;
  }
  return out;
}

/** A baseline JPEG. jpeg-js hands its bytes to Buffer.from when it runs as a CommonJS module, so a stand-in is there
 *  for the call when the engine has no Buffer. */
export function encodeJpeg(p: Pixels, quality: number): Uint8Array {
  const g = globalThis as Record<string, unknown>, had = 'Buffer' in g;
  if (!had) g.Buffer = {from: (a: ArrayLike<number>) => Uint8Array.from(a)};
  try { return new Uint8Array(jpeg.encode({data: p.data, width: p.width, height: p.height}, Math.round(Math.min(1, Math.max(0, quality)) * 100)).data as Uint8Array); }
  finally { if (!had) delete g.Buffer; }
}

export function encodeImage(p: Pixels, type?: unknown, quality?: unknown): Encoded {
  const jpg = /^image\/jpe?g$/i.test(String(type ?? ''));
  const q = typeof quality === 'number' && quality >= 0 && quality <= 1 ? quality : 0.92;
  const m = media();
  if (m?.encodeImage && p.width > 0 && p.height > 0) {
    const copy = new Uint8Array(p.data.length); copy.set(p.data);
    const out = m.encodeImage(copy.buffer, p.width, p.height, jpg ? 'jpeg' : 'png', q);
    if (out && out.byteLength > 0) return {bytes: new Uint8Array(out), type: jpg ? 'image/jpeg' : 'image/png'};
  }
  return jpg ? {bytes: encodeJpeg(p, q), type: 'image/jpeg'} : {bytes: encodePng(p), type: 'image/png'};
}

const empty = (w: number, h: number): Pixels => ({width: Math.max(1, w | 0), height: Math.max(1, h | 0), data: new Uint8ClampedArray(Math.max(1, w | 0) * Math.max(1, h | 0) * 4)});
/** The pixels of a canvas with a 2D context (or of an empty one at its size). */
export function canvas2dPixels(c: Record<string, any>): Pixels {
  const b = c.__ctx?.bitmap?.() as Pixels | undefined;
  return b ? {width: b.width, height: b.height, data: b.data} : empty(c.width, c.height);
}

/** OffscreenCanvas.convertToBlob writes the canvas's pixels (it gave an empty blob before). */
export function installConvertToBlob() {
  (OffscreenCanvasImpl.prototype as unknown as Record<string, unknown>).convertToBlob = function (this: Record<string, any>, options?: {type?: string; quality?: number}) {
    const B = (globalThis as {Blob?: new (parts: unknown[], o: {type: string}) => unknown}).Blob;
    try {
      const e = encodeImage(canvas2dPixels(this), options?.type, options?.quality);
      return Promise.resolve(B ? new B([e.bytes], {type: e.type}) : null);
    } catch (error) { return Promise.reject(error); }
  };
}
