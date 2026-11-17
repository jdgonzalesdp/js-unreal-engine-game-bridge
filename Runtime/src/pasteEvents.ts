import {DataTransfer} from './fileApi';
import {base64Bytes} from './polyfills';
import {deliver} from './input';

/** Clipboard events and IME composition, as the overlay reports them (JavaScript/jsgb-ui-edit.js).
 *  - paste: the overlay holds the paste back, reads what the clipboard offers (text, HTML, and files such as a
 *    screenshot) and sends it. The page's paste listeners get a ClipboardEvent with that data in clipboardData, files
 *    included; when none of them cancels it, the overlay pastes, as the browser would have.
 *  - copy and cut run in the overlay as usual (its selection is the person's); the page's listeners see them.
 *  - compositionstart, compositionupdate and compositionend: an input method's text in progress, which the overlay's
 *    field shows natively. The page sees the events, and keys and input events carry isComposing while it lasts. */
type El = Record<string, any>;
const g = globalThis as Record<string, any>;

function clipboardEventClass() {
  if (typeof g.ClipboardEvent === 'function') return g.ClipboardEvent;
  const Base = g.Event as new (type: string, init?: El) => El;
  g.ClipboardEvent = class ClipboardEvent extends Base {
    clipboardData: unknown;
    constructor(type: string, init: El = {}) { super(type, init); this.clipboardData = init.clipboardData ?? null; }
  };
  return g.ClipboardEvent;
}
clipboardEventClass();

type Sent = {data?: Record<string, string>; files?: {name?: string; type?: string; lastModified?: number; base64?: string}[]};

/** The clipboard as the page sees it in a paste: the overlay's text and files, read only. */
function clipboardData(sent: Sent) {
  const dt = new DataTransfer();
  for (const [type, value] of Object.entries(sent.data ?? {})) dt.setData(type, String(value));
  for (const f of sent.files ?? []) {
    const bytes = base64Bytes(String(f.base64 ?? ''));
    dt.addFile(new g.File([bytes], String(f.name || 'image'), {type: String(f.type ?? ''), lastModified: Number(f.lastModified) || Date.now()}));
  }
  dt.protect(null);
  return dt;
}

/** Delivers a clipboard event; true when no listener cancelled it. */
export function deliverClipboard(target: El, p: El): boolean {
  const Ctor = clipboardEventClass();
  const dt = p.type === 'paste' ? clipboardData(p.clip ?? {}) : new DataTransfer();
  return deliver(target, new Ctor(String(p.type), {bubbles: true, cancelable: true, composed: true, clipboardData: dt}));
}

/** Delivers a composition event with the text the input method has so far. */
export function deliverComposition(target: El, p: El): boolean {
  const Ctor = (g.CompositionEvent ?? g.Event) as new (type: string, init?: El) => El;
  const e = new Ctor(String(p.type), {bubbles: true, cancelable: p.type === 'compositionstart', composed: true, data: String(p.data ?? '')});
  if (e.data === undefined) e.data = String(p.data ?? '');
  return deliver(target, e);
}
