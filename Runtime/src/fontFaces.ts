/** FontFace and document.fonts (a FontFaceSet) as browsers have them. A page loads a web font with
 *  new FontFace(name, 'url(...)').load() and document.fonts.add(face), then names the family in its CSS: PrepViz's
 *  font picker shows each row in its own face that way. The runtime had neither, so the guarded code fell back to the
 *  default font. Here load() fetches the font through the runtime's fetch (the game's own files, or the network
 *  origins the game may reach), checks it is a font file, and an added face becomes an @font-face rule in a <style>
 *  in <head>, which ui.ts carries to the overlay. The rule's source is a blob: URL of the bytes, which the overlay
 *  loads from the host (/bridge/blob/), so the overlay never needs to reach the font's own address. */
const g = globalThis as Record<string, any>;
type Listener = (e: unknown) => void;

/** sfnt, OpenType CFF, Apple TrueType, a collection, WOFF and WOFF2. */
const FONT_TAGS = new Set([0x00010000, 0x4f54544f, 0x74727565, 0x74746366, 0x774f4646, 0x774f4632]);
const DESCRIPTORS = ['style', 'weight', 'stretch', 'unicodeRange', 'variant', 'featureSettings', 'variationSettings', 'display', 'ascentOverride', 'descentOverride', 'lineGapOverride'] as const;
const CSS_NAME: Record<string, string> = {style: 'font-style', weight: 'font-weight', stretch: 'font-stretch', unicodeRange: 'unicode-range', display: 'font-display',
  featureSettings: 'font-feature-settings', variationSettings: 'font-variation-settings', ascentOverride: 'ascent-override', descentOverride: 'descent-override', lineGapOverride: 'line-gap-override'};
const DEFAULTS: Record<string, string> = {style: 'normal', weight: 'normal', stretch: 'normal', unicodeRange: 'U+0-10FFFF', variant: 'normal', featureSettings: 'normal',
  variationSettings: 'normal', display: 'auto', ascentOverride: 'normal', descentOverride: 'normal', lineGapOverride: 'normal'};

const domError = (message: string, name: string) => new (g.DOMException ?? Error)(message, name);
const unquote = (s: string) => s.trim().replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
const cssString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The url(...) sources of a CSS src descriptor, in order (local() faces are not available here). */
function sourceUrls(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/g)) out.push((m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1'));
  return out;
}

function isFont(bytes: Uint8Array) {
  if (bytes.length < 12) return false;
  return FONT_TAGS.has(((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0);
}

export class FontFace {
  family: string; status: 'unloaded' | 'loading' | 'loaded' | 'error' = 'unloaded';
  readonly loaded: Promise<FontFace>;
  /** @internal The blob: URL of the loaded bytes, which the @font-face rule names. */
  _url = '';
  /** @internal Sets told when this face starts or finishes loading. */
  _sets = new Set<FontFaceSet>();
  private source: string | Uint8Array; private settle!: (ok: boolean, e?: unknown) => void; private started = false;
  [key: string]: unknown;
  constructor(family: string, source: string | ArrayBuffer | ArrayBufferView, descriptors: Record<string, string> = {}) {
    this.family = unquote(String(family));
    for (const d of DESCRIPTORS) this[d] = descriptors?.[d] !== undefined ? String(descriptors[d]) : DEFAULTS[d];
    this.loaded = new Promise<FontFace>((resolve, reject) => { this.settle = (ok, e) => ok ? resolve(this) : reject(e); });
    this.loaded.catch(() => undefined);
    if (typeof source === 'string') { this.source = source; if (!sourceUrls(source).length) this.fail(domError('The font source could not be parsed.', 'SyntaxError')); return; }
    const bytes = source instanceof ArrayBuffer ? new Uint8Array(source.slice(0)) : ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice() : null;
    if (!bytes) throw new TypeError('A FontFace source must be a string, an ArrayBuffer or a view of one.');
    // A face made from bytes starts loading at once, as in a browser.
    this.source = bytes;
    void this.load();
  }

  load(): Promise<FontFace> {
    if (this.started || this.status === 'error') return this.loaded;
    this.started = true;
    this.status = 'loading';
    for (const set of this._sets) set._began(this);
    void (async () => {
      try {
        const bytes = typeof this.source === 'string' ? await this.fetchFirst(sourceUrls(this.source)) : this.source;
        if (!isFont(bytes)) throw domError(`The font for "${this.family}" is not a font file.`, 'NetworkError');
        this._url = g.URL.createObjectURL(new g.Blob([bytes], {type: 'font/ttf'}));
        this.status = 'loaded';
        this.settle(true);
      } catch (e) { this.fail(e); }
      for (const set of this._sets) set._ended(this);
    })();
    return this.loaded;
  }

  private async fetchFirst(urls: string[]): Promise<Uint8Array> {
    let last: unknown = null;
    for (const url of urls) {
      try {
        const res = await g.fetch(new g.URL(url, g.location?.href ?? 'http://localhost/').href);
        if (res.ok) return new Uint8Array(await res.arrayBuffer());
        last = domError(`The font at ${url} answered ${res.status}.`, 'NetworkError');
      } catch (e) { last = e; }
    }
    throw last && (last as {name?: string}).name === 'NetworkError' ? last : domError(`The font for "${this.family}" could not be loaded.`, 'NetworkError');
  }
  private fail(e: unknown) { this.status = 'error'; this.settle(false, e); }

  /** @internal The @font-face rule for this face, once its bytes are in. */
  _rule() {
    if (!this._url) return '';
    const parts = [`font-family:${cssString(this.family)}`, `src:url("${this._url}")`];
    for (const d of DESCRIPTORS) if (CSS_NAME[d] && this[d] !== DEFAULTS[d]) parts.push(`${CSS_NAME[d]}:${this[d]}`);
    return `@font-face{${parts.join(';')}}`;
  }
}

/** The families a CSS font shorthand names ("bold 16px/1.2 'Foo Bar', serif"), in lower case. */
function familiesOf(font: string): string[] {
  const m = /(?:^|\s)(?:xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger|[\d.]+(?:px|pt|pc|em|rem|ex|ch|vw|vh|%|in|cm|mm|q))(?:\s*\/\s*\S+)?\s+(.+)$/i.exec(String(font).trim());
  if (!m) throw domError(`Could not parse the font "${font}".`, 'SyntaxError');
  const out: string[] = [];
  for (const part of m[1].match(/"[^"]*"|'[^']*'|[^,]+/g) ?? []) { const name = unquote(part); if (name && name !== ',') out.push(name.toLowerCase()); }
  return out;
}

export class FontFaceSet {
  status: 'loading' | 'loaded' = 'loaded';
  onloading: Listener | null = null; onloadingdone: Listener | null = null; onloadingerror: Listener | null = null;
  private faces = new Set<FontFace>(); private loading = new Set<FontFace>(); private done: FontFace[] = []; private failed: FontFace[] = [];
  private readyPromise: Promise<FontFaceSet> = Promise.resolve(this); private readyResolve: ((s: FontFaceSet) => void) | null = null;
  private listeners: Record<string, Listener[]> = {};
  constructor(private changed: () => void) {}

  get ready() { return this.readyPromise; }
  get size() { return this.faces.size; }
  add(face: FontFace) {
    if (!(face instanceof FontFace)) throw new TypeError('FontFaceSet.add needs a FontFace.');
    if (this.faces.has(face)) return this;
    this.faces.add(face); face._sets.add(this);
    // The overlay draws the page, so a face added before it loads is loaded now for the overlay to have it.
    if (face.status === 'loading') this._began(face);
    if (face.status === 'unloaded') void face.load();
    if (face.status === 'loaded') this.changed();
    return this;
  }
  delete(face: FontFace) { const had = this.faces.delete(face); face?._sets?.delete(this); if (had) { this.loading.delete(face); this.changed(); this.settleIfIdle(); } return had; }
  clear() { for (const f of [...this.faces]) this.delete(f); }
  has(face: FontFace) { return this.faces.has(face); }
  forEach(fn: (f: FontFace, f2: FontFace, set: FontFaceSet) => void, self?: unknown) { for (const f of this.faces) fn.call(self, f, f, this); }
  values() { return this.faces.values(); }
  keys() { return this.faces.values(); }
  entries() { return [...this.faces].map(f => [f, f] as [FontFace, FontFace])[Symbol.iterator](); }
  [Symbol.iterator]() { return this.faces.values(); }

  /** Loads every face in the set whose family the font shorthand names. */
  load(font: string, _text?: string): Promise<FontFace[]> {
    let names: string[];
    try { names = familiesOf(font); } catch (e) { return Promise.reject(e); }
    const matched = [...this.faces].filter(f => names.includes(f.family.toLowerCase()));
    return Promise.all(matched.map(f => f.load()));
  }
  /** Whether every face the font names is loaded (true when it names none of the set's faces: a system font). */
  check(font: string, _text?: string) { const names = familiesOf(font); return [...this.faces].filter(f => names.includes(f.family.toLowerCase())).every(f => f.status === 'loaded'); }

  addEventListener(type: string, fn: Listener) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type: string, fn: Listener) { this.listeners[type] = (this.listeners[type] ?? []).filter(f => f !== fn); }
  dispatchEvent(e: {type: string}) { this.fire(e.type, e as Record<string, unknown>); return true; }

  /** @internal */ _began(face: FontFace) {
    if (this.loading.has(face)) return;
    if (!this.loading.size) {
      this.status = 'loading';
      this.readyPromise = new Promise<FontFaceSet>(r => { this.readyResolve = r; });
      this.fire('loading', {fontfaces: []});
    }
    this.loading.add(face);
  }
  /** @internal */ _ended(face: FontFace) {
    if (!this.loading.delete(face)) { if (face.status === 'loaded') this.changed(); return; }
    (face.status === 'loaded' ? this.done : this.failed).push(face);
    if (face.status === 'loaded') this.changed();
    this.settleIfIdle();
  }
  private settleIfIdle() {
    if (this.loading.size || this.status === 'loaded') return;
    this.status = 'loaded';
    const done = this.done.splice(0), failed = this.failed.splice(0), resolve = this.readyResolve;
    this.readyResolve = null;
    // As in a browser, loadingdone and loadingerror fire, then ready resolves, a turn after the last load ends.
    g.setTimeout(() => {
      this.fire('loadingdone', {fontfaces: done});
      if (failed.length) this.fire('loadingerror', {fontfaces: failed});
      resolve?.(this);
    }, 0);
  }
  private fire(type: string, fields: Record<string, unknown>) {
    const e = {type, target: this, currentTarget: this, ...fields};
    const own = (this as unknown as Record<string, Listener | null>)['on' + type];
    for (const fn of [...(typeof own === 'function' ? [own] : []), ...(this.listeners[type] ?? [])]) {
      try { fn.call(this, e); } catch (err) { g.reportError?.(err); }
    }
  }
  /** @internal The @font-face rules of the set's loaded faces. */
  _rules() { return [...this.faces].map(f => f._rule()).filter(Boolean).join('\n'); }
}

/** Installs FontFace, and document.fonts in place of the runtime's stand-in. */
export function installFontFaces(doc: Record<string, any>) {
  if (/\[native code\]/.test(String(g.FontFace))) return;
  let style: Record<string, any> | null = null;
  const set: FontFaceSet = new FontFaceSet(() => {
    const css = set._rules();
    if (!style || !style.isConnected) {
      if (!css) return;
      style = doc.createElement('style'); style!.setAttribute('data-jsgb-fonts', ''); doc.head?.appendChild(style);
    }
    if (style!.textContent !== css) style!.textContent = css;
  });
  g.FontFace = FontFace; g.FontFaceSet = FontFaceSet;
  try { Object.defineProperty(doc, 'fonts', {value: set, configurable: true, writable: true}); } catch { doc.fonts = set; }
}
