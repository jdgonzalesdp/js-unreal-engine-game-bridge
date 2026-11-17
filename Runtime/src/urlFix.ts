/** What a browser's URL parser does that the runtime's own URL (polyfills.ts, used where V8 has none) did not:
 *  - userinfo: in https://user:pw@example.com:8080/ the host is example.com:8080 and user and pw are the username and
 *    password. The runtime's parser took "user" as the hostname and "pw@example.com" as the port.
 *  - an IPv6 host keeps its brackets and its port ([::1]:8080), a default port is dropped (http on 80, https on 443),
 *    and the scheme and host are lower case.
 *  - URL.canParse(url, base) and URL.parse(url, base), which libraries test for and call.
 *  The fix is a subclass, so the runtime's own parser, its blob URLs and the live search parameters (urlLive.ts) stay.
 *  An engine with a native URL keeps it and only gains canParse and parse when it lacks them. */
const g = globalThis as Record<string, any>;
type U = Record<string, any>;

const DEFAULT_PORT: Record<string, string> = {'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21'};
const opaque = (u: U) => /^(data|blob|javascript|mailto|about):$/i.test(String(u.protocol));

/** Splits a host field the base parser filled ("user:pw@Example.com:8080", "[::1]:80") into its parts. */
function settle(u: U) {
  if (opaque(u)) return;
  u.protocol = String(u.protocol).toLowerCase();
  let host = String(u.host ?? '');
  const at = host.lastIndexOf('@');
  if (at >= 0) {
    const info = host.slice(0, at), colon = info.indexOf(':');
    u.username = colon < 0 ? info : info.slice(0, colon);
    u.password = colon < 0 ? '' : info.slice(colon + 1);
    host = host.slice(at + 1);
  }
  let hostname = host, port = '';
  const ipv6 = /^(\[[^\]]*\])(?::(\d*))?$/.exec(host);
  if (ipv6) { hostname = ipv6[1]; port = ipv6[2] ?? ''; }
  else { const colon = host.lastIndexOf(':'); if (colon >= 0) { hostname = host.slice(0, colon); port = host.slice(colon + 1); } }
  if (port && !/^\d+$/.test(port)) throw new TypeError(`Invalid URL: ${u.protocol}//${host}`);
  if (port) port = String(Number(port));
  if (port === DEFAULT_PORT[u.protocol]) port = '';
  hostname = hostname.toLowerCase();
  u.hostname = hostname; u.port = port; u.host = port ? `${hostname}:${port}` : hostname;
}

const userinfo = (u: U) => u.username ? `${u.username}${u.password ? ':' + u.password : ''}@` : (u.password ? `:${u.password}@` : '');

export function installUrlFix() {
  const Base = g.URL as (new (url: string, base?: unknown) => U) & Record<string, any>;
  if (typeof Base !== 'function') return;
  const native = /\[native code\]/.test(Function.prototype.toString.call(Base));
  if (!native && !Base.__jsgbUserinfo) {
    const hrefOf = Object.getOwnPropertyDescriptor(Base.prototype, 'href')?.get;
    const originOf = Object.getOwnPropertyDescriptor(Base.prototype, 'origin')?.get;
    class URL extends Base {
      static __jsgbUserinfo = true;
      constructor(url: string | U, base?: string | U) { super(url as string, base); settle(this); }
      get origin(): string { return opaque(this) ? originOf!.call(this) : `${this.protocol}//${this.host}`; }
      get href(): string { return opaque(this) ? hrefOf!.call(this) : `${this.protocol}//${userinfo(this)}${this.host}${this.pathname}${this.search}${this.hash}`; }
      set href(value: string) { const next = new URL(String(value)); for (const k of ['protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'username', 'password']) this[k] = next[k]; }
      toString() { return this.href; }
      toJSON() { return this.href; }
    }
    g.URL = URL;
  }
  const Current = g.URL as (new (url: string, base?: unknown) => U) & Record<string, any>;
  if (typeof Current.canParse !== 'function') Current.canParse = (url: unknown, base?: unknown) => { try { new Current(String(url), base === undefined ? undefined : String(base)); return true; } catch { return false; } };
  if (typeof Current.parse !== 'function') Current.parse = (url: unknown, base?: unknown) => { try { return new Current(String(url), base === undefined ? undefined : String(base)); } catch { return null; } };
}
