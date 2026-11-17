import {startsEditing} from './editHosts';

/** Editable regions (contenteditable) typed in the overlay. The overlay edits its copy natively: its caret, IME and
 *  the browser's own editing. After each edit it sends the region's HTML (JavaScript/jsgb-ui-edit.js), and this
 *  changes the page's element to match, in place: a typed letter changes one text node, as a browser's editor does,
 *  so the nodes and ranges the page holds stay where they were.
 *  The page changes regions too (its own DOM work on Enter, a command's result arriving, a new note's seed). Each
 *  region carries a revision, data-jsgb-rev, that goes up whenever its content changed by the page's own doing, and an
 *  overlay edit names the revision it was made on. An edit made on an older revision is dropped, and the overlay then
 *  shows the page's content; while the revision holds, the overlay keeps its own copy of the region (it is ahead). */
type El = Record<string, any>;
const REV = 'data-jsgb-rev';
const regions = new WeakMap<El, {rev: number; html: string}>();
// The regions publishUI's stamping walk met (it stops at each, since their insides carry no ids).
const known = new Set<El>();

/** The stamping walk's question for each element: true when it starts a region, which it then knows and revises. */
export function regionStart(el: El): boolean {
  if (!startsEditing(el)) return false;
  if (!known.has(el)) { known.add(el); touch(el); }
  return true;
}

/** Raises the revision of each known region whose content the page changed since the last look. publishUI asks before
 *  it builds the HTML; true when a revision changed. */
export function refreshRegions(): boolean {
  let changed = false;
  for (const el of known) {
    if (!el.isConnected || !startsEditing(el)) { known.delete(el); continue; }
    changed = touch(el) || changed;
  }
  return changed;
}

/** Brings a region's revision up to date with its content; true when it went up. */
function touch(el: El): boolean {
  const html = String(el.innerHTML), r = regions.get(el);
  if (r && r.html === html && el.getAttribute(REV) === String(r.rev)) return false;
  const next = r && r.html === html ? r : {rev: (r?.rev ?? 0) + 1, html};
  regions.set(el, next);
  el.setAttribute(REV, String(next.rev));
  return true;
}

/** Applies an overlay edit of a region. False when it was made on content the page has changed since. */
export function applyRegionEdit(host: El, html: unknown, rev: unknown): boolean {
  if (typeof html !== 'string') return false;
  known.add(host);
  touch(host);
  const r = regions.get(host)!;
  if (String(rev ?? '') !== String(r.rev)) return false;
  const box = host.ownerDocument.createElement('div');
  box.innerHTML = html;
  morph(host, box);
  r.html = String(host.innerHTML);
  return true;
}

/** Makes current's children match next's, reusing current's nodes where kind and tag match. */
function morph(current: El, next: El) {
  const incoming = [...next.childNodes] as El[];
  incoming.forEach((n, i) => {
    const c = current.childNodes[i] as El | undefined;
    if (!c) { current.appendChild(n); return; }
    if (c.nodeType !== n.nodeType || c.nodeName !== n.nodeName) { current.replaceChild(n, c); return; }
    if (c.nodeType !== 1) { if (c.nodeValue !== n.nodeValue) c.nodeValue = n.nodeValue; return; }
    for (const a of [...c.attributes] as {name: string}[]) if (!a.name.startsWith('data-jsgb') && !n.hasAttribute(a.name)) c.removeAttribute(a.name);
    for (const a of [...n.attributes] as {name: string; value: string}[]) if (c.getAttribute(a.name) !== a.value) c.setAttribute(a.name, a.value);
    morph(c, n);
  });
  while (current.childNodes.length > incoming.length) current.removeChild(current.lastChild);
}
