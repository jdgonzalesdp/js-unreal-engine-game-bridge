/** The Cache API (caches.open, match, put, add, delete, keys), kept in the host's store like IndexedDB, so what a page
 *  caches is there the next time it starts: a page that keeps a downloaded model in a cache (PrepViz's eye landmark
 *  model, about 13 MB) fetched it again every session without one. Layout in the store (host.storage):
 *  - caches#names: the cache names in creation order.
 *  - caches#list.<name>: that cache's entries, [{url, id, status, statusText, headers, size, parts, sum}].
 *  - caches#body.<id>.<i>: an entry's body in base64 parts of 512 KB.
 *  A put writes the body parts first and the list last, so a list never names a body that isn't whole; a body whose
 *  parts don't match the list's checksum is treated as absent. Matching is by URL (without its fragment), GET only. */
import {base64Bytes, bytesBase64} from './base64';

const g = globalThis as Record<string, any>;
type Store = {load(key: string): string | null; save(key: string, data: string): void | boolean; remove?(key: string): void};
type Entry = {url: string; id: string; status: number; statusText: string; headers: [string, string][]; size: number; parts: number; sum: string};
type Options = {ignoreSearch?: boolean; ignoreMethod?: boolean; ignoreVary?: boolean; cacheName?: string};

const PART = 512 * 1024;
const turn = () => new Promise(resolve => g.setTimeout(resolve, 0));
const sumOf = (text: string, h = 0x811c9dc5) => { for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193); return h >>> 0; };
let ids = 0;

function urlOf(request: unknown): {url: string; method: string} {
  const req = request as {url?: string; method?: string} | string;
  const raw = typeof req === 'string' || req instanceof g.URL ? String(req) : String(req?.url ?? req);
  const url = new g.URL(raw, g.location?.href ?? 'http://localhost/');
  url.hash = '';
  return {url: url.href, method: typeof req === 'object' && req?.method ? String(req.method).toUpperCase() : 'GET'};
}
const sameUrl = (a: string, b: string, ignoreSearch?: boolean) => ignoreSearch ? a.split('?')[0] === b.split('?')[0] : a === b;

class Cache {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private store: Store, private name: string, private entries: Entry[]) {}

  async match(request: unknown, options: Options = {}) { return (await this.matchAll(request, options))[0]; }
  async matchAll(request?: unknown, options: Options = {}) {
    const found = request === undefined ? this.entries.slice() : this.find(request, options);
    const out: unknown[] = [];
    for (const e of found) { const r = await this.response(e); if (r) out.push(r); }
    return out;
  }
  async add(request: unknown) { return this.addAll([request]); }
  async addAll(requests: unknown[]) {
    const replies = await Promise.all(requests.map(async r => {
      const res = await g.fetch(r);
      if (!res.ok) throw new TypeError(`Cache.add: the request for ${urlOf(r).url} answered ${res.status}`);
      return [r, res] as const;
    }));
    for (const [r, res] of replies) await this.put(r, res);
  }
  put(request: unknown, response: Record<string, any>): Promise<void> {
    const {url, method} = urlOf(request);
    if (method !== 'GET') return Promise.reject(new TypeError('Cache.put: only GET requests can be cached.'));
    if (!response || response.status === 206) return Promise.reject(new TypeError('Cache.put: a partial or missing response cannot be cached.'));
    if (String(response.headers?.get?.('vary') ?? '').split(',').some((v: string) => v.trim() === '*')) return Promise.reject(new TypeError('Cache.put: Vary: * cannot be cached.'));
    return this.serial(async () => {
      const bytes = new Uint8Array(await response.arrayBuffer());
      const headers: [string, string][] = [];
      response.headers?.forEach?.((v: string, k: string) => headers.push([k, v]));
      const id = `${Date.now().toString(36)}-${(++ids).toString(36)}`, parts = Math.max(1, Math.ceil(bytes.length / PART));
      let sum = 0x811c9dc5;
      for (let i = 0; i < parts; i++) {
        if (i) await turn();
        const text = bytesBase64(bytes.subarray(i * PART, Math.min(bytes.length, (i + 1) * PART)));
        sum = sumOf(text, sum);
        this.store.save(`caches#body.${id}.${i}`, text);
      }
      const entry: Entry = {url, id, status: response.status, statusText: String(response.statusText ?? ''), headers, size: bytes.length, parts, sum: sum.toString(16)};
      const old = this.entries.filter(e => e.url === url);
      this.entries = [...this.entries.filter(e => e.url !== url), entry];
      this.saveList();
      for (const e of old) this.dropBody(e);
    });
  }
  delete(request: unknown, options: Options = {}): Promise<boolean> {
    return this.serial(async () => {
      const gone = this.find(request, options);
      if (!gone.length) return false;
      this.entries = this.entries.filter(e => !gone.includes(e));
      this.saveList();
      for (const e of gone) this.dropBody(e);
      return true;
    });
  }
  async keys(request?: unknown, options: Options = {}) {
    const found = request === undefined ? this.entries : this.find(request, options);
    return found.map(e => new g.Request(e.url));
  }

  /** @internal Removes every entry and the list (caches.delete). */
  _clear() { for (const e of this.entries) this.dropBody(e); this.entries = []; this.remove(`caches#list.${this.name}`); }

  private find(request: unknown, options: Options) {
    const {url, method} = urlOf(request);
    if (method !== 'GET' && !options.ignoreMethod) return [];
    return this.entries.filter(e => sameUrl(e.url, url, options.ignoreSearch));
  }
  private async response(e: Entry) {
    const bytes = new Uint8Array(e.size);
    let sum = 0x811c9dc5, at = 0;
    for (let i = 0; i < e.parts; i++) {
      if (i) await turn();
      const text = this.store.load(`caches#body.${e.id}.${i}`);
      if (text === null) return null;
      sum = sumOf(text, sum);
      const part = base64Bytes(text);
      if (at + part.length > bytes.length) return null;
      bytes.set(part, at); at += part.length;
    }
    if (at !== e.size || sum.toString(16) !== e.sum) return null;
    const type = e.headers.find(([k]) => k === 'content-type')?.[1] ?? '';
    return new g.Response(bytes, {status: e.status, statusText: e.statusText, headers: Object.fromEntries(e.headers)}, e.url, type);
  }
  private serial<T>(op: () => Promise<T>): Promise<T> { const run = this.queue.then(op, op); this.queue = run.catch(() => undefined); return run; }
  private saveList() { this.store.save(`caches#list.${this.name}`, JSON.stringify(this.entries)); }
  private dropBody(e: Entry) { for (let i = 0; i < e.parts; i++) this.remove(`caches#body.${e.id}.${i}`); }
  private remove(key: string) { if (this.store.remove) this.store.remove(key); else this.store.save(key, ''); }
}

class CacheStorage {
  private names: string[] | null = null;
  private open_ = new Map<string, Cache>();
  constructor(private store: Store) {}
  async open(name: string) {
    name = String(name);
    const names = this.list();
    let cache = this.open_.get(name);
    if (!cache) {
      let entries: Entry[] = [];
      try { entries = JSON.parse(this.store.load(`caches#list.${name}`) || '[]') as Entry[]; } catch { entries = []; }
      cache = new Cache(this.store, name, Array.isArray(entries) ? entries : []);
      this.open_.set(name, cache);
    }
    if (!names.includes(name)) { names.push(name); this.saveNames(); }
    return cache;
  }
  async has(name: string) { return this.list().includes(String(name)); }
  async delete(name: string) {
    name = String(name);
    const names = this.list();
    if (!names.includes(name)) return false;
    (await this.open(name))._clear();
    this.open_.delete(name);
    this.names = names.filter(n => n !== name); this.saveNames();
    return true;
  }
  async keys() { return this.list().slice(); }
  async match(request: unknown, options: Options = {}) {
    for (const name of options.cacheName !== undefined ? [String(options.cacheName)] : this.list().slice()) {
      if (!this.list().includes(name)) continue;
      const hit = await (await this.open(name)).match(request, options);
      if (hit) return hit;
    }
    return undefined;
  }
  private list() {
    if (!this.names) { try { this.names = JSON.parse(this.store.load('caches#names') || '[]') as string[]; } catch { this.names = []; } }
    if (!Array.isArray(this.names)) this.names = [];
    return this.names;
  }
  private saveNames() { this.store.save('caches#names', JSON.stringify(this.names ?? [])); }
}

/** Installs caches on the page, persisted through the host's store when it has one (otherwise for this session). */
export function installCacheStorage() {
  if (g.caches || !g.__jsgbHost) return;
  const host = g.__jsgbHost.storage as Store | undefined, memory = new Map<string, string>();
  const store: Store = host ?? {load: k => memory.get(k) ?? null, save: (k, v) => { memory.set(k, v); }, remove: k => { memory.delete(k); }};
  g.Cache = Cache; g.CacheStorage = CacheStorage;
  g.caches = new CacheStorage(store);
}
