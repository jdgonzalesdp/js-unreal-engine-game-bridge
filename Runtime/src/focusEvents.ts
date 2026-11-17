import {domPage} from './dom';
import {deliver} from './input';

/** The events a browser fires when focus moves: blur and focusout on the element that had it, then focus and focusin
 *  on the one that takes it, each naming the other as relatedTarget. focus() and blur() here only moved
 *  document.activeElement, so a page's own blur() (Escape in a note editor, a rename committed by code) fired nothing,
 *  and an editor that saves when it loses focus never saved.
 *  The overlay's focus changes (the person clicking another field) come as focusin and focusout packets and go through
 *  focus() and blur() too (overlayEdits.ts), so each change fires its events once, whoever made it. As in a browser,
 *  focus() on an element that can't take focus does nothing. */
type El = Record<string, any>;
const g = globalThis as Record<string, any>;
// The element on the other side of the next change, when the overlay named it.
let pending: {related: El | null} | null = null;

/** Runs a focus change the overlay reported, naming the element focus came from or went to. */
export function withRelated(related: El | null, change: () => void) {
  pending = {related};
  try { change(); } finally { pending = null; }
}

/** Whether focus() takes: a browser ignores it on an element nobody can focus (a plain div) and on a disabled field.
 *  The body stays focusable here: focusing it lets go of the field that had focus. */
const CONTROLS = /^(INPUT|SELECT|TEXTAREA|BUTTON)$/;
function focusable(el: El): boolean {
  if (!el.isConnected) return false;
  const tag = String(el.tagName);
  if (el === g.document.body || el.hasAttribute('tabindex') || el.isContentEditable) return true;
  if (CONTROLS.test(tag)) return !el.hasAttribute('disabled') && !(tag === 'INPUT' && String(el.getAttribute('type')).toLowerCase() === 'hidden');
  if (tag === 'A' || tag === 'AREA') return el.hasAttribute('href');
  if (tag === 'AUDIO' || tag === 'VIDEO') return el.hasAttribute('controls');
  return tag === 'IFRAME' || tag === 'SUMMARY';
}

function fire(el: El, type: string, relatedTarget: El | null, bubbles: boolean) {
  deliver(el, new g.FocusEvent(type, {bubbles, cancelable: false, composed: true, relatedTarget}));
}

let installed = false;
export function installFocusEvents() {
  if (installed) return;
  installed = true;
  const EP = domPage.HTMLElement.prototype as El;
  const focus = EP.focus as (...a: unknown[]) => void, blur = EP.blur as (...a: unknown[]) => void;
  EP.focus = function (this: El, ...args: unknown[]) {
    const doc = g.document, before = doc.activeElement as El | null;
    if (!focusable(this)) return;
    focus.apply(this, args);
    if (doc.activeElement !== this || before === this) return;
    const from = before && before !== doc.body && before.isConnected ? before : null;
    const related = pending ? pending.related : from, to = this === doc.body ? null : this;
    pending = null;
    if (from) { fire(from, 'blur', to, false); fire(from, 'focusout', to, true); }
    // Focus on the body is no focus at all. A handler above may also have moved focus on: then this element's focus is
    // over before it was announced.
    if (!to || doc.activeElement !== this) return;
    fire(this, 'focus', related, false); fire(this, 'focusin', related, true);
  };
  EP.blur = function (this: El, ...args: unknown[]) {
    const doc = g.document, had = doc.activeElement === this;
    blur.apply(this, args);
    if (!had || doc.activeElement === this) return;
    const related = pending ? pending.related : null;
    pending = null;
    fire(this, 'blur', related, false); fire(this, 'focusout', related, true);
  };
}
installFocusEvents();
