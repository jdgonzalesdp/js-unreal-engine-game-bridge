/** Two things a browser's URL does that the runtime's own URL (polyfills.ts, used where V8 has none) did not:
 *  - url.searchParams is tied to the URL, so url.searchParams.delete('app') changes url.search and url.href. Apps
 *    clean their address that way before history.replaceState(null, '', url).
 *  - url.href can be set, which reads the whole URL again.
 *  A host with a native URL keeps it as it is. */
const g = globalThis as Record<string, any>;

const FIELDS = ['protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'username', 'password'];

/** Search parameters that write every change back to url.search. */
function tiedParams(url: Record<string, any>) {
  const params = new g.URLSearchParams(url.search);
  for (const name of ['append', 'delete', 'set', 'sort']) {
    const base = params[name];
    if (typeof base !== 'function') continue;
    params[name] = (...args: unknown[]) => {
      const out = base.apply(params, args);
      const text = String(params);
      url.search = text ? '?' + text : '';
      tied.set(url, {search: url.search, params});
      return out;
    };
  }
  return params;
}
const tied = new WeakMap<object, {search: string; params: unknown}>();

export function tieSearchParams(URLClass: (new (url: string) => Record<string, any>) | undefined) {
  if (typeof URLClass !== 'function' || /\[native code\]/.test(Function.prototype.toString.call(URLClass))) return;
  const proto = URLClass.prototype as Record<string, any>;
  Object.defineProperty(proto, 'searchParams', {configurable: true, get(this: Record<string, any>) {
    const known = tied.get(this);
    if (known && known.search === this.search) return known.params;
    const params = tiedParams(this);
    tied.set(this, {search: this.search, params});
    return params;
  }});
  const href = Object.getOwnPropertyDescriptor(proto, 'href');
  if (href?.get && !href.set) {
    Object.defineProperty(proto, 'href', {configurable: true, get: href.get, set(this: Record<string, any>, value: string) {
      const next = new URLClass(String(value));
      for (const field of FIELDS) this[field] = next[field];
    }});
  }
}

tieSearchParams(g.URL);
