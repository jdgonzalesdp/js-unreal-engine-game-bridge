/** The page's address: location, history, window.open and the links a player clicks.
 *
 *  A web app reads its route from location.pathname and location.search, moves between routes with
 *  history.pushState, and sends the page to another site with location.assign (a sign-in library does this to reach
 *  its sign-in server). In Unreal the page has one address under the game's origin (host.origin, from the game's
 *  "origin" setting; http://localhost when it has none) that the host keeps across restarts:
 *  - pushState and replaceState change the address in place and tell the host, so a restart comes back to it;
 *  - setting location to another path or query on the same origin restarts the page there, the way a browser loads
 *    the new address;
 *  - an http or https address on another origin opens in the system browser, and the page stays as it is;
 *  - changing only the hash stays on the page.
 *  The host brings a sign-in back by restarting the page at the callback address (navigateTo). */
import {host} from './host';
import {leaveThen} from './leave';

const g = globalThis as Record<string, any>;
type Address = {path: string; search: string; hash: string};
type Entry = Address & {state: unknown};

/** "scheme://host[:port]" from the host's origin setting, with the scheme's default port left out as a browser does. */
function readOrigin() {
  const m = /^(https?:)\/\/([^/?#:@\s]+)(?::(\d+))?\/?$/i.exec(String(host.origin ?? '').trim());
  const protocol = m ? m[1].toLowerCase() : 'http:', hostname = m ? m[2].toLowerCase() : 'localhost';
  const port = m?.[3] && m[3] !== (protocol === 'https:' ? '443' : '80') ? m[3] : '';
  const where = hostname + (port ? ':' + port : '');
  return {protocol, hostname, port, host: where, origin: protocol + '//' + where};
}
const origin = readOrigin();

const clean = (search: string) => search === '?' ? '' : search;
let here: Address = {path: String(host.path || '/').startsWith('/') ? String(host.path || '/') : '/' + host.path, search: clean(String(host.search ?? '')), hash: ''};
const href = () => origin.origin + here.path + here.search + here.hash;

/** A URL resolved against the page, or null when it doesn't parse. Another scheme ("mailto:") keeps only its protocol,
 *  and "//host/x" takes the page's scheme: the runtime's own URL would read either as a relative path. */
function resolve(url: unknown): Record<string, any> | null {
  const raw = String(url).trim(), text = raw.startsWith('//') ? origin.protocol + raw : raw;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1];
  if (scheme && !/^https?$/i.test(scheme)) return {protocol: scheme.toLowerCase() + ':', href: text, hostname: '', port: '', pathname: '', search: '', hash: ''};
  try { return new g.URL(text, href()); } catch { return null; }
}
const defaultPort = (protocol: string) => protocol === 'https:' ? '443' : protocol === 'http:' ? '80' : '';
function sameOrigin(u: Record<string, any>) {
  const protocol = String(u.protocol).toLowerCase();
  return protocol === origin.protocol && String(u.hostname).toLowerCase() === origin.hostname
    && (u.port && u.port !== defaultPort(protocol) ? String(u.port) : '') === origin.port;
}
/** True for a URL on the page's own origin, or on localhost as before origins were configurable: fetch reads these
 *  from the game's files. */
export function isPageUrl(u: Record<string, any>) { return sameOrigin(u) || String(u.hostname).toLowerCase() === 'localhost'; }
export const pageHref = href;

let flushStorage = () => {};

/** Restarts the page at a path and query on its own origin. The page hears it is leaving first and gets a moment to
 *  keep its work (leave.ts), then storage is saved, because the host drops pending timers. */
let leaving = false, restarting = false;
function restartAt(pathAndQuery: string) {
  host.setAddress?.(pathAndQuery);
  // Until the host tears the page down, a pushState must not move the address the restart lands on.
  leaving = true;
  // A restart already waiting for the page lands on the newest address.
  if (restarting) return;
  restarting = true;
  leaveThen(() => { restarting = false; flushStorage(); host.reload(); });
}

/** The host brings the page to an address (a sign-in callback, "/auth/callback?code=...&state=..."): a restart there. */
export function navigateTo(address: string) {
  const u = resolve(address);
  if (!u || !sameOrigin(u)) { host.log('warn', `navigate: ${address} is not on ${origin.origin}`); return false; }
  restartAt((u.pathname || '/') + clean(u.search ?? ''));
  return true;
}

/** Opens an http or https URL in the system browser. Storage is saved first: a sign-in library keeps its pending
 *  sign-in in sessionStorage, and the browser may come back before the next save. */
export function openExternal(url: string): boolean {
  flushStorage();
  if (!host.openExternal) { host.log('warn', `this host cannot open ${url} in the system browser`); return false; }
  return !!host.openExternal(url);
}

function fire(type: string, init: Record<string, unknown>) {
  g.setTimeout(() => {
    const Ctor = type === 'popstate' ? g.PopStateEvent : g.Event;
    g.dispatchEvent?.(Object.assign(new Ctor(type, init), type === 'hashchange' ? init : {}));
  }, 0);
}

const entries: Entry[] = [{...here, state: null}];
let index = 0;
function show(next: Address) {
  const moved = next.path !== here.path || next.search !== here.search;
  here = {path: next.path, search: next.search, hash: next.hash};
  if (moved && !leaving) host.setAddress?.(here.path + here.search);
}

function setHash(value: string) {
  const v = String(value);
  const next = v === '' || v === '#' ? '' : v.startsWith('#') ? v : '#' + v;
  if (next === here.hash) return;
  const oldURL = href();
  entries.splice(index + 1);
  entries.push({...here, hash: next, state: null}); index++;
  show(entries[index]);
  fire('hashchange', {oldURL, newURL: href()});
}

/** The path on the page's origin a sign-out URL sends the browser back to (returnTo), or null. A browser would have
 *  left the page for the sign-out and come back there, so the page goes there now. */
function returnPath(u: Record<string, any>): string | null {
  const params = new g.URLSearchParams(u.search ?? '');
  for (const key of ['returnTo', 'post_logout_redirect_uri']) {
    const back = params.get(key), r = back ? resolve(back) : null;
    if (r && /^https?:$/i.test(String(r.protocol)) && sameOrigin(r)) return (r.pathname || '/') + clean(r.search ?? '');
  }
  return null;
}

/** Where location.href, assign and replace send the page. */
function go(url: unknown) {
  const u = resolve(url);
  if (!u) { host.log('warn', `navigation to ${String(url)}: not a URL`); return; }
  if (u.protocol === 'javascript:') return;
  if (!/^https?:$/i.test(String(u.protocol))) { host.log('warn', `navigation to ${u.protocol} links is not supported in Unreal`); return; }
  if (!sameOrigin(u)) { const back = returnPath(u); if (openExternal(u.href) && back) restartAt(back); return; }
  const path = u.pathname || '/', search = clean(u.search ?? '');
  if (path === here.path && search === here.search && u.hash) { setHash(u.hash); return; }
  restartAt(path + search);
}

/** pushState and replaceState: the address in place, on the page's own origin only. */
function entryFor(state: unknown, url: unknown): Entry {
  if (url === undefined || url === null) return {...here, state};
  const u = resolve(url);
  if (!u || !sameOrigin(u)) throw new (g.DOMException ?? Error)(`history: ${String(url)} is not on ${origin.origin}`, 'SecurityError');
  return {path: u.pathname || '/', search: clean(u.search ?? ''), hash: u.hash ?? '', state};
}

const location = {
  get href() { return href(); }, set href(v: string) { go(v); },
  get origin() { return origin.origin; }, get protocol() { return origin.protocol; },
  get host() { return origin.host; }, get hostname() { return origin.hostname; }, get port() { return origin.port; },
  get pathname() { return here.path; }, set pathname(v: string) { const p = String(v); restartAt((p.startsWith('/') ? p : '/' + p) + here.search); },
  get search() { return here.search; }, set search(v: string) { const s = String(v); restartAt(here.path + clean(s && !s.startsWith('?') ? '?' + s : s)); },
  get hash() { return here.hash; }, set hash(v: string) { setHash(v); },
  ancestorOrigins: {length: 0, item: () => null, contains: () => false},
  assign: (url: string) => go(url), replace: (url: string) => go(url), reload: () => restartAt(here.path + here.search),
  toString: () => href(),
};

const history = {
  get length() { return entries.length; },
  get state() { return entries[index].state; },
  scrollRestoration: 'auto',
  pushState(state: unknown, _title?: string, url?: string) { const e = entryFor(state, url); entries.splice(index + 1); entries.push(e); index++; show(e); },
  replaceState(state: unknown, _title?: string, url?: string) { const e = entryFor(state, url); entries[index] = e; show(e); },
  back() { history.go(-1); }, forward() { history.go(1); },
  go(delta = 0) {
    if (!delta) { location.reload(); return; }
    const next = index + Math.trunc(delta);
    if (next < 0 || next >= entries.length) return;
    const from = entries[index], oldURL = href();
    index = next;
    const to = entries[index];
    show(to);
    fire('popstate', {state: to.state});
    if (from.hash !== to.hash && from.path === to.path && from.search === to.search) fire('hashchange', {oldURL, newURL: href()});
  },
};

/** A window opened in the system browser, as far as a page can see it from here. */
const outside = (url: string) => ({closed: false, opener: null, location: {href: url}, close() { this.closed = true; }, focus() {}, blur() {}, postMessage() {}});

function open(url?: unknown, target?: unknown): unknown {
  if (url === undefined || url === null || url === '') return null;
  const u = resolve(url);
  if (!u) return null;
  if (/^_(self|top|parent)$/i.test(String(target ?? ''))) { go(u.href); return g; }
  if (/^https?:$/i.test(String(u.protocol)) && !sameOrigin(u)) return openExternal(u.href) ? outside(u.href) : null;
  host.log('warn', `window.open(${u.href}): a second page of the game cannot open in Unreal`);
  return null;
}

let downloadLink: ((link: Record<string, any>) => void) | null = null;
/** What a click on a download link does (download.ts writes its file into Downloads). */
export function onDownloadLink(fn: (link: Record<string, any>) => void) { downloadLink = fn; }

/** A click the page didn't cancel on a link: the link's default action, as a browser follows it. */
export function followLink(target: Record<string, any> | null, modifiers: {ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean} = {}) {
  const link = target?.closest?.('a[href],area[href]');
  if (!link) return;
  // A browser downloads a download link; it doesn't navigate.
  if (link.hasAttribute?.('download')) { downloadLink?.(link); return; }
  const where = String(link.getAttribute('target') ?? '').toLowerCase();
  const href = link.getAttribute('href');
  if (modifiers.ctrlKey || modifiers.metaKey || modifiers.shiftKey || (where && !/^_(self|top|parent)$/.test(where))) open(href, '_blank');
  else go(href);
}

/** Installs location, history, window.open and the document's address. flush saves pending storage writes. */
export function installLocation(doc: Record<string, any>, flush: () => void) {
  flushStorage = flush;
  // window.location = url navigates, as in a browser.
  Object.defineProperty(g, 'location', {get: () => location, set: go, configurable: true, enumerable: true});
  g.history = history;
  g.open = open;
  g.origin = origin.origin;
  for (const name of ['baseURI', 'URL', 'documentURI']) {
    try { Object.defineProperty(doc, name, {get: href, configurable: true}); } catch { /* a read-only linkedom getter */ }
  }
  try { Object.defineProperty(doc, 'domain', {get: () => origin.hostname, configurable: true}); } catch { /* ignore */ }
  try { Object.defineProperty(doc, 'referrer', {get: () => '', configurable: true}); } catch { /* ignore */ }
}
