/** document.cookie for the page, kept in the host's store so a cookie outlives a restart as it outlives a reload in a
 *  browser. A sign-in library marks "signed in" with a cookie (auth0-spa-js's auth0.<client>.is.authenticated) and
 *  checks it at the next start. linkedom has no cookie jar of its own.
 *
 *  The jar follows the parts of the cookie rules a page can see: name=value pairs, Expires and Max-Age (an expired
 *  cookie is removed), and reading back "a=1; b=2". Domain, Path, Secure and SameSite are accepted and ignored: the
 *  page has one origin and sends no cookies itself (fetch goes through the host). Cookies without an expiry are kept
 *  like the host's sessionStorage: until the store is cleared. */
import {host} from './host';

type Cookie = {value: string; expires: number | null};
const KEY = 'document.cookie';

function parseExpiry(attributes: string[], now: number): number | null {
  let expires: number | null = null;
  for (const attribute of attributes) {
    const at = attribute.indexOf('=');
    const name = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase(), value = at < 0 ? '' : attribute.slice(at + 1).trim();
    // Max-Age wins over Expires, whatever their order.
    if (name === 'max-age' && /^-?\d+$/.test(value)) return now + Number(value) * 1000;
    if (name === 'expires') { const t = Date.parse(value); if (Number.isFinite(t)) expires = t; }
  }
  return expires;
}

/** Installs document.cookie on doc, backed by the host store (or memory when the host has none). */
export function installCookies(doc: Record<string, any>) {
  const store = host.storage;
  let jar: Record<string, Cookie> = {};
  try { jar = JSON.parse(store?.load(KEY) || '{}') as Record<string, Cookie>; } catch { jar = {}; }
  const live = () => {
    const now = Date.now();
    for (const [name, c] of Object.entries(jar)) if (c.expires !== null && c.expires <= now) delete jar[name];
    return jar;
  };
  const save = () => { try { store?.save(KEY, JSON.stringify(jar)); } catch (e) { host.log('warn', 'cookie save: ' + e); } };
  Object.defineProperty(doc, 'cookie', {
    configurable: true,
    get: () => Object.entries(live()).map(([name, c]) => name ? `${name}=${c.value}` : c.value).join('; '),
    set: (text: unknown) => {
      const [pair, ...attributes] = String(text).split(';');
      const at = pair.indexOf('=');
      const name = at < 0 ? '' : pair.slice(0, at).trim(), value = (at < 0 ? pair : pair.slice(at + 1)).trim();
      const now = Date.now(), expires = parseExpiry(attributes, now);
      if (expires !== null && expires <= now) delete jar[name];
      else jar[name] = {value, expires};
      save();
    },
  });
}
