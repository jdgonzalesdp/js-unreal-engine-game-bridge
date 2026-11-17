/** HTML drag and drop as a browser runs it, around the overlay's reports of it (dragDrop.ts keeps the drag's data, one
 *  DataTransfer from dragstart to drop). The overlay's web view takes every drag so it never opens a dropped file, so the
 *  page's own answers are applied here:
 *  - A dragstart the page cancels (a locked layer row) cancels the drag: nothing more of it reaches the page.
 *  - A drop lands only where the page took it: its last dragenter or dragover was cancelled with a dropEffect that
 *    effectAllowed permits, or the element takes text by itself (a text field). Anywhere else the element gets dragleave
 *    instead, and the drag ends with dropEffect "none".
 *  - dragend, at the element the drag started from, still sees the drag's types and the effect of its drop.
 *  - element.draggable is the attribute browsers have: "true" or "false". linkedom kept it as a yes/no attribute, so
 *    el.draggable = true wrote draggable="" (which a browser reads as not draggable) and false removed it. A row a page
 *    made draggable again from script (the layers panel does, after its opacity slider) could never be dragged again. */
import {deliverDrag, dragSession, dropSession} from './dragDrop';
import {deliver} from './input';
import {domPage} from './dom';

const g = globalThis as Record<string, any>;
type El = Record<string, any>;
type Data = {dropEffect: string; effectAllowed: string; types: string[]; protect?(shown: unknown): void; kinds?(): unknown};
type Flags = {cancelled: boolean; accepted: boolean};

const flags = new WeakMap<object, Flags>();
const flagsOf = (dt: object) => { let f = flags.get(dt); if (!f) flags.set(dt, f = {cancelled: false, accepted: false}); return f; };
/** A page drag whose drop landed: dragDrop.ts let it go at the drop, and its dragend is still to come. */
let landed: Data | null = null;

const OPS = ['copy', 'move', 'link'];
/** Whether effectAllowed lets a drop be dropEffect. */
export function permits(effectAllowed: string, dropEffect: string): boolean {
  const allowed = String(effectAllowed || 'all').toLowerCase(), effect = String(dropEffect).toLowerCase();
  if (!OPS.includes(effect) || allowed === 'none') return false;
  return allowed === 'all' || allowed === 'uninitialized' || allowed.includes(effect);
}
/** The effect a drop takes when the page left dropEffect at one effectAllowed doesn't permit: the first it does. */
const firstPermitted = (effectAllowed: string) => OPS.find(op => permits(effectAllowed, op)) ?? 'none';

const TAKES_TEXT = 'textarea,input:not([type]),input[type=text],input[type=search],input[type=url],input[type=email],input[type=tel],input[type=password],[contenteditable]:not([contenteditable="false"])';
/** A text field takes dragged text by itself, as in a browser (files it leaves alone). */
function takesText(target: El | null, dt: Data) {
  try { return !!target?.closest?.(TAKES_TEXT) && !target.disabled && !dt.types.includes('Files'); } catch { return false; }
}

/** One drag event from the overlay (ui.ts); false when the page cancelled it or never saw it. */
export function routeDrag(target: El, p: El, init: El): boolean {
  const type = String(p.type);
  const current = dragSession() as {dt: Data; external: boolean} | null;
  const f = current ? flagsOf(current.dt) : null;
  if (type !== 'dragstart' && current && f?.cancelled) {
    const files = type === 'dragenter' && Array.isArray(p.drag?.types) && p.drag.types.includes('Files');
    // Files coming in: the cancelled drag ended without a dragend, and this is a new one (as dragDrop.ts reads it).
    if (!files) { if (type === 'dragend') dropSession(); return false; }
    dropSession();
    return routeDrag(target, p, init);
  }
  if (type === 'drop' && current) {
    if (!f!.accepted && !takesText(target, current.dt)) {
      current.dt.dropEffect = 'none';
      deliverDrag(target, {...p, type: 'dragleave', relatedId: null}, init);
      return false;
    }
    if (!permits(current.dt.effectAllowed, current.dt.dropEffect)) current.dt.dropEffect = firstPermitted(current.dt.effectAllowed);
  }
  if (type === 'dragend') {
    // No drop landed (Escape, or let go where nothing took it): the drag's effect is none.
    if (current) current.dt.dropEffect = 'none';
    else if (landed) {
      const dt = landed; landed = null;
      dt.protect?.(dt.kinds?.() ?? null);
      const Drag = g.DragEvent ?? g.Event;
      return deliver(target, new Drag('dragend', {...init, bubbles: true, cancelable: false, dataTransfer: dt}));
    }
  }
  if (type === 'dragstart') landed = null;
  const allowed = deliverDrag(target, p, init);
  const now = dragSession() as {dt: Data} | null;
  if (now && type === 'dragstart' && !allowed) flagsOf(now.dt).cancelled = true;
  if (now && (type === 'dragenter' || type === 'dragover')) {
    const dt = now.dt, nf = flagsOf(dt);
    // A cancel takes the drop unless the page chose "none" or effectAllowed permits nothing. dragDrop.ts starts
    // dropEffect at "move" (a page drag) or "copy" (from outside) whatever effectAllowed says, so a page that cancels
    // without choosing gets, at the drop, the first effect effectAllowed permits, where a browser would have started it.
    nf.accepted = !allowed ? dt.dropEffect !== 'none' && firstPermitted(dt.effectAllowed) !== 'none' : takesText(target, dt);
  }
  if (type === 'drop' && current && !current.external) landed = current.dt;
  return allowed;
}

/** element.draggable as browsers have it: the attribute's "true" or "false", else true only for images and links. */
export function installDraggable() {
  // The class that defines draggable for this page's elements (linkedom's HTMLElement).
  let proto = Object.getPrototypeOf(domPage.document.createElement('div')) as El | null;
  while (proto && !Object.prototype.hasOwnProperty.call(proto, 'draggable')) proto = Object.getPrototypeOf(proto);
  proto ??= g.HTMLElement?.prototype as El | null;
  if (!proto || proto.__jsgbDraggable) return;
  Object.defineProperty(proto, '__jsgbDraggable', {value: true});
  Object.defineProperty(proto, 'draggable', {
    configurable: true, enumerable: true,
    get(this: El) {
      const v = String(this.getAttribute('draggable') ?? '').toLowerCase();
      if (v === 'true' || v === 'false') return v === 'true';
      return this.tagName === 'IMG' || (this.tagName === 'A' && this.hasAttribute('href'));
    },
    set(this: El, value: unknown) { this.setAttribute('draggable', value ? 'true' : 'false'); },
  });
}
installDraggable();
