import './domException';
import {domPage} from './dom';

/** Editable regions (contenteditable) and text fields, as browsers tell them apart. linkedom's isContentEditable only
 *  looks at the element's own attribute and its contentEditable is a boolean; a browser inherits editability from the
 *  nearest ancestor that says, and contentEditable is "true", "false", "plaintext-only" or "inherit". */
type El = Record<string, any>;

const editable = (el: El): string | null => {
  const v = el.getAttribute?.('contenteditable');
  return v == null ? null : String(v).toLowerCase() === 'false' ? 'false' : String(v).toLowerCase() === 'plaintext-only' ? 'plaintext-only' : 'true';
};

/** The editing host a node is in: the outermost element of its run of editable ancestors, or null. */
export function editingHost(node: El | null | undefined): El | null {
  let found: El | null = null;
  for (let el = node && node.nodeType === 1 ? node : node?.parentNode; el && el.nodeType === 1; el = el.parentNode) {
    const v = editable(el);
    if (v === 'false') break;
    if (v) found = el;
  }
  return found;
}

/** True for an element that starts an editable region: the page's DOM below it is the overlay's to edit, so the bridge
 *  leaves it unstamped (ui.ts), and the HTML the page reads back from it carries no bridge ids. */
export const startsEditing = (el: El) => { const v = editable(el); return v !== null && v !== 'false'; };

const TEXT_INPUTS = new Set(['text', 'search', 'url', 'tel', 'password', 'email', 'number']);
/** A field the person types into: a textarea, or an input whose type takes text. */
export const isTextField = (el: El | null | undefined) => !!el && el.nodeType === 1 &&
  (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TEXT_INPUTS.has(String(el.type ?? 'text'))));

let installed = false;
export function installEditHosts() {
  if (installed) return;
  installed = true;
  const EP = domPage.HTMLElement?.prototype as El | undefined;
  if (!EP) return;
  Object.defineProperty(EP, 'isContentEditable', {configurable: true, get(this: El) { return !!editingHost(this); }});
  Object.defineProperty(EP, 'contentEditable', {configurable: true,
    get(this: El) { return editable(this) ?? 'inherit'; },
    set(this: El, v: unknown) {
      const s = String(v).toLowerCase();
      if (s === 'inherit') this.removeAttribute('contenteditable');
      else if (s === 'true' || s === 'false' || s === 'plaintext-only') this.setAttribute('contenteditable', s);
      else throw new (globalThis as El).DOMException(`The value provided ('${v}') is not one of 'true', 'false', 'plaintext-only', or 'inherit'.`, 'SyntaxError');
    }});
}
installEditHosts();
