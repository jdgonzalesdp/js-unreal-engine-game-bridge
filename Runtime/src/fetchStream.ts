/** fetch() to the network as a browser does it, over the host's streamed requests (JsgbNetStream.cpp): the promise
 *  resolves once the status and headers are in, and the body is a byte stream that gets each piece as it arrives.
 *  The whole-reply requests (netFetch.ts) answer only when a request ends, so a server-sent event stream, which
 *  never ends, delivered nothing (PrepViz's live review updates), and a streamed reply (the assistant's) showed all at
 *  once. Aborting the request's signal, or cancelling its body, ends the request in the host.
 *  The host is polled every few milliseconds, and only while something waits: the head, or a reader wanting more. */
import {Response} from './fetchCore';
import {markChunk} from './responseBody';

const g = globalThis as Record<string, any>;

/** stream starts a request (0: the host refuses the URL); read returns what is new, or null: [flags int32 (1 head,
 *  2 done, 4 failed), status int32, headers JSON length int32, headers JSON padded to 4 (with the head only), body]. */
export type StreamHost = {stream(method: string, url: string, headersJson: string, body: ArrayBuffer | null): number; read(id: number): ArrayBuffer | null; cancel(id: number): void};
type Signal = {aborted?: boolean; reason?: unknown; addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void};
type Controller = {enqueue(chunk: Uint8Array): void; close(): void; error(e: unknown): void};

const HEAD = 1, DONE = 2, FAILED = 4;
const POLL_MS = 4;
/** Statuses whose responses have no body (and HEAD requests): the body is null, as in a browser. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** The page host's streamed requests, when it has them (jsgb-main.js); threaded workers use whole replies. */
export function pageStreamHost(): StreamHost | null {
  const h = g.__jsgbHost as Record<string, any> | undefined;
  return h && typeof h.httpStream === 'function' && typeof h.httpRead === 'function' && typeof h.httpCancel === 'function'
    ? {stream: (m, u, hj, b) => h.httpStream(m, u, hj, b), read: id => h.httpRead(id), cancel: id => h.httpCancel(id)} : null;
}

const abortError = (reason: unknown) => reason ?? new (g.DOMException ?? Error)('The operation was aborted.', 'AbortError');

function unpack(reply: ArrayBuffer) {
  const view = new DataView(reply);
  const flags = view.getInt32(0, true), status = view.getInt32(4, true), length = view.getInt32(8, true);
  const start = 12 + ((length + 3) & ~3);
  let headers: Record<string, string> = {};
  if (length > 0) try { headers = JSON.parse(new g.TextDecoder().decode(new Uint8Array(reply, 12, length))) as Record<string, string>; } catch { headers = {}; }
  return {flags, status, headers, body: new Uint8Array(reply, start, reply.byteLength - start)};
}

/** One request: resolves with the Response once the head is in. */
export function streamFetch(host: StreamHost, method: string, url: string, headersJson: string, body: ArrayBuffer | null, signal?: Signal): Promise<Response> {
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));
  const id = host.stream(method, url, headersJson, body);
  if (!id) return Promise.reject(new TypeError(`Failed to fetch: the host does not allow ${url}`));
  return new Promise<Response>((resolve, reject) => {
    let out: Controller | null = null, timer = 0, ended = false, headIn = false;
    let wake: (() => void) | null = null;
    const stop = () => { ended = true; if (timer) g.clearTimeout(timer); timer = 0; signal?.removeEventListener?.('abort', onAbort); wake?.(); wake = null; };
    const fail = (e: unknown) => { if (ended) return; stop(); if (headIn) { try { out?.error(e); } catch { /* already errored */ } } else reject(e); };
    const onAbort = () => { if (ended) return; host.cancel(id); fail(abortError(signal?.reason)); };
    const schedule = () => { if (!ended && !timer && (!headIn || wake)) timer = g.setTimeout(poll, POLL_MS); };
    const stream = new g.ReadableStream({
      type: 'bytes',
      start(c: Controller) { out = c; },
      // A reader wants more: poll until something new comes.
      pull: () => ended ? undefined : new Promise<void>(r => { wake = r; schedule(); }),
      cancel: () => { if (!ended) { stop(); host.cancel(id); } },
    });
    function poll() {
      timer = 0;
      if (ended) return;
      const reply = host.read(id);
      if (!reply || !reply.byteLength) { schedule(); return; }
      const r = unpack(reply);
      if (r.flags & HEAD && !headIn) {
        if (r.flags & FAILED || r.status <= 0) { fail(new TypeError('Failed to fetch')); return; }
        headIn = true;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(r.headers)) headers[k.toLowerCase()] = String(v);
        const empty = method === 'HEAD' || NULL_BODY.has(r.status);
        resolve(new Response(empty ? null : stream, {status: r.status, headers}, url, headers['content-type'] ?? ''));
        if (empty) { stop(); host.cancel(id); return; }
      }
      if (r.body.byteLength) { const chunk = r.body.slice(); markChunk(chunk, url); out?.enqueue(chunk); }
      if (r.flags & DONE) {
        if (r.flags & FAILED) { fail(new TypeError('network error')); return; }
        stop(); try { out?.close(); } catch { /* cancelled */ }
        return;
      }
      if (r.body.byteLength && wake) { const w = wake; wake = null; w(); }
      schedule();
    }
    signal?.addEventListener?.('abort', onAbort);
    schedule();
  });
}
