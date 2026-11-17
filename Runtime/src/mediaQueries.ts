/** matchMedia with real media queries, evaluated against the viewport the overlay reports, and "change" events when a
 *  query's answer changes as the window is resized. The stand-in it replaces matched any query naming min-width and
 *  nothing naming max-width, whatever the size, so a layout switch at a breakpoint never happened.
 *  What the runtime can't see is answered as a desktop browser with a mouse answers: a fine pointer that hovers,
 *  no reduced motion, an sRGB, standard-range display. The color scheme comes from the host when it gives one
 *  (__jsgbHost.colorScheme, "light" or "dark"); without it neither scheme matches, as before. */
import {domPage} from './dom';

const g = globalThis as Record<string, any>;
type Env = {width: number; height: number; dpr: number; scheme: string | null; screenW: number; screenH: number};
const env = (): Env => {
  const s = g.__jsgbHost?.colorScheme, scheme = typeof s === 'function' ? s() : s;
  return {width: Number(g.innerWidth) || 0, height: Number(g.innerHeight) || 0, dpr: Number(g.devicePixelRatio) || 1,
    scheme: scheme === 'light' || scheme === 'dark' ? scheme : null, screenW: Number(g.screen?.width) || 0, screenH: Number(g.screen?.height) || 0};
};

/** Splits on a separator at the top level (outside parentheses). */
function splitTop(s: string, sep: RegExp): string[] {
  const out: string[] = []; let depth = 0, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++; else if (c === ')') depth--;
    else if (!depth) { sep.lastIndex = i; const m = sep.exec(s); if (m && m.index === i) { out.push(s.slice(last, i)); last = i + m[0].length; i = last - 1; } }
  }
  out.push(s.slice(last));
  return out.map(x => x.trim());
}

function length(v: string): number {
  const m = /^(-?[\d.]+)(px|em|rem)?$/.exec(v.trim());
  return m ? Number(m[1]) * (m[2] === 'em' || m[2] === 'rem' ? 16 : 1) : NaN;
}
function ratio(v: string): number { const [a, b = '1'] = v.split('/').map(x => Number(x.trim())); return Number(a) / Number(b); }
function resolution(v: string): number {
  const m = /^([\d.]+)(dppx|x|dpi|dpcm)?$/.exec(v.trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  return m[2] === 'dpi' ? n / 96 : m[2] === 'dpcm' ? n * 2.54 / 96 : n;
}

/** The value of a feature this runtime knows, as a number (with its parser) or a keyword; undefined when unknown. */
function feature(name: string, e: Env): {n: number; parse: (v: string) => number} | {k: string[]} | undefined {
  switch (name) {
    case 'width': return {n: e.width, parse: length};
    case 'height': return {n: e.height, parse: length};
    case 'device-width': return {n: e.screenW, parse: length};
    case 'device-height': return {n: e.screenH, parse: length};
    case 'aspect-ratio': return {n: e.height ? e.width / e.height : 0, parse: ratio};
    case 'device-aspect-ratio': return {n: e.screenH ? e.screenW / e.screenH : 0, parse: ratio};
    case 'resolution': return {n: e.dpr, parse: resolution};
    case '-webkit-device-pixel-ratio': return {n: e.dpr, parse: Number};
    case 'color': return {n: 8, parse: Number};
    case 'color-index': case 'monochrome': case 'grid': return {n: 0, parse: Number};
    case 'orientation': return {k: [e.height >= e.width ? 'portrait' : 'landscape']};
    case 'pointer': case 'any-pointer': return {k: ['fine']};
    case 'hover': case 'any-hover': return {k: ['hover']};
    case 'prefers-color-scheme': return {k: e.scheme ? [e.scheme] : []};
    case 'prefers-reduced-motion': case 'prefers-reduced-transparency': case 'prefers-reduced-data': case 'prefers-contrast': return {k: ['no-preference']};
    case 'forced-colors': case 'inverted-colors': return {k: ['none']};
    case 'color-gamut': return {k: ['srgb']};
    case 'dynamic-range': case 'video-dynamic-range': return {k: ['standard']};
    case 'display-mode': return {k: ['browser']};
    case 'scripting': return {k: ['enabled']};
    case 'update': return {k: ['fast']};
    case 'overflow-block': case 'overflow-inline': return {k: ['scroll']};
    default: return undefined;
  }
}

const OPS: Record<string, (a: number, b: number) => boolean> = {'<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b, '=': (a, b) => a === b};
const flip: Record<string, string> = {'<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '='};

/** One feature test inside parentheses: (name), (name: value), (min-name: value), or a range (name >= value). */
function test(inner: string, e: Env): boolean {
  const range = /^([^<>=]+?)\s*(<=|>=|<|>|=)\s*([^<>=]+?)(?:\s*(<=|>=|<|>|=)\s*([^<>=]+?))?$/.exec(inner);
  if (range && !inner.includes(':')) {
    const [, a, op1, b, op2, c] = range;
    const named = (x: string) => feature(x.trim(), e);
    if (c !== undefined) { const f = named(b); if (!f || !('n' in f)) return false; return OPS[op1](f.parse(a), f.n) && OPS[op2](f.n, f.parse(c)); }
    const fa = named(a), fb = named(b);
    if (fa && 'n' in fa) return OPS[op1](fa.n, fa.parse(b));
    if (fb && 'n' in fb) return OPS[flip[op1]](fb.n, fb.parse(a));
    return false;
  }
  const colon = inner.indexOf(':');
  const rawName = (colon < 0 ? inner : inner.slice(0, colon)).trim(), value = colon < 0 ? null : inner.slice(colon + 1).trim();
  const prefix = /^(min|max)-/.exec(rawName)?.[1] ?? (rawName.startsWith('-webkit-min-') ? 'min' : rawName.startsWith('-webkit-max-') ? 'max' : null);
  const name = rawName.replace(/^(min|max)-/, '').replace(/^-webkit-(min|max)-/, '-webkit-');
  const f = feature(name, e);
  if (!f) return false;
  if ('k' in f) return value === null ? f.k.length > 0 && f.k[0] !== 'none' && f.k[0] !== 'no-preference' : f.k.includes(value);
  if (value === null) return f.n !== 0;
  const v = f.parse(value);
  if (!Number.isFinite(v)) return false;
  return prefix === 'min' ? f.n >= v : prefix === 'max' ? f.n <= v : Math.abs(f.n - v) < 1e-9;
}

/** A media condition: not X, X and Y ..., X or Y ..., where each X is a parenthesized feature or condition. */
function condition(s: string, e: Env): boolean {
  s = s.trim();
  if (/^not\s/.test(s)) return !condition(s.slice(4), e);
  const ands = splitTop(s, /\s+and\s+/y);
  if (ands.length > 1) return ands.every(x => condition(x, e));
  const ors = splitTop(s, /\s+or\s+/y);
  if (ors.length > 1) return ors.some(x => condition(x, e));
  if (s.startsWith('(') && s.endsWith(')')) {
    const inner = s.slice(1, -1).trim();
    return /^(\(|not\s)/.test(inner) || / (and|or) \(/.test(inner) ? condition(inner, e) : test(inner, e);
  }
  return false;
}

/** One query of a comma-separated list: [not|only] [type] [and condition], or a bare condition. */
function query(q: string, e: Env): boolean {
  q = q.trim();
  if (!q) return true;
  if (q.startsWith('(') || /^not\s*\(/.test(q)) return condition(q, e);
  const m = /^(?:(not|only)\s+)?([a-z-]+)\s*(?:and\s+([\s\S]+))?$/.exec(q);
  if (!m) return false;
  const typeOk = m[2] === 'all' || m[2] === 'screen';
  const ok = typeOk && (m[3] === undefined || condition(m[3], e));
  return m[1] === 'not' ? !ok : ok;
}

/** Whether a media query list matches now. */
export function matchesMedia(media: string, e: Env = env()): boolean {
  const text = String(media).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return true;
  return splitTop(text, /,/y).some(q => query(q, e));
}

type Listener = ((e: unknown) => void) | {handleEvent(e: unknown): void};
const live = new Set<MediaQueryList>();
export class MediaQueryList {
  onchange: ((e: unknown) => void) | null = null;
  private listeners: Listener[] = [];
  last: boolean;
  constructor(readonly media: string) { this.last = this.matches; }
  get matches() { return matchesMedia(this.media); }
  addEventListener(type: string, fn: Listener | null) { if (type === 'change' && fn && !this.listeners.includes(fn)) { this.listeners.push(fn); this.last = this.matches; live.add(this); } }
  removeEventListener(type: string, fn: Listener | null) { if (type === 'change') this.listeners = this.listeners.filter(f => f !== fn); }
  addListener(fn: Listener | null) { this.addEventListener('change', fn); }
  removeListener(fn: Listener | null) { this.removeEventListener('change', fn); }
  dispatchEvent(event: {type: string}) {
    if (event.type !== 'change') return true;
    this.onchange?.(event);
    for (const fn of [...this.listeners]) typeof fn === 'function' ? fn(event) : fn.handleEvent(event);
    return true;
  }
}

/** After a resize, each listened-to query whose answer changed fires "change" with its new answer. */
export function recheckMedia() {
  for (const mq of [...live]) {
    if (!mq.onchange && !(mq as unknown as {listeners: unknown[]}).listeners.length) { live.delete(mq); continue; }
    const now = mq.matches;
    if (now === mq.last) continue;
    mq.last = now;
    const Ctor = g.MediaQueryListEvent ?? g.Event;
    const event = Object.assign(new Ctor('change'), {matches: now, media: mq.media});
    mq.dispatchEvent(event);
  }
}

let installed = false;
export function installMediaQueries() {
  if (installed) return;
  installed = true;
  const Base = (g.Event ?? domPage.Event) as new (type: string, init?: Record<string, unknown>) => object;
  g.MediaQueryListEvent ??= class MediaQueryListEvent extends Base {
    matches: boolean; media: string;
    constructor(type: string, init: {matches?: boolean; media?: string} = {}) { super(type, init); this.matches = !!init.matches; this.media = init.media ?? ''; }
  };
  g.MediaQueryList ??= MediaQueryList;
  // onchange set as a property counts as listening too.
  g.matchMedia = (media: unknown) => {
    const mq = new MediaQueryList(String(media ?? ''));
    let handler: ((e: unknown) => void) | null = null;
    Object.defineProperty(mq, 'onchange', {configurable: true, get: () => handler, set: v => { handler = typeof v === 'function' ? v : null; if (handler) { mq.last = mq.matches; live.add(mq); } }});
    return mq;
  };
  g.addEventListener?.('resize', recheckMedia);
}
installMediaQueries();
