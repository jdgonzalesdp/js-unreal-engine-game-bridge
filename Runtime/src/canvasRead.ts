/** Canvases read as images, as a browser reads them: toDataURL and toBlob write real JPEG and PNG files, and the canvas
 *  of a renderer (a WebGL canvas) gives Unreal's picture of what that renderer drew (readback.ts) to toDataURL, toBlob,
 *  drawImage and createImageBitmap. A WebGL canvas has no 2D context, so getContext('2d') answers null for it, as a
 *  browser does. Installed after dom.ts. */
import {bytesBase64} from './base64';
import {canvas2dPixels, encodeImage, installConvertToBlob} from './imageEncode';
import {readCanvasPixels, rendererOf} from './readback';
import type {Pixels} from './media';
import {domPage} from './dom';

const g = globalThis as Record<string, any>;
const CanvasP = (domPage.HTMLCanvasElement ?? g.HTMLCanvasElement)?.prototype as Record<string, any> | undefined;

/** Pixels of any canvas: a renderer's picture, or the 2D context's pixels. */
export function canvasPixels(c: Record<string, any>): Pixels {
  if (!c.__ctx && rendererOf(c)) { const p = readCanvasPixels(c); if (p) return p; }
  return canvas2dPixels(c);
}

if (CanvasP) {
  const getContext = CanvasP.getContext as (this: unknown, kind: string, ...rest: unknown[]) => unknown;
  CanvasP.getContext = function (this: Record<string, any>, kind: string, ...rest: unknown[]) {
    if (kind === '2d' && !this.__ctx && rendererOf(this)) return null;
    return getContext.call(this, kind, ...rest);
  };
  CanvasP.toDataURL = function (this: Record<string, any>, type?: string, quality?: number) {
    const e = encodeImage(canvasPixels(this), type, quality);
    return `data:${e.type};base64,` + bytesBase64(e.bytes);
  };
  CanvasP.toBlob = function (this: Record<string, any>, cb: (b: unknown) => void, type?: string, quality?: number) {
    let blob: unknown = null;
    try { const e = encodeImage(canvasPixels(this), type, quality); blob = new g.Blob([e.bytes], {type: e.type}); }
    catch (error) { g.console?.error?.('canvas.toBlob: ' + (error instanceof Error ? error.message : error)); }
    setTimeout(() => cb(blob), 0);
  };
  // drawImage reads a source's __pixels (canvas2d.ts): a renderer's canvas gives its picture there.
  Object.defineProperty(CanvasP, '__pixels', {configurable: true, get(this: Record<string, any>) { return !this.__ctx && rendererOf(this) ? readCanvasPixels(this) ?? undefined : undefined; }});
}

const makeBitmap = g.createImageBitmap as ((source: unknown, ...rest: unknown[]) => Promise<unknown>) | undefined;
if (makeBitmap) {
  g.createImageBitmap = (source: Record<string, any>, ...rest: unknown[]) => {
    if (source && !source.__ctx && rendererOf(source)) {
      const p = readCanvasPixels(source);
      if (p) {
        // A crop (sx, sy, sw, sh) of the picture, as a browser takes it.
        const [sx, sy, sw, sh] = rest.length >= 4 && typeof rest[0] === 'number' ? rest as number[] : [0, 0, p.width, p.height];
        const w = Math.max(1, sw | 0), h = Math.max(1, sh | 0), data = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const X = (sx | 0) + x, Y = (sy | 0) + y; if (X < 0 || Y < 0 || X >= p.width || Y >= p.height) continue;
          data.set(p.data.subarray((Y * p.width + X) * 4, (Y * p.width + X) * 4 + 4), (y * w + x) * 4);
        }
        return Promise.resolve(new g.ImageBitmap(w, h, undefined, undefined, {width: w, height: h, data}));
      }
    }
    return makeBitmap(source, ...rest);
  };
}

installConvertToBlob();
