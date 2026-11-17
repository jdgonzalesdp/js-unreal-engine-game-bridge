/** Form fields as browsers have them beyond their value: constraint validation (setCustomValidity, checkValidity,
 *  reportValidity, validity, validationMessage, willValidate) and a number field's valueAsNumber, stepUp and stepDown.
 *  linkedom has none of these. Apps clear a custom message with setCustomValidity('') inside their own edit and commit
 *  handlers, so the missing method threw there and the typed number never committed; a handler that reads
 *  valueAsNumber got undefined and dropped every edit. */
import {domPage} from './dom';

const g = globalThis as Record<string, any>;
type F = Record<string, any>;
const custom = new WeakMap<object, string>();

const typeOf = (el: F) => String(el.type ?? el.getAttribute?.('type') ?? '').toLowerCase();
const has = (el: F, attr: string) => !!el.hasAttribute?.(attr);
/** Fields that take no part in validation: disabled ones, read-only ones, buttons other than submit, hidden inputs. */
function barred(el: F) {
  const t = typeOf(el), tag = el.tagName;
  if (has(el, 'disabled') || el.closest?.('fieldset[disabled]')) return true;
  if (tag === 'INPUT' && /^(hidden|reset|button|image)$/.test(t)) return true;
  if (tag === 'BUTTON' && t !== 'submit' && t !== '') return true;
  if (tag === 'OUTPUT' || tag === 'FIELDSET' || tag === 'OBJECT') return true;
  return (tag === 'INPUT' || tag === 'TEXTAREA') && has(el, 'readonly');
}
const NUMERIC = new Set(['number', 'range']);
const EMAIL = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function validityOf(el: F) {
  const message = custom.get(el) ?? '', t = typeOf(el), value = String(el.value ?? ''), skip = barred(el);
  const empty = t === 'checkbox' || t === 'radio' ? !el.checked : el.tagName === 'SELECT' ? value === '' : value === '';
  const num = Number(value), min = el.getAttribute?.('min'), max = el.getAttribute?.('max'), pattern = el.getAttribute?.('pattern');
  let patternMismatch = false;
  if (!skip && pattern && value && el.tagName === 'INPUT') { try { patternMismatch = !new RegExp(`^(?:${pattern})$`, 'u').test(value); } catch { /* an invalid pattern is ignored */ } }
  const v: Record<string, boolean> = {
    valueMissing: !skip && has(el, 'required') && empty,
    typeMismatch: !skip && !!value && ((t === 'email' && !value.split(has(el, 'multiple') ? ',' : '\u0000').every(x => EMAIL.test(x.trim())))
      || (t === 'url' && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\S*$/.test(value))),
    patternMismatch, tooLong: false, tooShort: false,
    rangeUnderflow: !skip && NUMERIC.has(t) && value !== '' && min != null && min !== '' && num < Number(min),
    rangeOverflow: !skip && NUMERIC.has(t) && value !== '' && max != null && max !== '' && num > Number(max),
    stepMismatch: false, badInput: false, customError: !skip && message !== '',
  };
  return {...v, valid: !Object.values(v).some(Boolean)};
}

function messageOf(el: F) {
  if (barred(el)) return '';
  const v = validityOf(el);
  if (v.customError) return custom.get(el)!;
  if (v.valueMissing) return typeOf(el) === 'checkbox' ? 'Please check this box if you want to proceed.' : el.tagName === 'SELECT' ? 'Please select an item in the list.' : 'Please fill out this field.';
  if (v.typeMismatch) return typeOf(el) === 'email' ? 'Please enter an email address.' : 'Please enter a URL.';
  if (v.patternMismatch) return 'Please match the requested format.';
  if (v.rangeUnderflow) return `Value must be greater than or equal to ${el.getAttribute('min')}.`;
  if (v.rangeOverflow) return `Value must be less than or equal to ${el.getAttribute('max')}.`;
  return '';
}

/** checkValidity: an invalid field fires a cancelable "invalid" event at itself, as in a browser. */
function check(el: F) {
  if (validityOf(el).valid || barred(el)) return true;
  el.dispatchEvent?.(new g.Event('invalid', {cancelable: true}));
  return false;
}

function installValidity(proto: F | undefined) {
  if (!proto || 'setCustomValidity' in proto) return;
  Object.defineProperties(proto, {
    setCustomValidity: {configurable: true, writable: true, value(this: F, m: unknown) { custom.set(this, m === undefined ? 'undefined' : String(m)); }},
    checkValidity: {configurable: true, writable: true, value(this: F) { return check(this); }},
    reportValidity: {configurable: true, writable: true, value(this: F) { return check(this); }},
    validity: {configurable: true, get(this: F) { return validityOf(this); }},
    validationMessage: {configurable: true, get(this: F) { return messageOf(this); }},
    willValidate: {configurable: true, get(this: F) { return !barred(this); }},
  });
}

const DATE_TYPES = new Set(['date', 'datetime-local', 'month', 'week', 'time']);
/** A date-like field's value as milliseconds (UTC, as browsers read it), or NaN. */
function dateMs(t: string, v: string): number {
  if (!v) return NaN;
  if (t === 'time') { const m = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(v); return m ? ((+m[1] * 60 + +m[2]) * 60 + +(m[3] ?? 0)) * 1000 + +(m[4] ?? '0').padEnd(3, '0') : NaN; }
  if (t === 'month') { const m = /^(\d{4,})-(\d{2})$/.exec(v); return m ? Date.UTC(+m[1], +m[2] - 1, 1) : NaN; }
  if (t === 'week') {
    const m = /^(\d{4,})-W(\d{2})$/.exec(v); if (!m) return NaN;
    const jan4 = Date.UTC(+m[1], 0, 4), day = (new Date(jan4).getUTCDay() + 6) % 7;
    return jan4 - day * 864e5 + (+m[2] - 1) * 7 * 864e5;
  }
  const ms = Date.parse(t === 'date' ? v + 'T00:00:00Z' : v + 'Z');
  return Number.isFinite(ms) ? ms : NaN;
}
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
function dateValue(t: string, ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  if (t === 'time') { const s = Math.round(((ms % 864e5) + 864e5) % 864e5 / 1000); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}${s % 60 ? ':' + pad(s % 60) : ''}`; }
  const day = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (t === 'month') return day.slice(0, 7);
  if (t === 'datetime-local') return `${day}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return day;
}

function installNumbers(proto: F | undefined) {
  if (!proto || 'valueAsNumber' in proto) return;
  Object.defineProperty(proto, 'valueAsNumber', {configurable: true,
    get(this: F) {
      const t = typeOf(this), v = String(this.value ?? '').trim();
      if (NUMERIC.has(t)) return v === '' || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v) ? NaN : Number(v);
      return DATE_TYPES.has(t) ? dateMs(t, v) : NaN;
    },
    set(this: F, n: number) {
      const t = typeOf(this);
      if (!NUMERIC.has(t) && !DATE_TYPES.has(t)) throw new g.DOMException('This input element does not support Number values.', 'InvalidStateError');
      this.value = NUMERIC.has(t) ? (Number.isFinite(n) ? String(n) : '') : dateValue(t, Number(n));
    }});
  Object.defineProperty(proto, 'valueAsDate', {configurable: true,
    get(this: F) { const t = typeOf(this); if (!DATE_TYPES.has(t) || t === 'datetime-local') return null; const ms = dateMs(t, String(this.value ?? '')); return Number.isFinite(ms) ? new Date(ms) : null; },
    set(this: F, d: Date | null) { const t = typeOf(this); this.value = d ? dateValue(t, d.getTime()) : ''; }});
  const step = (el: F, n: number) => {
    const t = typeOf(el);
    if (!NUMERIC.has(t)) throw new g.DOMException('This form element is not steppable.', 'InvalidStateError');
    const by = Number(el.getAttribute('step')) || 1, v = Number(el.value) || 0;
    const min = el.getAttribute('min'), max = el.getAttribute('max');
    let next = v + by * n;
    if (min != null && min !== '') next = Math.max(Number(min), next);
    if (max != null && max !== '') next = Math.min(Number(max), next);
    el.value = String(Math.round(next * 1e9) / 1e9);
  };
  proto.stepUp = function (this: F, n = 1) { step(this, n); };
  proto.stepDown = function (this: F, n = 1) { step(this, -n); };
}

let installed = false;
export function installFieldValidity() {
  if (installed) return;
  installed = true;
  const fields = ['HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement'];
  for (const name of fields) installValidity((domPage[name] ?? g[name])?.prototype);
  // <select> has no class of its own in linkedom's window: its element's own prototype takes them.
  installValidity(Object.getPrototypeOf(domPage.document.createElement('select')));
  installNumbers((domPage.HTMLInputElement ?? g.HTMLInputElement)?.prototype);
}
installFieldValidity();
