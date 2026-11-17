/** ResizeObserver driven by the overlay's real layout. The page's DOM has no layout of its own: the overlay (WebKit or
 *  CEF) lays the mirrored page out and reports every element's box (ui.ts, 'host-layout'). An observer here reports a
 *  target once when it starts watching it, as a browser does, and again whenever a layout report changes its size.
 *  Measured containers depend on this: react-three-fiber's <Canvas> starts only once its wrapper has a size, and a
 *  layout that places one bar against another's measured height kept the first size it ever saw. */
const g = globalThis as Record<string, any>;

type Size = {w: number; h: number; cw: number; ch: number};
type Box = {width: number; height: number; cw?: number; ch?: number};
type Watch = {observer: JsgbResizeObserver; target: Record<string, any>; last: Size | null};

const watches = new Set<Watch>();
/** Whether any layout report has arrived: without an overlay (the Node smoke test) nothing is ever laid out. */
let laidOut = false;
let boxOf: (el: Record<string, any>) => Box | undefined = () => undefined;

/** How the observer reads an element's laid-out box (dom.ts owns the layout reports). */
export function setLayoutSource(read: (el: Record<string, any>) => Box | undefined) { boxOf = read; }

function sizeOf(target: Record<string, any>): Size {
  const b = boxOf(target);
  if (b) return {w: b.width, h: b.height, cw: b.cw ?? b.width, ch: b.ch ?? b.height};
  // Not laid out yet: whatever the element reports for itself (an inline size, the viewport for a canvas, or zero).
  const r = target.getBoundingClientRect?.() ?? {width: 0, height: 0};
  // With no overlay at all, an element of unknown size reports the viewport, as before layout reports existed.
  const w = r.width || (laidOut ? 0 : g.innerWidth), h = r.height || (laidOut ? 0 : g.innerHeight);
  return {w, h, cw: w, ch: h};
}

function entry(target: Record<string, any>, s: Size) {
  const border = [{inlineSize: s.w, blockSize: s.h}], content = [{inlineSize: s.cw, blockSize: s.ch}];
  const dpr = g.devicePixelRatio || 1;
  return {target, contentRect: new g.DOMRect(0, 0, s.cw, s.ch), borderBoxSize: border, contentBoxSize: content,
    devicePixelContentBoxSize: [{inlineSize: Math.round(s.cw * dpr), blockSize: Math.round(s.ch * dpr)}]};
}

/** Delivers the changes since the last report, one callback per observer. Called after each layout report, and once
 *  after a target starts being watched. */
export function notifyResizes(fromLayout = false) {
  if (fromLayout) laidOut = true;
  const byObserver = new Map<JsgbResizeObserver, unknown[]>();
  for (const w of watches) {
    if (!w.target.isConnected) continue;
    const s = sizeOf(w.target);
    if (w.last && w.last.w === s.w && w.last.h === s.h && w.last.cw === s.cw && w.last.ch === s.ch) continue;
    w.last = s;
    let list = byObserver.get(w.observer);
    if (!list) byObserver.set(w.observer, list = []);
    list.push(entry(w.target, s));
  }
  for (const [observer, entries] of byObserver) {
    try { observer.callback(entries, observer); } catch (e) { g.reportError?.(e) ?? g.console?.error?.(e); }
  }
}

let scheduled = false;
const schedule = () => { if (!scheduled) { scheduled = true; g.setTimeout(() => { scheduled = false; notifyResizes(); }, 0); } };

export class JsgbResizeObserver {
  constructor(readonly callback: (entries: unknown[], observer: JsgbResizeObserver) => void) {}
  observe(target: Record<string, any>) {
    for (const w of watches) if (w.observer === this && w.target === target) return;
    watches.add({observer: this, target, last: null});
    schedule();
  }
  unobserve(target: Record<string, any>) { for (const w of watches) if (w.observer === this && w.target === target) watches.delete(w); }
  disconnect() { for (const w of watches) if (w.observer === this) watches.delete(w); }
}

export function installResizeObserver() { g.ResizeObserver = JsgbResizeObserver; }
