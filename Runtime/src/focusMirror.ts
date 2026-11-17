import {domPage} from './dom';

/** Focus the game moves itself (focus(), select(), autoFocus) reaches the overlay as a mark on the focused element:
 *  data-jsgb-focus="" after focus() and "select" after select(). The overlay focuses (and selects) the marked
 *  element when the mark moves (JavaScript/jsgb-ui-client.js), so a rename field the game focuses takes typing
 *  without a click first. The player's own focus changes come here as focusin and focusout and move the mark too. */
const g = globalThis as Record<string, any>;
export const FOCUS_MARK = 'data-jsgb-focus';
let marked: Record<string, any> | null = null;

function mark(el: Record<string, any> | null, how = '') {
  if (marked && marked !== el) marked.removeAttribute(FOCUS_MARK);
  marked = el;
  if (el && el.getAttribute(FOCUS_MARK) !== how) el.setAttribute(FOCUS_MARK, how);
}

let installed = false;
let fromOverlay = false;
/** Focus the player gave a field in the overlay. Its mark is "overlay", which the overlay never acts on, so a mark that
 *  arrives after the player moved on (a fast Tab, two quick clicks) can't pull focus back. */
export function focusFromOverlay(el: Record<string, any>) { fromOverlay = true; try { el.focus?.(); } finally { fromOverlay = false; } }

export function installFocusMirror() {
  if (installed) return;
  installed = true;
  const EP = domPage.HTMLElement.prototype as Record<string, any>;
  const focus = EP.focus as (...a: unknown[]) => void, blur = EP.blur as (...a: unknown[]) => void;
  EP.focus = function (this: Record<string, any>, ...args: unknown[]) {
    focus.apply(this, args);
    // Focus on the body is no focus at all: the overlay then lets go of the field it had.
    if (g.document.activeElement === this) mark(this === g.document.body ? null : this, fromOverlay ? 'overlay' : '');
  };
  EP.blur = function (this: Record<string, any>, ...args: unknown[]) {
    blur.apply(this, args);
    if (marked === this) mark(null);
  };
  for (const proto of [domPage.HTMLInputElement?.prototype, domPage.HTMLTextAreaElement?.prototype] as Record<string, any>[]) {
    if (!proto) continue;
    const select = proto.select as ((...a: unknown[]) => void) | undefined;
    // select() also focuses the field, as browsers do.
    proto.select = function (this: Record<string, any>, ...args: unknown[]) {
      select?.apply(this, args);
      this.focus();
      if (g.document.activeElement === this) mark(this, 'select');
    };
  }
}
