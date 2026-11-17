// Glob patterns as Vite matches them (tinyglobby and picomatch): * and ? stay inside one path segment, ** spans
// segments, [...] is a character class, {a,b} and {1..3} are alternatives, a leading ! excludes, and wildcards never
// match a name that starts with a dot. Folders named node_modules are skipped unless asked for.
//   globFiles(['/abs/dir/*.json', '!/abs/dir/skip.json'], {exhaustive}) -> sorted absolute paths
import fs from 'node:fs';
import path from 'node:path';

const escapeRe = s => s.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
const posix = p => p.replaceAll('\\', '/');
const MAGIC = /(^|[^\\])[*?[{]/;

/** {a,b} and {1..3} alternatives, expanded into separate patterns. */
export function expandBraces(pattern) {
  for (let i = 0, depth = 0, open = -1; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') { if (depth++ === 0) open = i; continue; }
    if (c !== '}' || depth === 0 || --depth > 0) continue;
    const body = pattern.slice(open + 1, i), head = pattern.slice(0, open), tail = pattern.slice(i + 1);
    const range = /^(-?\d+)\.\.(-?\d+)$/.exec(body);
    let parts = [];
    if (range) { const a = +range[1], b = +range[2], step = a <= b ? 1 : -1; for (let v = a; v !== b + step; v += step) parts.push(String(v)); }
    else {
      for (let k = 0, d = 0, from = 0; k <= body.length; k++) {
        if (body[k] === '\\') { k++; continue; }
        if (body[k] === '{') d++;
        else if (body[k] === '}') d--;
        else if ((body[k] === ',' && d === 0) || k === body.length) { parts.push(body.slice(from, k)); from = k + 1; }
      }
      if (parts.length < 2) continue; // {x} alone is a literal
    }
    return parts.flatMap(p => expandBraces(head + p + tail));
  }
  return [pattern];
}

function segmentSource(seg, dot) {
  let re = dot || seg.startsWith('.') ? '' : '(?!\\.)';
  for (let i = 0; i < seg.length;) {
    const c = seg[i];
    if (c === '\\' && i + 1 < seg.length) { re += escapeRe(seg[i + 1]); i += 2; continue; }
    if (c === '*') { re += '[^/]*'; while (seg[i] === '*') i++; continue; }
    if (c === '?') { re += '[^/]'; i++; continue; }
    if (c === '[') {
      const close = seg.indexOf(']', i + 2);
      if (close > 0) {
        let body = seg.slice(i + 1, close);
        if (body[0] === '!' || body[0] === '^') body = '^' + body.slice(1);
        re += '[' + body + ']'; i = close + 1; continue;
      }
    }
    re += escapeRe(c); i++;
  }
  return re;
}

/** One absolute glob (no braces) as a RegExp over absolute forward-slash paths. */
export function globRegExp(glob, dot = false) {
  let re = '';
  posix(glob).split('/').forEach((seg, k) => {
    if (seg === '**') re += `(?:/${dot ? '[^/]+' : '(?!\\.)[^/]+'})*`;
    else re += (k === 0 ? '' : '/') + segmentSource(seg, dot);
  });
  return new RegExp('^' + re + '$');
}

// The folder a glob starts from: its segments before the first wildcard, with escapes removed.
function staticBase(glob) {
  const segs = posix(glob).split('/');
  const k = segs.findIndex(s => MAGIC.test(s));
  const base = (k < 0 ? segs.slice(0, -1) : segs.slice(0, k)).join('/').replace(/\\(.)/g, '$1');
  return {base: base || '/', depth: segs.includes('**') ? Infinity : segs.length - (k < 0 ? segs.length - 1 : k)};
}

/** The files the absolute globs match, sorted, the importer itself left out as Vite does. */
export function globFiles(globs, {dot = false, exhaustive = false, importer = null} = {}) {
  const positive = [], negative = [];
  for (const g of globs) for (const one of expandBraces(g.startsWith('!') ? g.slice(1) : g)) (g.startsWith('!') ? negative : positive).push(one);
  const allowDot = dot || exhaustive;
  const keep = positive.map(g => globRegExp(g, allowDot)), drop = negative.map(g => globRegExp(g, allowDot));
  const found = new Set();
  for (const g of positive) {
    const {base, depth} = staticBase(g);
    // A dot folder is entered only when the glob names one below its base (wildcards never match a leading dot).
    const dotFolders = allowDot || posix(g).slice(base.length).split('/').some(s => s.startsWith('.'));
    const walk = (dir, level) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
      for (const e of entries) {
        const full = posix(path.join(dir, e.name));
        let isDir = e.isDirectory(), isFile = e.isFile();
        if (e.isSymbolicLink()) { try { const s = fs.statSync(full); isDir = s.isDirectory(); isFile = s.isFile(); } catch { continue; } }
        if (isDir) {
          if (level + 1 >= depth || (!exhaustive && e.name === 'node_modules') || (!dotFolders && e.name.startsWith('.'))) continue;
          walk(full, level + 1);
        } else if (isFile && keep.some(r => r.test(full)) && !drop.some(r => r.test(full))) found.add(full);
      }
    };
    walk(base, 0);
  }
  if (importer) found.delete(posix(importer));
  return [...found].sort();
}

/** A folder's path with glob characters escaped, so it is matched as written. */
export const globSafe = dir => posix(dir).replace(/[*?[\]{}()!\\]/g, '\\$&');
