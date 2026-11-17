import {domPage, layoutBoxes} from './dom';
import {deliver} from './input';
import {queueCommand, overlayId} from './overlayCommands';

/** Scrolling, which the overlay does: its panels scroll natively under the person's wheel or trackpad. Each scroll
 *  comes here as a scroll packet with the element's new position (JavaScript/jsgb-ui-edit.js), so scrollTop and
 *  scrollLeft read it and the element gets its scroll event (window capture listeners too, which menus use to follow
 *  their anchor). The overlay's layout reports carry each scrolling element's scroll and client sizes, so scrollHeight,
 *  clientHeight and the clamp a browser applies to scrollTop match the overlay's.
 *  The page's own scrolling (scrollTop =, scrollTo, scrollBy, scrollIntoView) goes to the overlay as a command; the
 *  overlay scrolls natively and reports back, which also fires the element's scroll event, as a browser does. */
type El = Record<string, any>;
type Box = {width: number; height: number; sw?: number; sh?: number; clw?: number; clh?: number};
const g = globalThis as Record<string, any>;
const box = (el: El) => layoutBoxes.get(el.getAttribute?.('data-jsgb') ?? '') as Box | undefined;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** The scroll the page asked for, per element, sent with the next publish. */
const wanted = new Map<El, {top?: number; left?: number; behavior?: string; into?: Record<string, unknown>}>();
function ask(el: El, what: {top?: number; left?: number; behavior?: string; into?: Record<string, unknown>}) {
  const had = wanted.get(el);
  if (had) { Object.assign(had, what); return; }
  wanted.set(el, {...what});
  queueCommand(() => {
    const w = wanted.get(el); wanted.delete(el);
    const id = overlayId(el);
    return id && w ? {k: 'scroll', id, ...w} : null;
  });
}

function limit(el: El, axis: 'top' | 'left', v: number) {
  const b = box(el);
  const full = axis === 'top' ? b?.sh : b?.sw, view = axis === 'top' ? (b?.clh ?? b?.height) : (b?.clw ?? b?.width);
  const max = full !== undefined && view !== undefined ? Math.max(0, full - view) : Infinity;
  return Math.max(0, Math.min(max, v));
}

function setScroll(el: El, axis: 'top' | 'left', v: unknown, behavior?: string) {
  const n = num(v);
  // An instant scroll reads back at once; a smooth one moves as the overlay reports it.
  if (behavior !== 'smooth') el[axis === 'top' ? '__st' : '__sl'] = limit(el, axis, n);
  ask(el, {[axis]: Math.max(0, n), behavior});
}

/** scrollTo, scroll and scrollBy: (x, y) or ({left, top, behavior}). */
function scrollArgs(el: El, args: unknown[], by: boolean) {
  const o = typeof args[0] === 'object' && args[0] !== null ? args[0] as Record<string, unknown> : {left: args[0], top: args[1]};
  const behavior = typeof o.behavior === 'string' ? o.behavior : undefined;
  if (o.left !== undefined) setScroll(el, 'left', num(o.left) + (by ? el.scrollLeft : 0), behavior);
  if (o.top !== undefined) setScroll(el, 'top', num(o.top) + (by ? el.scrollTop : 0), behavior);
}

/** A scroll the overlay reports: the element's position, then its scroll event. */
export function takeOverlayScroll(el: El, p: Record<string, unknown>) {
  if (p.top !== undefined) el.__st = num(p.top);
  if (p.left !== undefined) el.__sl = num(p.left);
  deliver(el, new g.Event(String(p.type), {bubbles: false, cancelable: false}));
}

let installed = false;
export function installScrollMirror() {
  if (installed) return;
  installed = true;
  const EP = domPage.HTMLElement.prototype as El;
  const prop = (name: string, get: (el: El) => unknown, set?: (el: El, v: unknown) => void) =>
    Object.defineProperty(EP, name, {configurable: true, get() { return get(this); }, ...(set ? {set(v: unknown) { set(this, v); }} : {})});
  prop('scrollTop', el => el.__st ?? 0, (el, v) => setScroll(el, 'top', v));
  prop('scrollLeft', el => el.__sl ?? 0, (el, v) => setScroll(el, 'left', v));
  const rect = (el: El) => el.getBoundingClientRect();
  prop('scrollWidth', el => box(el)?.sw ?? rect(el).width);
  prop('scrollHeight', el => box(el)?.sh ?? rect(el).height);
  prop('clientWidth', el => box(el)?.clw ?? rect(el).width);
  prop('clientHeight', el => box(el)?.clh ?? rect(el).height);
  EP.scrollTo = EP.scroll = function (this: El, ...args: unknown[]) { scrollArgs(this, args, false); };
  EP.scrollBy = function (this: El, ...args: unknown[]) { scrollArgs(this, args, true); };
  EP.scrollIntoView = function (this: El, arg?: unknown) {
    const o = typeof arg === 'object' && arg !== null ? arg as Record<string, unknown> : {block: arg === false ? 'end' : 'start'};
    ask(this, {into: {block: o.block ?? 'start', inline: o.inline ?? 'nearest', behavior: o.behavior ?? 'auto'}});
  };
  // WebKit and Chromium's own: scroll only when the element is out of view, centred when asked.
  EP.scrollIntoViewIfNeeded = function (this: El, center = true) { ask(this, {into: {ifNeeded: true, center: !!center}}); };
}
installScrollMirror();
