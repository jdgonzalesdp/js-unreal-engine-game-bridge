/** <form> elements as browsers have them. linkedom makes every <form> a plain HTMLElement (its HTMLFormElement class is
 *  never used for the tag), so the form methods dom.ts puts on HTMLFormElement.prototype (requestSubmit, submit,
 *  checkValidity) never reached a real form, and form.requestSubmit() threw. Here every <form> a document makes (by
 *  createElement, from markup, or as a copy) gets that prototype, and forms gain elements, length and constraint
 *  validation over their fields (fieldValidity.ts): checkValidity asks every field, firing "invalid" at each invalid
 *  one, and requestSubmit validates first unless the form has novalidate or the submitter formnovalidate. */
const g = globalThis as Record<string, any>;
type El = Record<string, any>;

const LISTED = 'button,fieldset,input,object,output,select,textarea';

/** The form's controls in tree order, with each named or id'd control also reachable by that name, as an
 *  HTMLFormControlsCollection. */
function controlsOf(form: El) {
  const list = [...form.querySelectorAll(LISTED)].filter((el: El) => !(el.tagName === 'INPUT' && String(el.getAttribute('type') ?? '').toLowerCase() === 'image')) as El[] & Record<string, any>;
  list.item = (i: number) => list[i] ?? null;
  list.namedItem = (name: string) => list.find(el => el.id === name || el.getAttribute('name') === name) ?? null;
  for (const el of [...list]) for (const key of [el.id, el.getAttribute('name')]) if (key && !(key in list)) list[key] = el;
  return list;
}

const validates = (el: El) => typeof el.checkValidity === 'function';

export function installForms(page: Record<string, any>, doc: El) {
  const FormClass = page.HTMLFormElement as (new (...a: unknown[]) => El) | undefined;
  if (!FormClass) return;
  const proto = FormClass.prototype as Record<string, any>;
  const adopt = (el: El) => { if (el && String(el.localName ?? '').toLowerCase() === 'form' && !(el instanceof FormClass)) Object.setPrototypeOf(el, proto); return el; };
  // Every HTML document (the page, ones DOMParser or createHTMLDocument make) shares this prototype.
  const docProto = Object.getPrototypeOf(doc) as Record<string, any>;
  if (!docProto.createElement.__jsgbForms) {
    const create = docProto.createElement as (this: El, name: string, options?: unknown) => El;
    const wrapped = function (this: El, name: string, options?: unknown) { return adopt(create.call(this, name, options)); };
    (wrapped as unknown as Record<string, boolean>).__jsgbForms = true;
    docProto.createElement = wrapped;
  }
  for (const form of doc.querySelectorAll('form')) adopt(form);

  const define = (name: string, d: PropertyDescriptor) => Object.defineProperty(proto, name, {configurable: true, ...d});
  define('elements', {get() { return controlsOf(this); }});
  define('length', {get() { return controlsOf(this).length; }});
  for (const [prop, attr] of [['noValidate', 'novalidate']] as const) define(prop, {get() { return this.hasAttribute(attr); }, set(v) { this.toggleAttribute(attr, !!v); }});
  for (const [prop, attr, fallback] of [['method', 'method', 'get'], ['action', 'action', ''], ['enctype', 'enctype', 'application/x-www-form-urlencoded'],
    ['target', 'target', ''], ['name', 'name', ''], ['acceptCharset', 'accept-charset', ''], ['autocomplete', 'autocomplete', 'on']] as const) {
    if (!Object.getOwnPropertyDescriptor(proto, prop)) define(prop, {get() { return this.getAttribute(attr) ?? fallback; }, set(v) { this.setAttribute(attr, String(v)); }});
  }
  // Each field's own check fires its "invalid" event; the form is valid when all of them are.
  const check = function (this: El) { let ok = true; for (const el of controlsOf(this)) if (validates(el) && !el.checkValidity()) ok = false; return ok; };
  define('checkValidity', {value: check, writable: true});
  define('reportValidity', {value: check, writable: true});
  const submit = proto.requestSubmit as ((this: El, submitter?: unknown) => void) | undefined;
  define('requestSubmit', {writable: true, value(this: El, submitter?: El | null) {
    if (submitter != null) {
      const type = String(submitter.getAttribute?.('type') ?? (submitter.tagName === 'BUTTON' ? 'submit' : '')).toLowerCase();
      if (!(submitter.tagName === 'BUTTON' || submitter.tagName === 'INPUT') || !['submit', 'image'].includes(type || 'submit'))
        throw new TypeError('The submitter is not a submit button.');
      if (submitter.form !== undefined ? submitter.form !== this : submitter.closest?.('form') !== this)
        throw new (g.DOMException ?? Error)('The submitter is not owned by this form.', 'NotFoundError');
    }
    const skip = this.hasAttribute('novalidate') || !!submitter?.hasAttribute?.('formnovalidate');
    if (!skip && !check.call(this)) return;
    submit?.call(this, submitter ?? null);
  }});
}
