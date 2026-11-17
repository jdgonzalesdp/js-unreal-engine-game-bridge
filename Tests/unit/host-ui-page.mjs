// Boots the runtime's page with the system services (host-ui-fixture.ts) in Node, as web-gaps-page.mjs boots its page:
// Node's own web globals go first so the runtime installs its own, and every boot is a fresh copy of the runtime.
// systemHost is a browser-page.mjs stub with a Mac's dialogs, clipboard, look and time zone that a test drives.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Buffer} from 'node:buffer';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {stubHost} from './browser-page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const esbuild = await import(pathToFileURL(path.join(root, 'Runtime/node_modules/esbuild/lib/main.js')).href);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgb-host-ui-'));
process.on('exit', () => fs.rmSync(out, {recursive: true, force: true}));
const bundle = path.join(out, 'host-ui.mjs');
await esbuild.build({entryPoints: [path.join(root, 'Tests/unit/host-ui-fixture.ts')], outfile: bundle, bundle: true, format: 'esm',
  platform: 'node', logLevel: 'warning'});

const WEB = ['URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'structuredClone', 'Blob', 'fetch', 'Response', 'Headers', 'Request',
  'AbortController', 'AbortSignal', 'navigator', 'Navigator', 'atob', 'btoa', 'Event', 'EventTarget', 'CustomEvent', 'MessageEvent', 'DOMException',
  'crypto', 'localStorage', 'sessionStorage', 'Storage', 'location', 'history', 'document', 'open', 'origin', 'XMLHttpRequest', 'FormData', 'File',
  'ErrorEvent', 'CloseEvent', 'EventSource', 'WebSocket', 'BroadcastChannel', 'MessageChannel', 'MessagePort', 'PopStateEvent', 'XMLSerializer',
  'getSelection', 'Selection', 'Range', 'NodeFilter', 'matchMedia', 'MediaQueryList', 'MediaQueryListEvent', 'DragEvent', 'CompositionEvent',
  'ClipboardEvent', 'ClipboardItem', 'Clipboard', 'alert', 'confirm', 'prompt', 'HTMLElement', 'InputEvent', 'KeyboardEvent', 'MouseEvent'];

let boots = 0;
/** A fresh page on this host. */
export async function bootHostUi(host) {
  for (const k of WEB) try { delete globalThis[k]; } catch { /* not deletable */ }
  globalThis.__jsgbHost = host;
  return import(pathToFileURL(bundle).href + '?boot=' + ++boots);
}

/** A stub host with a Mac's system services. answers: what each dialog answers next ("1text" OK, "0" Cancel).
 *  clipboard: what is on the clipboard ({texts: {type: text}, png: Buffer | null}); writes records each write. */
export function systemHost({answers = [], scheme = 'dark', timeZone = 'Asia/Kolkata', withDialog = true} = {}) {
  const {host, seen} = stubHost({origin: 'http://localhost:5180'});
  const dialogs = [], writes = [];
  const state = {scheme, clipboard: {texts: {}, png: null}};
  host.platform = 'MacIntel';
  if (withDialog) host.dialog = (kind, message, value) => { dialogs.push({kind, message, value}); return answers.length ? answers.shift() : '0'; };
  host.clipboard = {
    types: () => JSON.stringify([...Object.keys(state.clipboard.texts), ...(state.clipboard.png ? ['image/png'] : [])]),
    text: type => state.clipboard.texts[type] ?? '',
    image: () => state.clipboard.png ? state.clipboard.png.buffer.slice(state.clipboard.png.byteOffset, state.clipboard.png.byteOffset + state.clipboard.png.length) : null,
    files: () => '[]',
    write(json, png) {
      const texts = JSON.parse(json), bytes = png && png.byteLength ? Buffer.from(png) : null;
      writes.push({texts, png: bytes});
      state.clipboard = {texts, png: bytes};
      return true;
    },
  };
  host.colorScheme = () => state.scheme;
  host.timeZone = timeZone;
  return {host, seen, dialogs, writes, state};
}
