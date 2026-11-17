import {host} from './host';
import {resolveAssetPath} from './dom';
import {isPageUrl, pageHref} from './location';
import {blobStore} from './polyfills';
import {Headers, Response, Request, MIME, bufferOrigin} from './fetchCore';
import {createNetFetch, type NetInit} from './netFetch';
import {installXMLHttpRequest} from './xhr';

/** Network URLs go through the host's HTTP binding (Unreal: JsgbNet.cpp; smoke test: Tools/smoke-net.mjs). */
const netFetch = createNetFetch(() => host.httpStart && host.httpTake
  ? {start: (m, u, h, b) => host.httpStart!(m, u, h, b), take: id => host.httpTake!(id)} : null);

export {bufferOrigin};

/** fetch() for the Unreal target: game assets come from the web build's public folder on disk. Network requests go
 *  through the host (netFetch.ts); a host that has no network, or refuses the origin, makes them fail as offline. */
const g = globalThis as Record<string, any>;

async function unrealFetch(input: string | {url: string; method?: string; headers?: unknown; body?: unknown; signal?: unknown}, init?: NetInit): Promise<Response> {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);
  if (typeof input === 'object' && input) init = {method: input.method, headers: input.headers, body: input.body, signal: input.signal as NetInit['signal'], ...init};
  if (url.startsWith('blob:')) { const b = blobStore.get(url) as {bytes: Uint8Array; type?: string} | undefined; return new Response(b ? b.bytes.slice().buffer : null, b ? 200 : 404, url, b?.type); }
  if (url.startsWith('data:')) { const comma = url.indexOf(','); const meta = url.slice(5, comma); const body = url.slice(comma + 1);
    const text = meta.endsWith(';base64') ? g.atob(body) : decodeURIComponent(body); const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i); return new Response(out.buffer, 200, url, meta.split(';')[0]); }
  // The page's own origin (and localhost) are the game's files; anything else goes to the network.
  const parsed = new g.URL(url, pageHref());
  if (!isPageUrl(parsed)) return netFetch(parsed.href, init);
  if (init?.method && init.method.toUpperCase() !== 'GET') return new Response(null, 503, url);
  const path = resolveAssetPath(url);
  const bytes = host.readFile(path);
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return new Response(bytes, bytes ? 200 : 404, url, MIME[ext] ?? '');
}

g.fetch = unrealFetch; g.Response = Response; g.Headers = Headers;
g.Request ??= Request;

// XMLHttpRequest for loaders that still use it (three's FileLoader uses fetch): xhr.ts, over this fetch.
if (!g.XMLHttpRequest) installXMLHttpRequest(g, unrealFetch as never);
