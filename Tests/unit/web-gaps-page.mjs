// Boots the runtime's page with the webGaps.ts features (web-gaps-fixture.ts) in Node, as browser-page.mjs boots the
// plain page: Node's own web globals are removed first so the runtime installs its own, and every boot is a fresh
// copy of the runtime. keepIntl leaves Node's Intl in place; without it the runtime's own Intl (intl.ts) installs,
// as in Puerts, which has none.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {stubHost} from './browser-page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const esbuild = await import(pathToFileURL(path.join(root, 'Runtime/node_modules/esbuild/lib/main.js')).href);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgb-gaps-'));
process.on('exit', () => fs.rmSync(out, {recursive: true, force: true}));
const bundle = path.join(out, 'gaps.mjs');
await esbuild.build({entryPoints: [path.join(root, 'Tests/unit/web-gaps-fixture.ts')], outfile: bundle, bundle: true, format: 'esm',
  platform: 'node', logLevel: 'warning'});

const WEB = ['URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'structuredClone', 'Blob', 'fetch', 'Response', 'Headers', 'Request',
  'AbortController', 'AbortSignal', 'navigator', 'Navigator', 'atob', 'btoa', 'Event', 'EventTarget', 'CustomEvent', 'MessageEvent', 'DOMException',
  'crypto', 'localStorage', 'sessionStorage', 'Storage', 'location', 'history', 'document', 'open', 'origin', 'XMLHttpRequest', 'FormData', 'File',
  'ErrorEvent', 'CloseEvent', 'EventSource', 'WebSocket', 'BroadcastChannel', 'MessageChannel', 'MessagePort', 'PopStateEvent', 'XMLSerializer',
  'getSelection', 'Selection', 'Range', 'NodeFilter', 'matchMedia', 'MediaQueryList', 'MediaQueryListEvent', 'DragEvent', 'CompositionEvent'];

/** Node's own Intl, kept before a boot removes it, to check the runtime's answers against. */
export const NativeIntl = globalThis.Intl;
let boots = 0;
/** A fresh page; host is a browser-page.mjs stub (default: one with no network). */
export async function bootGaps({host = stubHost({origin: 'http://localhost:5180'}).host, keepIntl = false} = {}) {
  for (const k of WEB) try { delete globalThis[k]; } catch { /* not deletable */ }
  if (!keepIntl) delete globalThis.Intl;
  globalThis.__jsgbHost = host;
  return import(pathToFileURL(bundle).href + '?boot=' + ++boots);
}
