import './textSelection';
import {domPage} from './dom';
import {queueCommand, overlayId} from './overlayCommands';
import {readPoint, writePoint} from './selectionPoints';
import {isTextField} from './editHosts';

/** The selection, kept the same in the page and the overlay. The person selects in the overlay, which reports it with
 *  its packets (sel for the document, fsel for a text field: JavaScript/jsgb-ui-edit.js), and getSelection(),
 *  selectionStart and selectionEnd here then answer with it. What the page selects itself (setSelectionRange, select(),
 *  addRange after it builds a Range) goes to the overlay as a command, so the caret shows where the page put it.
 *  textSelection.ts holds the selection; this only carries it across. */
const g = globalThis as Record<string, any>;
type N = Record<string, any>;
let quiet = 0;
/** The overlay's last edit the page applied (its number): a field's value in a command is the page's own only when the
 *  page had every edit the overlay sent, and the overlay keeps its value otherwise. */
let lastEdit = 0;
export function noteOverlayEdit(n: unknown) { if (typeof n === 'number' && n > lastEdit) lastEdit = n; }

/** Runs fn as the overlay's own change, which goes back to the overlay as nothing. */
export function fromOverlay<T>(fn: () => T): T { quiet++; try { return fn(); } finally { quiet--; } }

const byId = (id: string) => g.document.querySelector(`[data-jsgb="${id}"]`);

// The number of the page's last selection command, for the document and for each field. A selection the overlay
// reports before it ran that command (seen, the last command number it ran) is older than the page's own and is
// dropped: a key's report made before the page's Enter handler moved the caret must not move it back.
let docSent = 0;
const fieldSent = new WeakMap<N, number>();
const stale = (p: N, sent: number) => typeof p.seen === 'number' && p.seen < sent;

/** Takes the selection a packet carries: a text field's (fsel, on the packet's element) or the document's (sel). */
export function takeOverlaySelection(p: N, target: N | null) {
  const f = p.fsel as N | undefined;
  if (f && target && isTextField(target) && typeof target.setSelectionRange === 'function' && !stale(p, fieldSent.get(target) ?? 0)) {
    fromOverlay(() => { try { target.setSelectionRange(f.start, f.end, f.dir); } catch { /* this type of field has no selection */ } });
  }
  const s = p.sel as N | undefined, sel = s ? g.getSelection?.() : null;
  if (!s || !sel || stale(p, docSent)) return;
  if (s.none) { fromOverlay(() => sel.removeAllRanges()); return; }
  const a = readPoint(s.anchor, byId), b = readPoint(s.focus ?? s.anchor, byId);
  if (a && b) fromOverlay(() => sel.setBaseAndExtent(a.node, a.offset, b.node, b.offset));
}

let docQueued = false;
function documentChanged() {
  if (quiet || docQueued) return;
  docQueued = true;
  docSent = queueCommand(() => {
    docQueued = false;
    const sel = g.getSelection?.();
    if (!sel?.rangeCount) return {k: 'sel', none: true};
    const anchor = writePoint(sel.anchorNode, sel.anchorOffset), focus = writePoint(sel.focusNode, sel.focusOffset);
    return anchor && focus ? {k: 'sel', anchor, focus} : null;
  });
}

const fieldsQueued = new Set<N>();
function fieldChanged(el: N) {
  if (quiet || fieldsQueued.has(el) || !isTextField(el)) return;
  fieldsQueued.add(el);
  fieldSent.set(el, queueCommand(() => {
    fieldsQueued.delete(el);
    const id = overlayId(el);
    return id ? {k: 'fsel', id, start: el.selectionStart, end: el.selectionEnd, dir: el.selectionDirection, value: String(el.value ?? ''), edit: lastEdit} : null;
  }));
}

// A value the page writes itself (a sent message cleared, a field reformatted) reaches the overlay's field even while
// it has focus. The overlay keeps its own when the person typed on since (jsgb-ui-edit.js).
const valuesQueued = new Set<N>();
function valueChanged(el: N) {
  if (quiet || valuesQueued.has(el) || !isTextField(el)) return;
  valuesQueued.add(el);
  queueCommand(() => {
    valuesQueued.delete(el);
    const id = overlayId(el);
    return id ? {k: 'fval', id, value: String(el.value ?? ''), edit: lastEdit} : null;
  });
}

function wrap(proto: N, name: string, after: (self: N) => void) {
  const own = proto[name];
  if (typeof own !== 'function' || own.__jsgbMirrored) return;
  const wrapped = function (this: N, ...args: unknown[]) { const out = own.apply(this, args); after(this); return out; };
  (wrapped as N).__jsgbMirrored = true;
  proto[name] = wrapped;
}

let installed = false;
export function installSelectionMirror() {
  if (installed) return;
  installed = true;
  const sel = g.getSelection?.();
  const selProto = sel ? Object.getPrototypeOf(sel) as N : null;
  if (selProto) for (const name of ['addRange', 'removeAllRanges', 'collapse', 'setBaseAndExtent', 'selectAllChildren']) wrap(selProto, name, documentChanged);
  for (const proto of [domPage.HTMLInputElement?.prototype, domPage.HTMLTextAreaElement?.prototype] as (N | undefined)[]) {
    if (!proto) continue;
    for (const name of ['setSelectionRange', 'select', 'setRangeText']) wrap(proto, name, fieldChanged);
    for (const name of ['selectionStart', 'selectionEnd', 'selectionDirection']) {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d?.set || !d.configurable) continue;
      Object.defineProperty(proto, name, {...d, set(this: N, v: unknown) { d.set!.call(this, v); fieldChanged(this); }});
    }
    const value = Object.getOwnPropertyDescriptor(proto, 'value');
    if (value?.get && value.set && value.configurable) Object.defineProperty(proto, 'value', {...value, set(this: N, v: unknown) {
      const before = value.get!.call(this);
      value.set!.call(this, v);
      if (value.get!.call(this) !== before) valueChanged(this);
    }});
  }
}
installSelectionMirror();
