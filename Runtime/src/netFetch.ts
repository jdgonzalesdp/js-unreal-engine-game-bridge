/** fetch() to the network through the host: Unreal's HTTP module, or Node's https in the smoke test. The page's fetch
 *  (fetch.ts) and a threaded worker's (workerRuntime.ts) hand it every URL that isn't one of the game's own files, each
 *  with its own native calls. Without them it answers 503, as before, so callers take their offline path. The host
 *  decides which origins a game may reach. */
import {Headers, Response} from './fetchCore';
import {isReadableStream, readStream} from './responseBody';
import {pageStreamHost, streamFetch} from './fetchStream';

const g = globalThis as Record<string, any>;

/** start returns a request id, or 0 when the host refuses the URL; take returns the reply once it is in (see unpack). */
export type NetHost = {start(method: string, url: string, headersJson: string, body: ArrayBuffer | null): number; take(id: number): ArrayBuffer | null};
export type NetInit = {method?: string; headers?: unknown; body?: unknown; signal?: {aborted?: boolean; reason?: unknown; addEventListener?: (t: string, f: () => void) => void}};
type Pending = {resolve(r: Response): void; reject(e: unknown): void; url: string};

const headerRecord = (h: unknown) => { const out: Record<string, string> = {}; new Headers(h as Record<string, string>).forEach((v, k) => { out[k] = v; }); return out; };

async function bodyBytes(body: unknown): Promise<ArrayBuffer | null> {
  if (body == null) return null;
  if (typeof body === 'string') return (new g.TextEncoder().encode(body) as Uint8Array).buffer as ArrayBuffer;
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  if (g.URLSearchParams && body instanceof g.URLSearchParams) return bodyBytes(String(body));
  if (isReadableStream(body)) return (await readStream(body)).bytes;
  if (typeof (body as {arrayBuffer?: unknown}).arrayBuffer === 'function') return (body as {arrayBuffer(): Promise<ArrayBuffer>}).arrayBuffer();
  throw new TypeError('fetch: this kind of request body is not supported in Unreal');
}

/** A reply: [status int32 (0 for a network error), headers JSON byte length int32, headers JSON padded to 4, body]. */
function unpack(reply: ArrayBuffer, url: string): Response | null {
  const view = new DataView(reply);
  const status = view.getInt32(0, true), length = view.getInt32(4, true);
  if (status <= 0) return null;
  const headers = JSON.parse(new g.TextDecoder().decode(new Uint8Array(reply, 8, length)) || '{}') as Record<string, string>;
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return new Response(reply.slice(8 + ((length + 3) & ~3)), {status, headers: lower}, url, lower['content-type'] ?? '');
}

const abortError = (reason: unknown) => reason ?? new (g.DOMException ?? Error)('The operation was aborted.', 'AbortError');

/** A fetch for network URLs over `net()`, which is read on each call (null: no network here). */
export function createNetFetch(net: () => NetHost | null) {
  const pending = new Map<number, Pending>();
  let polling = false;
  const poll = () => {
    const host = net();
    for (const [id, p] of pending) {
      const reply = host?.take(id);
      if (!reply) continue;
      pending.delete(id);
      const response = unpack(reply, p.url);
      if (response) p.resolve(response); else p.reject(new TypeError('Failed to fetch'));
    }
    if (pending.size) g.setTimeout(poll, 0); else polling = false;
  };
  return async function netFetch(url: string, init: NetInit = {}): Promise<Response> {
    const host = net();
    if (!host) return new Response(null, 503, url);
    if (init.signal?.aborted) throw abortError(init.signal.reason);
    const method = String(init.method ?? 'GET').toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? null : await bodyBytes(init.body);
    // The page's host can stream replies (fetchStream.ts): the Response comes with the head, the body as it arrives.
    const streamer = pageStreamHost();
    if (streamer) return streamFetch(streamer, method, url, JSON.stringify(headerRecord(init.headers)), body, init.signal);
    const id = host.start(method, url, JSON.stringify(headerRecord(init.headers)), body);
    if (!id) throw new TypeError(`Failed to fetch: the host does not allow ${url}`);
    return new Promise<Response>((resolve, reject) => {
      pending.set(id, {resolve, reject, url});
      // The host finishes the request either way; an aborted caller just stops waiting for it.
      init.signal?.addEventListener?.('abort', () => { if (pending.delete(id)) reject(abortError(init.signal?.reason)); });
      if (!polling) { polling = true; g.setTimeout(poll, 0); }
    });
  };
}
