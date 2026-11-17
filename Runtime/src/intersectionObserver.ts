/** IntersectionObserver against the overlay's real layout. The page's DOM has no layout of its own: the overlay lays the
 *  mirrored page out and reports each element's box (ui.ts, 'host-layout'; dom.ts keeps them). The runtime's stand-in
 *  said every target intersected at once, so a page that loads rows as they scroll into view (PrepViz's font picker
 *  previews) loaded all of them. Here each layout report is checked as a browser checks each frame: the target's box,
 *  clipped by ancestors that clip their overflow (when the overlay reports it, or the inline style sets it), against
 *  the root (the viewport, or a root element's box) grown or shrunk by rootMargin. An observer hears of a target once
 *  when it starts watching, then whenever it crosses one of its thresholds or starts or stops intersecting.
 *  Before any layout report (the Node smoke test has no overlay) every connected target intersects, as before. */
const g = globalThis as Record<string, any>;
type El = Record<string, any>;
type Box = {x: number; y: number; width: number; height: number; display?: string; overflow?: string; overflowX?: string; overflowY?: string};
type Rect = {x: number; y: number; r: number; b: number};
type Watch = {target: El; index: number; intersecting: boolean};

const observers = new Set<JsgbIntersectionObserver>();
let boxOf: (el: El) => Box | undefined = () => undefined;
let laidOut = () => false;

const rectOf = (el: El): Rect => { const d = el.getBoundingClientRect?.() ?? {x: 0, y: 0, width: 0, height: 0}; return {x: d.x, y: d.y, r: d.x + d.width, b: d.y + d.height}; };
/** Edge-adjacent rectangles intersect (a zero-area target on the root's edge counts), as the standard has it. */
const meet = (a: Rect, b: Rect): Rect | null => { const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), r = Math.min(a.r, b.r), bo = Math.min(a.b, b.b); return x <= r && y <= bo ? {x, y, r, b: bo} : null; };
const area = (a: Rect) => Math.max(0, a.r - a.x) * Math.max(0, a.b - a.y);
const domRect = (a: Rect | null) => a ? new g.DOMRect(a.x, a.y, a.r - a.x, a.b - a.y) : new g.DOMRect(0, 0, 0, 0);

const clipsX = (el: El, b?: Box) => { const o = b?.overflowX ?? b?.overflow ?? (el.style?.overflowX || el.style?.overflow); return !!o && o !== 'visible'; };
const clipsY = (el: El, b?: Box) => { const o = b?.overflowY ?? b?.overflow ?? (el.style?.overflowY || el.style?.overflow); return !!o && o !== 'visible'; };
const hidden = (el: El) => !el.isConnected || !!el.closest?.('[hidden]') || boxOf(el)?.display === 'none';

function parseMargin(text: string): [string, string, string, string] {
  const parts = String(text ?? '0px').trim().split(/\s+/).filter(Boolean);
  for (const p of parts) if (!/^-?(\d+\.?\d*|\.\d+)(px|%)$/.test(p) && p !== '0') throw new (g.DOMException ?? Error)(`Failed to parse rootMargin "${text}".`, 'SyntaxError');
  if (!parts.length || parts.length > 4) throw new (g.DOMException ?? Error)(`Failed to parse rootMargin "${text}".`, 'SyntaxError');
  const [t, r = t, b = t, l = r] = parts;
  return [t, r, b, l];
}
const marginPx = (v: string, size: number) => v.endsWith('%') ? parseFloat(v) / 100 * size : parseFloat(v) || 0;

export class JsgbIntersectionObserver {
  readonly root: El | null; readonly rootMargin: string; readonly thresholds: number[]; readonly scrollMargin = '0px 0px 0px 0px';
  private watches: Watch[] = []; private margin: [string, string, string, string];
  constructor(private callback: (entries: unknown[], observer: JsgbIntersectionObserver) => void, options: {root?: El | null; rootMargin?: string; threshold?: number | number[]} = {}) {
    if (typeof callback !== 'function') throw new TypeError('IntersectionObserver needs a callback.');
    const root = options?.root ?? null;
    this.root = root && root.nodeType === 9 ? null : root;
    this.margin = parseMargin(options?.rootMargin ?? '0px');
    this.rootMargin = this.margin.join(' ');
    const t = options?.threshold === undefined ? [0] : Array.isArray(options.threshold) ? options.threshold.map(Number) : [Number(options.threshold)];
    if (t.some(v => !(v >= 0 && v <= 1))) throw new RangeError('Threshold values must be numbers between 0 and 1.');
    this.thresholds = (t.length ? t : [0]).sort((a, b) => a - b);
  }
  observe(target: El) {
    if (!target || target.nodeType !== 1) throw new TypeError('IntersectionObserver.observe needs an Element.');
    if (this.watches.some(w => w.target === target)) return;
    this.watches.push({target, index: -1, intersecting: false});
    observers.add(this); schedule();
  }
  unobserve(target: El) { this.watches = this.watches.filter(w => w.target !== target); if (!this.watches.length) observers.delete(this); }
  disconnect() { this.watches = []; observers.delete(this); }
  takeRecords() { return []; }

  /** @internal The entries for targets that crossed a threshold since the last check. */
  _check(time: number): unknown[] {
    const entries: unknown[] = [];
    const vw = g.innerWidth || 0, vh = g.innerHeight || 0;
    const base = this.root ? rectOf(this.root) : {x: 0, y: 0, r: vw, b: vh};
    const w = base.r - base.x, h = base.b - base.y, [mt, mr, mb, ml] = this.margin;
    const rootBounds = {x: base.x - marginPx(ml, w), y: base.y - marginPx(mt, h), r: base.r + marginPx(mr, w), b: base.b + marginPx(mb, h)};
    for (const watch of this.watches) {
      const {target} = watch, box = rectOf(target);
      let hit: Rect | null = null;
      if (!laidOut()) hit = target.isConnected ? box : null;
      else if (!hidden(target) && (!this.root || this.root.contains?.(target))) {
        hit = box;
        for (let a = target.parentElement; a && hit && a !== this.root && a.nodeType === 1; a = a.parentElement) {
          const b = boxOf(a), cx = clipsX(a, b), cy = clipsY(a, b);
          if (!cx && !cy) continue;
          const ar = rectOf(a);
          hit = meet(hit, {x: cx ? ar.x : -Infinity, y: cy ? ar.y : -Infinity, r: cx ? ar.r : Infinity, b: cy ? ar.b : Infinity});
        }
        hit = hit && meet(hit, rootBounds);
      }
      const intersecting = !!hit, targetArea = area(box);
      const ratio = !hit ? 0 : targetArea > 0 ? Math.min(1, area(hit) / targetArea) : 1;
      let index = this.thresholds.findIndex(t => t > ratio);
      if (index < 0) index = this.thresholds.length;
      if (!intersecting) index = 0;
      if (index === watch.index && intersecting === watch.intersecting) continue;
      watch.index = index; watch.intersecting = intersecting;
      entries.push({time, target, isIntersecting: intersecting, intersectionRatio: ratio, isVisible: false,
        boundingClientRect: domRect(box), intersectionRect: domRect(hit), rootBounds: domRect(rootBounds)});
    }
    return entries;
  }
}

let scheduled = false;
function run() {
  scheduled = false;
  const time = g.performance?.now?.() ?? Date.now();
  for (const observer of [...observers]) {
    const entries = observer._check(time);
    if (!entries.length) continue;
    try { (observer as unknown as {callback: (e: unknown[], o: unknown) => void}).callback(entries, observer); } catch (e) { g.reportError?.(e) ?? g.console?.error?.(e); }
  }
}
function schedule() { if (!scheduled && observers.size) { scheduled = true; g.setTimeout(run, 0); } }

/** Installs the observer over the layout reports dom.ts keeps: each report (a write to the map) and each viewport
 *  change schedules a check. An engine with a native IntersectionObserver keeps it. */
export function installIntersectionObserver(layoutBoxes: Map<string, unknown>, read: (el: El) => Box | undefined) {
  if (/\[native code\]/.test(String(g.IntersectionObserver))) return;
  boxOf = read;
  laidOut = () => layoutBoxes.size > 0;
  const set = layoutBoxes.set;
  layoutBoxes.set = function (this: Map<string, unknown>, key: string, value: unknown) { schedule(); return set.call(this, key, value); };
  g.addEventListener?.('resize', schedule);
  g.IntersectionObserver = JsgbIntersectionObserver;
  g.IntersectionObserverEntry ??= class IntersectionObserverEntry {};
}
