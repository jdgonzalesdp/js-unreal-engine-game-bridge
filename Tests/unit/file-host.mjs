// A stand-in for the host's file service (__jsgbHost.files, Source/JsGameBridge/Private/JsgbFiles.cpp) over files kept
// in memory: the open panel answers with what a test chose, and the page reads bytes by id as it does from Unreal.
import {Buffer} from 'node:buffer';
import {stubHost} from './browser-page.mjs';

/** disk: {'Set/chair.glb': 'bytes' | Buffer}. choose(answer) sets what the next panel returns: a list of paths, or null
 *  for a closed panel. seen records each panel's options, each read and each folder listed. */
export function fileHost(disk = {}, {panel = true} = {}) {
  const files = new Map(Object.entries(disk).map(([k, v]) => [k, Buffer.from(v)]));
  const granted = new Map(), answers = new Map(), seen = {opens: [], reads: [], lists: []};
  let next = 1, nextRequest = 1, answer = null, dropped = '';
  const folders = path => [...new Set([...files.keys()].filter(k => k.startsWith(path + '/')).map(k => path + '/' + k.slice(path.length + 1).split('/')[0]))];
  const entry = (path, top, relative) => {
    const id = next++, dir = !files.has(path);
    granted.set(id, path);
    return {id, name: path.split('/').pop(), size: dir ? 0 : files.get(path).length, modified: 1700000000000 + path.length * 1000, top,
      ...(relative ? {path: relative} : {}), ...(dir ? {dir: true} : {})};
  };
  const describe = (paths, expand) => paths.flatMap((p, top) => files.has(p) || !expand ? [entry(p, top)]
    : [...files.keys()].filter(k => k.startsWith(p + '/')).sort().map(k => entry(k, top, p.split('/').pop() + k.slice(p.length))));
  const binding = {
    open(json) {
      const options = JSON.parse(json); seen.opens.push(options);
      const id = nextRequest++;
      // The first poll finds the panel still up, as the page's first look does in Unreal.
      answers.set(id, {polls: 0, json: answer === null ? '{"cancel":true}' : JSON.stringify({files: describe(answer, !!options.expand)})});
      return id;
    },
    take(id) { const a = answers.get(id); if (!a) return null; if (a.polls++ === 0) return null; answers.delete(id); return a.json; },
    read(id, at, n) {
      seen.reads.push([id, at, n]);
      const b = files.get(granted.get(id)); if (!b || at + n > b.length) return null;
      const s = b.subarray(at, at + n); return s.buffer.slice(s.byteOffset, s.byteOffset + s.length);
    },
    list(id) { const p = granted.get(id); seen.lists.push(p); return JSON.stringify(folders(p).sort().map(k => entry(k, 0))); },
    dropped() { const d = dropped || '[]'; dropped = ''; return d; },
  };
  const {host, seen: hostSeen} = stubHost();
  if (panel) host.files = binding;
  return {host, hostSeen, seen, choose(v) { answer = v; }, drop(paths) { dropped = JSON.stringify(describe(paths, false)); }};
}

/** Waits for the page's next poll of the panel (filePicker.ts looks every 50 ms). */
export const settle = (ms = 140) => new Promise(resolve => setTimeout(resolve, ms));
