/** Smaller pieces of the browser's DOM that linkedom and Puerts lack, each one a page met:
 *  - document.implementation (createHTMLDocument: HTML sanitizers parse untrusted markup in a document of their own);
 *  - XMLSerializer (markup for an SVG foreignObject or a saved file);
 *  - document.styleSheets, readyState, the DOMContentLoaded and load events, and the read-only document fields;
 *  - the innerText setter (linkedom has only the getter, so a module's assignment threw);
 *  - the event classes linkedom has no class for, getModifierState, NodeFilter;
 *  - navigator.onLine and cookieEnabled, and document.execCommand (no editing commands here: it answers false). */
import {parseHTML, DOMParser as LinkedomParser, NodeFilter as LinkedomNodeFilter} from 'linkedom';
import {domPage} from './dom';

const g = globalThis as Record<string, any>;
type N = Record<string, any>;
const doc = domPage.document as N;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const defineGetter = (o: N, k: string, get: () => unknown) => { if (!(k in o)) Object.defineProperty(o, k, {configurable: true, get}); };

function installImplementation() {
  if (doc.implementation) return;
  const implementation = {
    createHTMLDocument(title?: string) {
      const head = title === undefined ? '' : `<title>${esc(String(title))}</title>`;
      return parseHTML(`<!doctype html><html><head>${head}</head><body></body></html>`).document;
    },
    createDocument(ns: string | null, qualifiedName: string | null) {
      const name = qualifiedName ? String(qualifiedName) : 'root';
      const d = new LinkedomParser().parseFromString(`<${name}${ns ? ` xmlns="${esc(String(ns))}"` : ''}/>`, 'text/xml') as N;
      if (!qualifiedName) d.documentElement?.remove();
      return d;
    },
    createDocumentType(name: string, publicId = '', systemId = '') { return {nodeType: 10, nodeName: name, name, publicId, systemId}; },
    hasFeature: () => true,
  };
  Object.defineProperty(doc, 'implementation', {configurable: true, value: implementation});
}

const VOID = /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b([^>]*?)\s*\/?>/gi;
/** Markup as XML, the way a browser's XMLSerializer writes an HTML element: an XHTML namespace on the root element
 *  and void elements closed ("<br />"). SVG keeps its own namespace. */
export class XMLSerializer {
  serializeToString(node: N): string {
    if (!node) throw new TypeError("Failed to execute 'serializeToString': parameter 1 is not of type 'Node'.");
    if (node.nodeType === 9) node = node.documentElement ?? node;
    if (node.nodeType === 3) return esc(String(node.data ?? ''));
    if (node.nodeType === 8) return `<!--${node.data ?? ''}-->`;
    if (node.nodeType === 11) return [...(node.childNodes ?? [])].map(c => this.serializeToString(c)).join('');
    let out = String(node.outerHTML ?? node.toString?.() ?? '');
    if (node.nodeType !== 1) return out;
    const svg = String(node.tagName).toLowerCase() === 'svg' || !!node.ownerSVGElement;
    if (!/^<[^\s>/]+[^>]*\sxmlns=/.test(out)) out = out.replace(/^<([^\s>/]+)/, `<$1 xmlns="${svg ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml'}"`);
    return svg ? out : out.replace(VOID, '<$1$2 />');
  }
}

/** readyState follows a browser's: the game's module runs while the page is "interactive", then DOMContentLoaded and
 *  load fire on the next turn and the page is "complete". Code that waits for window "load" before its first step
 *  (a service worker registration, a splash animation) used to wait forever. */
function installDocumentState() {
  let state = 'interactive';
  Object.defineProperty(doc, 'readyState', {configurable: true, get: () => state});
  const toWindow = g.dispatchEvent as ((e: unknown) => boolean) | undefined, Event = g.Event as new (type: string, init?: N) => N;
  setTimeout(() => {
    doc.dispatchEvent(new Event('readystatechange'));
    doc.dispatchEvent(new Event('DOMContentLoaded', {bubbles: true}));
    state = 'complete';
    doc.dispatchEvent(new Event('readystatechange'));
    toWindow?.(new Event('load'));
    toWindow?.(new (g.PageTransitionEvent ?? Event)('pageshow', {persisted: false}));
  }, 0);
  if (!('styleSheets' in doc)) Object.defineProperty(doc, 'styleSheets', {configurable: true, get: () => []});
  defineGetter(doc, 'currentScript', () => null);
  defineGetter(doc, 'scrollingElement', () => doc.documentElement);
  defineGetter(doc, 'compatMode', () => 'CSS1Compat');
  defineGetter(doc, 'characterSet', () => 'UTF-8');
  defineGetter(doc, 'charset', () => 'UTF-8');
  defineGetter(doc, 'inputEncoding', () => 'UTF-8');
  defineGetter(doc, 'contentType', () => 'text/html');
  defineGetter(doc, 'designMode', () => 'off');
  defineGetter(doc, 'lastModified', () => new Date().toLocaleString());
  if (!('dir' in doc)) Object.defineProperty(doc, 'dir', {configurable: true,
    get: () => doc.documentElement?.getAttribute('dir') ?? '', set: (v: unknown) => doc.documentElement?.setAttribute('dir', String(v))});
  // Editing commands act on the page's own editable regions, which only the overlay edits: none of them run here.
  doc.execCommand ??= () => false;
  doc.queryCommandSupported ??= () => false;
  doc.queryCommandEnabled ??= () => false;
  doc.queryCommandState ??= () => false;
  doc.queryCommandValue ??= () => '';
}

/** innerText's setter, as text with a <br> for each line break. */
function installInnerText() {
  for (let p = domPage.HTMLElement.prototype as N | null; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, 'innerText');
    if (!d) continue;
    if (d.set) return;
    Object.defineProperty(p, 'innerText', {configurable: true, enumerable: d.enumerable, get: d.get, set(this: N, v: unknown) {
      const lines = String(v ?? '').split(/\r\n|\r|\n/), owner = this.ownerDocument ?? doc;
      this.textContent = '';
      lines.forEach((line, i) => { if (i) this.appendChild(owner.createElement('br')); if (line) this.appendChild(owner.createTextNode(line)); });
    }});
    return;
  }
}

/** Event classes a page names (new X(), instanceof X) that the runtime had no class for. DragEvent and ClipboardEvent
 *  belong with drag and drop and the clipboard (fileApi.ts and its neighbours), not here. */
function installEventClasses() {
  const Base = g.Event as new (type: string, init?: N) => N;
  const make = (Parent: new (type: string, init?: N) => N, defaults: N) => class extends Parent {
    constructor(type: string, init: N = {}) { super(type, init); for (const [k, v] of Object.entries(defaults)) if (!(k in this) || init[k] !== undefined) (this as N)[k] = init[k] ?? v; }
  };
  const classes: [string, () => new (type: string, init?: N) => N][] = [
    ['CompositionEvent', () => make(g.UIEvent ?? Base, {data: '', locale: ''})],
    ['SubmitEvent', () => make(Base, {submitter: null})],
    ['ToggleEvent', () => make(Base, {oldState: '', newState: ''})],
    ['StorageEvent', () => make(Base, {key: null, oldValue: null, newValue: null, url: '', storageArea: null})],
    ['HashChangeEvent', () => make(Base, {oldURL: '', newURL: ''})],
    ['PageTransitionEvent', () => make(Base, {persisted: false})],
    ['BeforeUnloadEvent', () => make(Base, {returnValue: ''})],
    ['PromiseRejectionEvent', () => make(Base, {promise: null, reason: undefined})],
    ['TransitionEvent', () => make(Base, {propertyName: '', elapsedTime: 0, pseudoElement: ''})],
    ['AnimationEvent', () => make(Base, {animationName: '', elapsedTime: 0, pseudoElement: ''})],
    ['CloseEvent', () => make(Base, {code: 0, reason: '', wasClean: false})],
  ];
  for (const [name, build] of classes) if (typeof g[name] !== 'function' && Base) g[name] = build();
  // getModifierState reads the event's own modifier flags; CapsLock and the rest are off.
  const MODS: Record<string, string> = {Shift: 'shiftKey', Control: 'ctrlKey', Alt: 'altKey', Meta: 'metaKey'};
  for (const name of ['KeyboardEvent', 'MouseEvent', 'PointerEvent', 'WheelEvent', 'TouchEvent', 'DragEvent']) {
    const proto = g[name]?.prototype as N | undefined;
    if (proto && typeof proto.getModifierState !== 'function') proto.getModifierState = function (this: N, key: string) { const f = MODS[key]; return f ? !!this[f] : false; };
  }
  g.NodeFilter ??= LinkedomNodeFilter;
}

/** The network is there: requests go through the host. A page reads navigator.onLine before it saves to its server. */
function installNavigator() {
  const nav = g.navigator as N | undefined;
  if (!nav) return;
  for (const [k, v] of [['onLine', true], ['cookieEnabled', true], ['pdfViewerEnabled', false], ['webdriver', false]] as const) {
    if (nav[k] === undefined) { try { Object.defineProperty(nav, k, {configurable: true, get: () => v}); } catch { /* a host navigator */ } }
  }
}

let installed = false;
export function installDomGaps() {
  if (installed) return;
  installed = true;
  installImplementation();
  g.XMLSerializer ??= XMLSerializer;
  installDocumentState();
  installInnerText();
  installEventClasses();
  installNavigator();
}
installDomGaps();
