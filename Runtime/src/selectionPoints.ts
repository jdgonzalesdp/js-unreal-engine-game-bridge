import {editingHost} from './editHosts';

/** A selection boundary (a node and an offset) written so the page and the overlay find the same place in their two
 *  copies of the DOM. The copies match element for element, but not always text node for text node: the page can hold
 *  two text nodes side by side where the overlay's parse has one. So a point names an element and, inside it, how many
 *  element children come before it (c) and how many characters into the text that follows (t).
 *  The element is reached from an element with a data-jsgb id by element child indexes (path). Inside an editable
 *  region it is always the region's own element, since what the overlay types there has no ids.
 *  The overlay has the same reading and writing (JavaScript/jsgb-ui-edit.js). */
type N = Record<string, any>;
export type Point = {id: string; path: number[]; c: number; t: number};

const isText = (n: N) => n.nodeType === 3;
const textLength = (n: N) => String(n.data ?? n.nodeValue ?? '').length;

/** The point for (node, offset), or null when the node is not in a mirrored element. */
export function writePoint(node: N | null | undefined, offset: number): Point | null {
  if (!node) return null;
  let parent: N | null, upTo: number;
  if (isText(node)) { parent = node.parentNode; upTo = Array.prototype.indexOf.call(parent?.childNodes ?? [], node); }
  else { parent = node; upTo = offset; }
  if (!parent || parent.nodeType !== 1) return null;
  let c = 0, t = 0;
  const kids = parent.childNodes ?? [];
  for (let i = 0; i < upTo && i < kids.length; i++) {
    if (kids[i].nodeType === 1) { c++; t = 0; } else if (isText(kids[i])) t += textLength(kids[i]);
  }
  if (isText(node)) t += Math.max(0, Math.min(offset, textLength(node)));
  const host = editingHost(parent), path: number[] = [];
  const stop = (e: N) => host ? e === host : !!e.getAttribute?.('data-jsgb');
  let el: N | null = parent;
  while (el && !stop(el)) {
    const up: N | null = el.parentNode;
    if (!up || up.nodeType !== 1) return null;
    path.unshift(Array.prototype.indexOf.call(up.children ?? [], el));
    el = up;
  }
  const id = el?.getAttribute?.('data-jsgb');
  return id ? {id: String(id), path, c, t} : null;
}

/** The (node, offset) a point names in this DOM, or null when it is not there. */
export function readPoint(p: Point | null | undefined, byId: (id: string) => N | null): {node: N; offset: number} | null {
  if (!p || typeof p.id !== 'string') return null;
  let el = byId(p.id);
  for (const i of Array.isArray(p.path) ? p.path : []) { el = el?.children?.[i] ?? null; if (!el) return null; }
  if (!el) return null;
  const kids = el.childNodes ?? [];
  let i = 0, c = 0;
  for (; i < kids.length && c < (p.c | 0); i++) if (kids[i].nodeType === 1) c++;
  let acc = 0, last: N | null = null;
  for (let j = i; j < kids.length && kids[j].nodeType !== 1; j++) {
    if (!isText(kids[j])) continue;
    const len = textLength(kids[j]);
    if ((p.t | 0) <= acc + len) return {node: kids[j], offset: Math.max(0, (p.t | 0) - acc)};
    acc += len; last = kids[j];
  }
  return last ? {node: last, offset: textLength(last)} : {node: el, offset: i};
}
