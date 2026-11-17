/** ImageBitmaps as a browser copies them. The bridge's bitmaps (canvas2d.ts ImageBitmapImpl) hold decoded RGBA
 *  pixels, a file's encoded bytes, or the path of a file the host loads.
 *  - In a worker message the bitmap arrives on the other side with its picture: whichever of those it has travels as
 *    bytes. clone.ts uses this on both sides of a worker thread, so this file needs nothing but the global
 *    ImageBitmap. Before, a bitmap could not be posted to a worker thread at all.
 *  - createImageBitmap of a bitmap, or of an <img> whose WebP the bridge decoded, is a copy of its pixels (bitmapCopy.ts
 *    installs it). dom.ts kept only such a source's file path, or nothing, so the copy drew as black.
 *  PrepViz does both with a head's colour map: the eyes cut reads it back to paint the eye sockets. */

type Pixels = {width: number; height: number; data: Uint8ClampedArray | Uint8Array};
type Bitmap = {width: number; height: number; __jsgbAsset?: string; __bytes?: Uint8Array; __pixels?: Pixels; __ctx?: {bitmap?: () => Pixels}};
type View = {buffer: ArrayBuffer; byteOffset: number; length: number};
type BitmapShape = {$: 'ib'; w: number; h: number; p?: number[]; e?: number[]; a?: string};

const g = globalThis as {ImageBitmap?: new (w: number, h: number, asset?: string, bytes?: Uint8Array, pixels?: Pixels) => Bitmap};

/** The shape of a bitmap in an encoded message, or undefined for anything else. bufferIndex numbers the message's
 *  ArrayBuffers, as clone.ts does for typed arrays. */
export function encodeBitmap(v: object, bufferIndex: (b: ArrayBuffer) => number): BitmapShape | undefined {
  const B = g.ImageBitmap;
  if (!B || !(v instanceof B)) return undefined;
  const b = v as Bitmap, out: BitmapShape = {$: 'ib', w: b.width, h: b.height};
  // A view into a larger buffer (bytes inside a model file) travels as a copy of its own bytes, not the whole buffer.
  const view = (a: View & {slice(): View}) => { const own = a.byteOffset === 0 && a.length === a.buffer.byteLength ? a : a.slice(); return [bufferIndex(own.buffer), 0, own.length]; };
  const pixels = b.__ctx?.bitmap?.() ?? b.__pixels;
  if (pixels?.data && pixels.data.buffer instanceof ArrayBuffer) out.p = view(pixels.data);
  else if (b.__bytes && b.__bytes.buffer instanceof ArrayBuffer) out.e = view(b.__bytes);
  if (b.__jsgbAsset) out.a = b.__jsgbAsset;
  return out;
}

/** A bitmap from its encoded shape, made with this side's ImageBitmap. */
export function decodeBitmap(s: BitmapShape, buffers: ArrayBuffer[]): unknown {
  const B = g.ImageBitmap;
  const pixels = s.p ? {width: s.w, height: s.h, data: new Uint8ClampedArray(buffers[s.p[0]], s.p[1], s.p[2])} : undefined;
  const bytes = s.e ? new Uint8Array(buffers[s.e[0]], s.e[1], s.e[2]) : undefined;
  return B ? new B(s.w, s.h, s.a, bytes, pixels) : {width: s.w, height: s.h};
}

type Make = ((source: Record<string, any> | null | undefined, ...rest: unknown[]) => Promise<unknown>) & {__jsgbCopies?: boolean};
/** createImageBitmap that hands `make` a decoded source's pixels, or its encoded bytes, in place of the source. */
export function copyingBitmaps(make: Make): Make {
  if (make.__jsgbCopies) return make;
  const copying: Make = (source, ...rest) => {
    // Blobs, canvases (a renderer's picture included, canvasRead.ts) and image data keep their own handling.
    const own = !source || source.bytes || typeof source.arrayBuffer === 'function' || typeof source.getContext === 'function' || source.__ctx || source.data;
    const pixels = own ? null : source!.__pixels;
    if (pixels?.data && pixels.width && pixels.height) return make({data: pixels.data, width: pixels.width, height: pixels.height}, ...rest);
    if (!own && source!.__bytes) return make({bytes: source!.__bytes}, ...rest);
    return make(source, ...rest);
  };
  copying.__jsgbCopies = true;
  return copying;
}
