/** XMLHttpRequest over a fetch(), for the page (fetch.ts) and threaded workers (workerRuntime.ts). Loaders and fonts
 *  still use it (troika-three-text loads its font files with XHR, inside a worker). It is asynchronous only: a
 *  synchronous open() fails, as browsers now discourage it. */
type FetchFn = (url: string, init?: {method?: string; headers?: Record<string, string>; body?: unknown}) => Promise<{
  status: number; headers: {get(k: string): string | null; forEach(fn: (v: string, k: string) => void): void}; arrayBuffer(): Promise<ArrayBuffer>;
}>;
type Listener = (e: unknown) => void;

export function installXMLHttpRequest(g: Record<string, any>, fetchFn: FetchFn) {
  g.XMLHttpRequest = class XMLHttpRequest {
    static UNSENT = 0; static OPENED = 1; static HEADERS_RECEIVED = 2; static LOADING = 3; static DONE = 4;
    readyState = 0; status = 0; statusText = ''; response: unknown = null; responseText = ''; responseType = ''; responseURL = '';
    timeout = 0; withCredentials = false; upload = {addEventListener() {}, removeEventListener() {}};
    onload: Listener | null = null; onerror: Listener | null = null; onabort: Listener | null = null; onloadend: Listener | null = null;
    onreadystatechange: Listener | null = null; onprogress: Listener | null = null; ontimeout: Listener | null = null;
    private method = 'GET'; private url = ''; private headers: Record<string, string> = {}; private replyHeaders: Record<string, string> = {};
    private listeners: Record<string, Listener[]> = {}; private aborted = false;

    open(method: string, url: string, async = true) {
      if (async === false) throw new Error('XMLHttpRequest: synchronous requests are not supported here');
      this.method = String(method).toUpperCase(); this.url = String(url); this.headers = {}; this.aborted = false;
      this.setState(1);
    }
    setRequestHeader(name: string, value: string) { this.headers[name] = String(value); }
    overrideMimeType() {}
    getResponseHeader(name: string) { return this.replyHeaders[String(name).toLowerCase()] ?? null; }
    getAllResponseHeaders() { return Object.entries(this.replyHeaders).map(([k, v]) => `${k}: ${v}\r\n`).join(''); }
    addEventListener(type: string, fn: Listener) { (this.listeners[type] ??= []).push(fn); }
    removeEventListener(type: string, fn: Listener) { this.listeners[type] = (this.listeners[type] ?? []).filter(f => f !== fn); }
    abort() { this.aborted = true; this.emit('abort'); this.emit('loadend'); }

    send(body?: unknown) {
      fetchFn(this.url, {method: this.method, headers: this.headers, body: body ?? undefined}).then(async r => {
        if (this.aborted) return;
        this.status = r.status; this.statusText = r.status >= 200 && r.status < 300 ? 'OK' : String(r.status); this.responseURL = this.url;
        this.replyHeaders = {}; r.headers.forEach((v, k) => { this.replyHeaders[k.toLowerCase()] = v; });
        this.setState(2);
        const buf = await r.arrayBuffer();
        if (this.aborted) return;
        this.setState(3);
        const text = () => new g.TextDecoder().decode(buf);
        if (this.responseType === 'arraybuffer') this.response = buf;
        else if (this.responseType === 'blob') this.response = new g.Blob([buf], {type: this.replyHeaders['content-type'] ?? ''});
        else if (this.responseType === 'json') { try { this.response = JSON.parse(text()); } catch { this.response = null; } }
        else { this.responseText = text(); this.response = this.responseText; }
        this.setState(4);
        const progress = {lengthComputable: true, loaded: buf.byteLength, total: buf.byteLength, target: this};
        this.emit('progress', progress); this.emit('load', progress); this.emit('loadend', progress);
      }, error => {
        if (this.aborted) return;
        this.status = 0; this.setState(4);
        this.emit('error', {target: this, error}); this.emit('loadend', {target: this});
      });
    }

    private setState(state: number) { this.readyState = state; this.emit('readystatechange'); }
    private emit(type: string, event: Record<string, unknown> = {target: this}) {
      const e = {type, target: this, currentTarget: this, ...event};
      const own = (this as unknown as Record<string, Listener | null>)['on' + type];
      if (typeof own === 'function') own.call(this, e);
      for (const fn of this.listeners[type] ?? []) fn.call(this, e);
    }
  };
}
