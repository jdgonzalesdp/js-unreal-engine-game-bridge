import {domPage} from './dom';
import {deliver} from './input';

/** Pointer capture as browsers have it. A slider, a scrubber or a 3D drag calls setPointerCapture on pointerdown and
 *  then expects every move and the release to come to that element, wherever the pointer goes. The overlay's browser
 *  only sees its copy of the page, so the capture lives here: uiInput sends each overlay event through
 *  captureTarget, which hands moves and releases to the capturing element, and endCapture lets go after the release.
 *  As in a browser, gotpointercapture and lostpointercapture fire before the pointer's next event, and while a capture
 *  holds, the over, out, enter and leave events of other elements don't fire. */
const g = globalThis as Record<string, any>;
type El = Record<string, any>;
const pending = new Map<number, El>(), current = new Map<number, El>(), pressed = new Set<number>(), kinds = new Map<number, string>();
const BOUNDARY = new Set(['pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave']);
const MOVES = new Set(['pointermove', 'pointerup', 'pointercancel']);
const COMPAT: Record<string, string> = {pointermove: 'mousemove', pointerup: 'mouseup'};
// The mouse event that follows a captured pointer event goes where that pointer event went.
let compat: {type: string; to: El} | null = null;
// After a captured release, the click goes to the capturing element unless it landed inside it.
let clickTo: El | null = null;

const idOf = (p: Record<string, any>) => typeof p.pointerId === 'number' ? p.pointerId : 1;

function fire(type: string, el: El, pointerId: number) {
  // An element that left the page while it held the pointer hands the lost event to the document.
  deliver(el.isConnected ? el : g.document, new g.PointerEvent(type, {pointerId, pointerType: kinds.get(pointerId) ?? 'mouse', isPrimary: true, bubbles: true}));
}

/** Moves the capture to what the game last asked for. */
function settle(id: number) {
  const was = current.get(id);
  let next = pending.get(id);
  if (next && !next.isConnected) { pending.delete(id); next = undefined; }
  if (was === next) return;
  if (was) { current.delete(id); fire('lostpointercapture', was, id); }
  if (next && pending.get(id) === next) { current.set(id, next); fire('gotpointercapture', next, id); }
}

/** The element an overlay event goes to: the capturing element for moves and releases, null for another element's
 *  boundary event while a capture holds, else the element the overlay reported. */
export function captureTarget(p: Record<string, any>, target: El | null): El | null {
  const type = String(p.type), id = idOf(p);
  if (type.startsWith('pointer')) {
    compat = null;
    if (p.pointerType) kinds.set(id, p.pointerType);
    if (type === 'pointerdown') { pressed.add(id); clickTo = null; }
    // A move with no button held: the release happened where the overlay could not see it, so the capture ends.
    if (type === 'pointermove' && p.buttons === 0) { pressed.delete(id); pending.delete(id); }
    settle(id);
    const held = current.get(id);
    if (!held) return target;
    if (BOUNDARY.has(type)) return null;
    if (!MOVES.has(type)) return target;
    if (COMPAT[type]) compat = {type: COMPAT[type], to: held};
    return held;
  }
  if (type.startsWith('mouse')) {
    const c = compat;
    if (c && c.type === type) { compat = null; return c.to; }
    return current.has(1) && BOUNDARY.has(type) ? null : target;
  }
  if (type === 'click' || type === 'auxclick') {
    const to = clickTo; clickTo = null;
    return to && to.isConnected && !(target && to.contains(target)) ? to : target;
  }
  return target;
}

/** After a release or a cancel is delivered: the capture ends, as a browser ends it. */
export function endCapture(p: Record<string, any>) {
  if (p.type !== 'pointerup' && p.type !== 'pointercancel') return;
  const id = idOf(p), held = current.get(id);
  pressed.delete(id); pending.delete(id); settle(id);
  if (held && p.type === 'pointerup') clickTo = held;
}

let installed = false;
export function installPointerCapture() {
  if (installed) return;
  installed = true;
  const ElP = domPage.Element.prototype as Record<string, any>;
  // A browser ignores a capture asked for a pointer with no button down.
  ElP.setPointerCapture = function (this: El, pointerId: number) { if (this.isConnected && pressed.has(pointerId)) pending.set(pointerId, this); };
  ElP.releasePointerCapture = function (this: El, pointerId: number) { if (pending.get(pointerId) === this) pending.delete(pointerId); };
  ElP.hasPointerCapture = function (this: El, pointerId: number) { return pending.get(pointerId) === this; };
}
