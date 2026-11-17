/** 2D stand-ins for webgl-sdf-generator's WebGL canvas writes, which troika-three-text (drei's <Text>) uses for its
 *  glyph atlas. With no WebGL, troika makes each glyph's distance field in JavaScript but still copies it into the
 *  atlas canvas with WebGL; that throws here, the font promise never settles, and a Suspense boundary waiting on the
 *  text never shows its scene. The build (Tools/jsgb.mjs) routes those two writes here when a canvas has no WebGL.
 *
 *  Coordinates follow WebGL: (x, y) is the rect's lower-left corner, measured from the canvas's bottom, and the
 *  first row of `data` is the rect's bottom row. A 2D canvas counts rows from the top, so rows are flipped. The
 *  resulting picture is the same one the WebGL canvas would show, so the atlas texture uploads the same way. */
const g = globalThis as Record<string, any>;

type Ctx2D = {getImageData(x: number, y: number, w: number, h: number): {data: Uint8ClampedArray}; putImageData(img: unknown, x: number, y: number): void;
  createImageData(w: number, h: number): {data: Uint8ClampedArray}};
type Canvas = {width: number; height: number; getContext(kind: string): unknown};

/** renderImageData: copy RGBA `data` into the rect, writing only the channels in `channels` (8 R, 4 G, 2 B, 1 A). */
export function renderImageData2D(canvas: Canvas, data: ArrayLike<number>, x: number, y: number, width: number, height: number, channels = 15) {
  const ctx = canvas.getContext('2d') as Ctx2D | null;
  if (!ctx) throw new Error('jsgb: the SDF canvas has neither WebGL nor 2D');
  const top = canvas.height - y - height;
  const img = ctx.getImageData(x, top, width, height);
  const mask = [channels & 8, channels & 4, channels & 2, channels & 1];
  for (let row = 0; row < height; row++) {
    const src = row * width * 4, dst = (height - 1 - row) * width * 4;
    for (let i = 0; i < width * 4; i++) if (mask[i & 3]) img.data[dst + i] = data[src + i];
  }
  ctx.putImageData(img, x, top);
}

/** resizeWebGLCanvasWithoutClearing: grow the canvas and keep its pixels where WebGL keeps them (at the bottom). */
export function resizeCanvas2D(canvas: Canvas, newWidth: number, newHeight: number) {
  const ctx = canvas.getContext('2d') as Ctx2D | null;
  if (!ctx) throw new Error('jsgb: the SDF canvas has neither WebGL nor 2D');
  const {width, height} = canvas;
  const old = ctx.getImageData(0, 0, width, height);
  canvas.width = newWidth; canvas.height = newHeight;
  (canvas.getContext('2d') as Ctx2D).putImageData(old, 0, newHeight - height);
}

g.__jsgbSdf2D = {renderImageData: renderImageData2D, resizeCanvas: resizeCanvas2D};
