import './dom';
import {copyingBitmaps} from './bitmapClone';

/** createImageBitmap of a bitmap or of a decoded <img> copies its pixels, as in a browser (bitmapClone.ts). Installed
 *  after dom.ts, which defines createImageBitmap. */
const g = globalThis as {createImageBitmap?: Parameters<typeof copyingBitmaps>[0]};
if (g.createImageBitmap) g.createImageBitmap = copyingBitmaps(g.createImageBitmap);
