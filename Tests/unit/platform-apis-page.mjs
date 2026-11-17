// Boots the runtime's page with the platform features (platform-apis-fixture.ts) in Node. Node's own web globals,
// the streams among them, are removed first so the runtime installs its own, as in Puerts, which has none; every boot
// is a fresh copy of the runtime.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {stubHost} from './browser-page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const esbuild = await import(pathToFileURL(path.join(root, 'Runtime/node_modules/esbuild/lib/main.js')).href);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgb-platform-'));
process.on('exit', () => fs.rmSync(out, {recursive: true, force: true}));
const bundle = path.join(out, 'platform.mjs');
await esbuild.build({entryPoints: [path.join(root, 'Tests/unit/platform-apis-fixture.ts')], outfile: bundle, bundle: true, format: 'esm',
  platform: 'node', nodePaths: [path.join(root, 'Runtime/node_modules')], logLevel: 'warning'});

const WEB = ['URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'structuredClone', 'Blob', 'fetch', 'Response', 'Headers', 'Request',
  'AbortController', 'AbortSignal', 'navigator', 'Navigator', 'atob', 'btoa', 'Event', 'EventTarget', 'CustomEvent', 'MessageEvent', 'DOMException',
  'crypto', 'localStorage', 'sessionStorage', 'Storage', 'location', 'history', 'document', 'open', 'origin', 'XMLHttpRequest', 'FormData', 'File',
  'ErrorEvent', 'CloseEvent', 'EventSource', 'WebSocket', 'BroadcastChannel', 'MessageChannel', 'MessagePort', 'PopStateEvent',
  'ReadableStream', 'ReadableStreamDefaultReader', 'ReadableStreamBYOBReader', 'ReadableStreamDefaultController', 'ReadableByteStreamController',
  'WritableStream', 'WritableStreamDefaultWriter', 'TransformStream', 'CountQueuingStrategy', 'ByteLengthQueuingStrategy',
  'TextDecoderStream', 'TextEncoderStream', 'CompressionStream', 'DecompressionStream', 'caches', 'CacheStorage', 'Cache', 'FontFace',
  'IntersectionObserver'];

/** Node's own classes, kept before a boot removes them, to check the runtime's answers against. */
export const Native = {TextDecoder: globalThis.TextDecoder, URL: globalThis.URL, DecompressionStream: globalThis.DecompressionStream, CompressionStream: globalThis.CompressionStream};
let boots = 0;
/** A fresh page; host is a browser-page.mjs stub unless one is given. */
export async function bootPlatform({host = stubHost({origin: 'http://localhost:5180'}).host} = {}) {
  for (const k of WEB) try { delete globalThis[k]; } catch { /* not deletable */ }
  globalThis.__jsgbHost = host;
  return import(pathToFileURL(bundle).href + '?boot=' + ++boots);
}
