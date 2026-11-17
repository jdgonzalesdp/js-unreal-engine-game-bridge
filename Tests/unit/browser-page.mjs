// Boots the runtime's page (browser-page-fixture.ts) in Node the way the Unreal host starts it. Node's own web globals
// are removed first, so the runtime installs its own (URL, crypto.subtle, navigator.locks ...), and every boot is a
// fresh copy of the runtime, as every restart is a fresh JavaScript environment. The host is a stub a test inspects:
// what it stores lives in a Map that outlives the boots, as the Unreal host's store outlives restarts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Buffer} from 'node:buffer';
import {randomBytes} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const esbuild = await import(pathToFileURL(path.join(root, 'Runtime/node_modules/esbuild/lib/main.js')).href);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgb-page-'));
process.on('exit', () => fs.rmSync(out, {recursive: true, force: true}));
const bundle = path.join(out, 'page.mjs');
await esbuild.build({entryPoints: [path.join(root, 'Tests/unit/browser-page-fixture.ts')], outfile: bundle, bundle: true, format: 'esm',
  platform: 'node', logLevel: 'warning'});

// Web globals Node has and Puerts' V8 doesn't, and the ones an earlier boot of the page installed.
const WEB = ['URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'structuredClone', 'Blob', 'fetch', 'Response', 'Headers', 'Request',
  'AbortController', 'AbortSignal', 'navigator', 'Navigator', 'atob', 'btoa', 'Event', 'EventTarget', 'CustomEvent', 'MessageEvent', 'DOMException',
  'crypto', 'localStorage', 'sessionStorage', 'Storage', 'location', 'history', 'document', 'open', 'origin', 'XMLHttpRequest', 'FormData', 'File',
  'ErrorEvent', 'CloseEvent', 'EventSource', 'WebSocket', 'BroadcastChannel', 'MessageChannel', 'MessagePort', 'PopStateEvent'];

let boots = 0;
/** A fresh page with this host: the runtime's exports (browser-page-fixture.ts). */
export async function bootPage(host) {
  for (const k of WEB) try { delete globalThis[k]; } catch { /* not deletable */ }
  globalThis.__jsgbHost = host;
  return import(pathToFileURL(bundle).href + '?boot=' + ++boots);
}

/** The reply netFetch.ts reads: [status, headers JSON length, headers JSON padded to 4, body]. */
function pack(status, headers, body) {
  const json = Buffer.from(JSON.stringify(headers), 'utf8'), bytes = Buffer.from(body ?? '', 'utf8');
  const all = Buffer.alloc(8 + ((json.length + 3) & ~3) + bytes.length);
  all.writeInt32LE(status, 0); all.writeInt32LE(json.length, 4); json.copy(all, 8); bytes.copy(all, 8 + ((json.length + 3) & ~3));
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}

/** A stub of the Unreal host. start: {origin, path, search} as the host gives them; http(request) answers network
 *  requests with {status, headers, body}. seen records restarts, addresses, browser opens, requests and log lines. */
export function stubHost({origin, path: start = '/', search = '', store = new Map(), http} = {}) {
  const seen = {reloads: 0, addresses: [], opened: [], requests: [], logs: []};
  const replies = new Map();
  let next = 1;
  const host = {
    origin, path: start, search, registry: '', now: () => performance.now(), readFile: () => null,
    log: (level, text) => { seen.logs.push(`${level} ${text}`); },
    reload: () => { seen.reloads++; },
    setAddress: address => { seen.addresses.push(address); },
    openExternal: url => { seen.opened.push(url); return true; },
    randomBytes: n => { const b = randomBytes(n); return b.buffer.slice(b.byteOffset, b.byteOffset + n); },
    storage: {load: k => store.has(k) ? store.get(k) : null, save: (k, v) => { store.set(k, v); }},
    httpStart(method, url, headersJson, body) {
      const request = {method, url, headers: JSON.parse(headersJson), body: body ? Buffer.from(body).toString('utf8') : null};
      seen.requests.push(request);
      const r = http ? http(request) : {status: 0};
      const id = next++;
      replies.set(id, pack(r.status, r.headers ?? {'content-type': 'application/json'}, typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})));
      return id;
    },
    httpTake(id) { const r = replies.get(id); replies.delete(id); return r ?? null; },
  };
  return {host, seen, store};
}

/** Where the host restarts the page after it set an address: its path and its query (JsgbAddress.cpp). */
export function restartAddress(address) {
  const at = address.indexOf('?');
  return at < 0 ? {path: address, search: ''} : {path: address.slice(0, at), search: address.slice(at)};
}

export const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
/** A restart waits for what the page's leave handlers start (Runtime/src/leave.ts): until the host has been asked to
 *  reload n times, or 2 s. */
export async function restarted(seen, n) { for (let i = 0; i < 400 && seen.reloads < n; i++) await tick(5); }
