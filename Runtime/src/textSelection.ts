/** Text selection as browsers have it, which linkedom lacks: window.getSelection() and document.getSelection(), a text
 *  field's selection (selectionStart, selectionEnd, setSelectionRange, setRangeText) and the Range members editors use
 *  (setStart, setEnd, collapse, startContainer ...).
 *  React reads the selection on every key press and release in a focused text field (its onSelect support). Without
 *  getSelection that read threw, so none of the field's own key handlers ran (Enter to commit, Escape to cancel).
 *  What the person selects in the overlay stays in the overlay: this is the selection the page itself sets and reads. */
import './domException';
import {domPage} from './dom';

const g = globalThis as Record<string, any>;
type N = Record<string, any>;
const doc = domPage.document as N;
const domError = (message: string, name: string) => new g.DOMException(message, name);

// ---- Text fields: input types with a text selection, and textarea.
const SELECTABLE_TYPES = new Set(['text', 'search', 'url', 'tel', 'password']);
const hasSelection = (el: N) => el.tagName === 'TEXTAREA' || SELECTABLE_TYPES.has(String(el.type));
type FieldRange = {start: number; end: number; dir: string; value: string};
const fields = new WeakMap<object, FieldRange>();

/** The field's selection. A value changed since it was set (a person's typing, the page's own write) leaves the caret
 *  at the end, as a browser does after a value is set. */
function fieldRange(el: N): FieldRange {
  const value = String(el.value ?? ''), s = fields.get(el);
  if (!s || s.value !== value) return {start: value.length, end: value.length, dir: 'none', value};
  return s;
}
function setFieldRange(el: N, start: unknown, end: unknown, dir: unknown = 'none') {
  const value = String(el.value ?? ''), len = value.length;
  const e = Math.max(0, Math.min(len, Number(end) || 0)), s = Math.max(0, Math.min(e, Number(start) || 0));
  fields.set(el, {start: s, end: e, dir: dir === 'forward' || dir === 'backward' ? dir : 'none', value});
}
function needsSelection(el: N) {
  if (!hasSelection(el)) throw domError(`The input element's type ('${el.type}') does not support selection.`, 'InvalidStateError');
}

function installFieldSelection(proto: N | undefined) {
  if (!proto || 'selectionStart' in proto) return;
  const prop = (name: string, get: (el: N) => unknown, set: (el: N, v: unknown) => void) =>
    Object.defineProperty(proto, name, {configurable: true, enumerable: true, get() { return get(this); }, set(v) { set(this, v); }});
  prop('selectionStart', el => hasSelection(el) ? fieldRange(el).start : null,
    (el, v) => { needsSelection(el); const r = fieldRange(el); setFieldRange(el, v, Math.max(Number(v) || 0, r.end), r.dir); });
  prop('selectionEnd', el => hasSelection(el) ? fieldRange(el).end : null,
    (el, v) => { needsSelection(el); const r = fieldRange(el); setFieldRange(el, Math.min(r.start, Number(v) || 0), v, r.dir); });
  prop('selectionDirection', el => hasSelection(el) ? fieldRange(el).dir : null,
    (el, v) => { needsSelection(el); const r = fieldRange(el); setFieldRange(el, r.start, r.end, v); });
  proto.setSelectionRange = function (this: N, start: number, end: number, dir?: string) { needsSelection(this); setFieldRange(this, start, end, dir); };
  // setRangeText as the HTML standard has it: the replaced text, then where the selection goes ("select", "start", "end"
  // or "preserve").
  proto.setRangeText = function (this: N, text: string, start?: number, end?: number, mode = 'preserve') {
    needsSelection(this);
    const r = fieldRange(this), old = r.value, rep = String(text);
    let s = start === undefined ? r.start : Math.min(Number(start) || 0, old.length);
    const e = end === undefined ? r.end : Math.min(Number(end) || 0, old.length);
    if (s > e) throw domError('The provided start value is larger than the end value.', 'IndexSizeError');
    this.value = old.slice(0, s) + rep + old.slice(e);
    const after = s + rep.length;
    let ss = r.start, se = r.end;
    if (mode === 'select') { ss = s; se = after; } else if (mode === 'start') { ss = se = s; } else if (mode === 'end') { ss = se = after; } else {
      const delta = rep.length - (e - s);
      if (ss > e) ss += delta; else if (ss > s) ss = s;
      if (se > e) se += delta; else if (se > s) se = after;
      if (start === undefined && end === undefined) { s = after; ss = Math.min(ss, s); }
    }
    setFieldRange(this, ss, se, r.dir);
  };
  // select() also selects the whole value; the focus it moves (focusMirror.ts) stays.
  const select = proto.select as ((...a: unknown[]) => void) | undefined;
  proto.select = function (this: N, ...args: unknown[]) {
    select?.apply(this, args);
    if (hasSelection(this)) setFieldRange(this, 0, String(this.value ?? '').length);
  };
}

// ---- Range boundary points. linkedom's Range keeps a run of nodes; the points a browser's Range has are kept beside it.
type Point = {node: N; offset: number};
const points = new WeakMap<object, {start: Point; end: Point}>();
const lengthOf = (n: N) => n.nodeType === 3 || n.nodeType === 8 ? String(n.data ?? n.nodeValue ?? '').length : n.childNodes?.length ?? 0;
const indexIn = (n: N) => Array.prototype.indexOf.call(n.parentNode?.childNodes ?? [], n);
function common(a: N, b: N): N | null {
  const seen = new Set<N>();
  for (let n: N | null = a; n; n = n.parentNode) seen.add(n);
  for (let n: N | null = b; n; n = n.parentNode) if (seen.has(n)) return n;
  return null;
}
function setPoints(r: N, start: Point, end: Point) {
  points.set(r, {start, end});
  r.commonAncestorContainer = common(start.node, end.node);
}
const pointsOf = (r: N) => points.get(r) ?? {start: {node: doc, offset: 0}, end: {node: doc, offset: 0}};
/** Text between two points, in document order. */
function textBetween(start: Point, end: Point): string {
  if (start.node === end.node && start.node.nodeType === 3) return String(start.node.data).slice(start.offset, end.offset);
  let out = '', on = false;
  const first = start.node.nodeType === 3 ? start.node : start.node.childNodes?.[start.offset] ?? null;
  const last = end.node.nodeType === 3 ? end.node : end.node.childNodes?.[end.offset] ?? null;
  const walk = (n: N): boolean => {
    if (n === last && n.nodeType !== 3) return true;
    if (n === first) on = true;
    if (n.nodeType === 3 && on) {
      const text = String(n.data);
      out += text.slice(n === start.node ? start.offset : 0, n === end.node ? end.offset : text.length);
      if (n === last) return true;
    }
    for (const c of n.childNodes ?? []) if (walk(c)) return true;
    return false;
  };
  walk(common(start.node, end.node) ?? doc);
  return out;
}

function installRange(proto: N | undefined) {
  if (!proto || 'setStart' in proto) return;
  const wrap = (name: string, after: (r: N, node: N) => void) => {
    const own = proto[name] as ((...a: unknown[]) => unknown) | undefined;
    proto[name] = function (this: N, node: N, ...rest: unknown[]) { const out = own?.call(this, node, ...rest); after(this, node); return out; };
  };
  const p = (node: N, offset: number): Point => ({node, offset});
  wrap('selectNode', (r, n) => setPoints(r, p(n.parentNode, indexIn(n)), p(n.parentNode, indexIn(n) + 1)));
  wrap('selectNodeContents', (r, n) => setPoints(r, p(n, 0), p(n, lengthOf(n))));
  wrap('setStartBefore', (r, n) => setPoints(r, p(n.parentNode, indexIn(n)), pointsOf(r).end));
  wrap('setStartAfter', (r, n) => setPoints(r, p(n.parentNode, indexIn(n) + 1), pointsOf(r).end));
  wrap('setEndBefore', (r, n) => setPoints(r, pointsOf(r).start, p(n.parentNode, indexIn(n))));
  wrap('setEndAfter', (r, n) => setPoints(r, pointsOf(r).start, p(n.parentNode, indexIn(n) + 1)));
  const check = (node: N, offset: number) => {
    if (!node || typeof node !== 'object') throw new TypeError('Range: the boundary node is not a Node.');
    if (offset < 0 || offset > lengthOf(node)) throw domError(`There is no child at offset ${offset}.`, 'IndexSizeError');
  };
  Object.assign(proto, {
    setStart(this: N, node: N, offset: number) { check(node, offset); const e = pointsOf(this).end; setPoints(this, p(node, offset), e.node === doc ? p(node, offset) : e); },
    setEnd(this: N, node: N, offset: number) { check(node, offset); const s = pointsOf(this).start; setPoints(this, s.node === doc ? p(node, offset) : s, p(node, offset)); },
    collapse(this: N, toStart = false) { const {start, end} = pointsOf(this); setPoints(this, toStart ? start : end, toStart ? start : end); },
    cloneRange(this: N) { const r = doc.createRange(); const {start, end} = pointsOf(this); setPoints(r, start, end); return r; },
    toString(this: N) { const {start, end} = pointsOf(this); return textBetween(start, end); },
    getBoundingClientRect(this: N) { const n = pointsOf(this).start.node; const el = n.nodeType === 1 ? n : n.parentElement; return el?.getBoundingClientRect?.() ?? new g.DOMRect(); },
    getClientRects() { return []; },
    detach() {},
  });
  for (const [name, get] of [['startContainer', (r: N) => pointsOf(r).start.node], ['startOffset', (r: N) => pointsOf(r).start.offset],
    ['endContainer', (r: N) => pointsOf(r).end.node], ['endOffset', (r: N) => pointsOf(r).end.offset],
    ['collapsed', (r: N) => { const {start, end} = pointsOf(r); return start.node === end.node && start.offset === end.offset; }]] as const) {
    Object.defineProperty(proto, name, {configurable: true, get() { return get(this); }});
  }
}

// ---- The document's selection: one range at most, as in browsers. Changes fire selectionchange on the document.
let changeQueued = false;
const changed = () => {
  if (changeQueued) return;
  changeQueued = true;
  setTimeout(() => { changeQueued = false; doc.dispatchEvent(new g.Event('selectionchange')); }, 0);
};
export class Selection {
  private range: N | null = null;
  private backward = false;
  get rangeCount() { return this.range ? 1 : 0; }
  get anchorNode() { return this.range ? (this.backward ? this.range.endContainer : this.range.startContainer) : null; }
  get anchorOffset() { return this.range ? (this.backward ? this.range.endOffset : this.range.startOffset) : 0; }
  get focusNode() { return this.range ? (this.backward ? this.range.startContainer : this.range.endContainer) : null; }
  get focusOffset() { return this.range ? (this.backward ? this.range.startOffset : this.range.endOffset) : 0; }
  get isCollapsed() { return !this.range || !!this.range.collapsed; }
  get type() { return !this.range ? 'None' : this.range.collapsed ? 'Caret' : 'Range'; }
  get direction() { return !this.range || this.range.collapsed ? 'none' : this.backward ? 'backward' : 'forward'; }
  getRangeAt(i: number) { if (!this.range || i !== 0) throw domError(`${i} is not a valid index.`, 'IndexSizeError'); return this.range; }
  addRange(r: N) { if (this.range) return; this.range = r; this.backward = false; changed(); }
  removeRange(r: N) { if (r === this.range) this.removeAllRanges(); }
  removeAllRanges() { if (!this.range) return; this.range = null; changed(); }
  empty() { this.removeAllRanges(); }
  collapse(node: N | null, offset = 0) {
    if (!node) { this.removeAllRanges(); return; }
    const r = doc.createRange(); r.setStart(node, offset); r.setEnd(node, offset); this.range = r; this.backward = false; changed();
  }
  setPosition(node: N | null, offset = 0) { this.collapse(node, offset); }
  collapseToStart() { if (this.range) this.collapse(this.range.startContainer, this.range.startOffset); }
  collapseToEnd() { if (this.range) this.collapse(this.range.endContainer, this.range.endOffset); }
  extend(node: N, offset = 0) { if (this.range) this.setBaseAndExtent(this.anchorNode, this.anchorOffset, node, offset); }
  setBaseAndExtent(an: N, ao: number, fn: N, fo: number) {
    const r = doc.createRange(), forward = an === fn ? ao <= fo : !!(an.compareDocumentPosition?.(fn) & 4);
    if (forward) { r.setStart(an, ao); r.setEnd(fn, fo); } else { r.setStart(fn, fo); r.setEnd(an, ao); }
    this.range = r; this.backward = !forward; changed();
  }
  selectAllChildren(node: N) { const r = doc.createRange(); r.selectNodeContents(node); this.range = r; this.backward = false; changed(); }
  containsNode(node: N, partly = false) {
    const c = this.range?.commonAncestorContainer as N | null;
    if (!c || !node) return false;
    return partly ? c === node || !!c.contains?.(node) || !!node.contains?.(c) : c !== node && !!c.contains?.(node);
  }
  deleteFromDocument() { this.range?.deleteContents?.(); }
  modify() {}
  toString() { return this.range ? String(this.range.toString()) : ''; }
}

let installed = false;
export function installTextSelection() {
  if (installed) return;
  installed = true;
  installFieldSelection(domPage.HTMLInputElement?.prototype);
  installFieldSelection(domPage.HTMLTextAreaElement?.prototype);
  // linkedom makes Ranges (document.createRange) but does not name their class on the window.
  const rangeProto = typeof doc.createRange === 'function' ? Object.getPrototypeOf(doc.createRange()) as N : undefined;
  installRange(rangeProto);
  if (rangeProto && typeof g.Range !== 'function') g.Range = rangeProto.constructor;
  const selection = new Selection();
  g.Selection ??= Selection;
  if (typeof g.getSelection !== 'function') g.getSelection = () => selection;
  if (typeof doc.getSelection !== 'function') doc.getSelection = () => selection;
}
installTextSelection();
