/** document.elementFromPoint and elementsFromPoint from the overlay's layout. linkedom lays nothing out, so both
 *  answered nothing, and a page that finds what is under the pointer (a drop target while dragging a row, a wheel over
 *  the 3D view) never found it. The overlay reports every mirrored element's box (ui.ts); the topmost box under the
 *  point that takes pointer events is the answer. Stacking contexts and z-index are not known here: a later element
 *  in document order is taken to paint over an earlier one, as it does without them. */
import {domPage, layoutBoxes} from './dom';

const g = globalThis as Record<string, any>;
type N = Record<string, any>;
type Box = {x: number; y: number; width: number; height: number; display?: string; visibility?: string; pointerEvents?: string};
const doc = domPage.document as N;
const FOLLOWING = 4;

const byId = (id: string): N | null => doc.querySelector(`[data-jsgb="${id}"]`);

/** Every element under (x, y), topmost first. */
export function elementsAt(x: number, y: number): N[] {
  const hits: N[] = [];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return hits;
  for (const [id, raw] of layoutBoxes) {
    const b = raw as Box;
    if (!b || !(b.width > 0) || !(b.height > 0)) continue;
    if (x < b.x || y < b.y || x >= b.x + b.width || y >= b.y + b.height) continue;
    if (b.display === 'none' || b.visibility === 'hidden' || b.visibility === 'collapse' || b.pointerEvents === 'none') continue;
    const el = byId(id);
    if (el?.isConnected) hits.push(el);
  }
  hits.sort((a, b) => a === b ? 0 : (a.compareDocumentPosition(b) & FOLLOWING) ? 1 : -1);
  return hits;
}

const inViewport = (x: number, y: number) => x >= 0 && y >= 0 && x < (g.innerWidth ?? 0) && y < (g.innerHeight ?? 0);

let installed = false;
export function installPointHitTest() {
  if (installed) return;
  installed = true;
  // The page itself (<html>) is under every point of the viewport that no element covers, as in a browser.
  doc.elementFromPoint = (x: number, y: number) => elementsAt(Number(x), Number(y))[0] ?? (inViewport(Number(x), Number(y)) ? doc.documentElement : null);
  doc.elementsFromPoint = (x: number, y: number) => {
    const hits = elementsAt(Number(x), Number(y));
    if (inViewport(Number(x), Number(y))) { if (doc.body && !hits.includes(doc.body)) hits.push(doc.body); hits.push(doc.documentElement); }
    return hits;
  };
}
installPointHitTest();
