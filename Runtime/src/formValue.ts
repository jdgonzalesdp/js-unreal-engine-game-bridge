import {domPage} from './dom';

/** Sets a field's value or checked state the way a browser edit does: through the element class's own setter.
 *  React wraps these properties on each field it renders, to notice the writes it makes itself. A plain assignment
 *  went through that wrapper, so React saw no change and never called onChange for typing, sliders or checkboxes. */
export function setFieldState(el: Record<string, any>, prop: 'value' | 'checked', v: unknown) {
  for (let p = Object.getPrototypeOf(el); p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, prop);
    if (!d) continue;
    if (d.set) d.set.call(el, v);
    else if (d.writable) el[prop] = v;
    return;
  }
  el[prop] = v;
}

const INPUT_TYPES = new Set(['hidden', 'text', 'search', 'tel', 'url', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local',
  'number', 'range', 'color', 'checkbox', 'radio', 'file', 'submit', 'image', 'reset', 'button']);

/** Two things React reads once to decide how a field reports edits, set as browsers have them:
 *  - input.type: lower case, and "text" when the attribute is missing or unknown. The page gave the raw attribute,
 *    null for a plain <input>, and React treats only known types as text fields, so a plain <input> never changed.
 *  - document.oninput: React looks for it as it loads. Without it React took its old Internet Explorer path, which
 *    calls the missing attachEvent when a field takes focus and notices edits only on key presses, so a slider dragged
 *    with the mouse never changed state. */
export function installFieldSupport() {
  const input = domPage.HTMLInputElement?.prototype as Record<string, any> | undefined;
  if (input) Object.defineProperty(input, 'type', {configurable: true,
    get() { const t = String(this.getAttribute('type') ?? '').toLowerCase(); return INPUT_TYPES.has(t) ? t : 'text'; },
    set(v: unknown) { this.setAttribute('type', String(v)); }});
  const doc = domPage.document as Record<string, any>;
  if ('oninput' in doc) return;
  const handlers = new WeakMap<object, unknown>();
  Object.defineProperty(Object.getPrototypeOf(doc), 'oninput', {configurable: true,
    get() { return handlers.get(this) ?? null; },
    set(fn: unknown) {
      const old = handlers.get(this);
      if (old) this.removeEventListener('input', old);
      handlers.delete(this);
      if (typeof fn === 'function') { handlers.set(this, fn); this.addEventListener('input', fn); }
    }});
}
