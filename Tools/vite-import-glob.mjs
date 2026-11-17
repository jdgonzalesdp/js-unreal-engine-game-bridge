// import.meta.glob as Vite 6 expands it (vite/src/node/plugins/importMetaGlob.ts): patterns relative to the module
// ('./', '../') or to the project root ('/'), a list with '!' exclusions, and the options eager, import, query, as
// and exhaustive. Keys are what Vite writes: './x' or '../x' for relative patterns, '/x' otherwise. Eager entries
// become imports at the top of the module; lazy ones become () => import(...). Object.keys(...) and
// Object.values(...) around the call give only the keys or only the values, as in Vite.
//   expandImportGlobs(code, file, root, warn) -> code
import path from 'node:path';
import {maskLiterals, closingParen} from './js-mask.mjs';
import {globFiles, globSafe} from './vite-glob.mjs';

const posix = p => p.replaceAll('\\', '/');

// Vite's stringifyQuery: {url: true, lang: 'json'} -> 'url=true&lang=json'; an empty value is the key alone.
const stringifyQuery = q => Object.keys(q).filter(k => q[k] !== undefined)
  .map(k => { const v = typeof q[k] === 'number' || typeof q[k] === 'boolean' ? String(q[k]) : q[k]; return v ? `${encodeURIComponent(k)}=${encodeURIComponent(v)}` : encodeURIComponent(k); }).join('&');

/** Vite's option rules (parseGlobOptions): as: 'raw' | 'url' imports the default export, query gets its '?'. */
function globOptions(raw) {
  const opts = {...(raw ?? {})};
  if (opts.query && typeof opts.query === 'object') opts.query = stringifyQuery(opts.query);
  if (opts.as && ['raw', 'url'].includes(opts.as)) opts.import ||= 'default';
  if (opts.as) opts.query = opts.as;
  if (opts.query && opts.query[0] !== '?') opts.query = '?' + opts.query;
  return opts;
}

/** A glob as an absolute pattern (Vite's toAbsoluteGlob); null for a pattern this build can't place (an alias). */
function absoluteGlob(glob, root, dir) {
  const not = glob.startsWith('!') ? '!' : '', g = not ? glob.slice(1) : glob;
  if (g.startsWith('/')) return not + path.posix.join(globSafe(root), g.slice(1));
  if (g.startsWith('./') || g.startsWith('../')) return not + path.posix.join(globSafe(dir), g);
  return null;
}

// The end of a TypeScript type argument list (import.meta.glob<T>(...)) that starts at `at`, in masked code.
function skipTypeArguments(masked, at) {
  if (masked[at] !== '<') return at;
  for (let i = at, depth = 0; i < masked.length; i++) {
    if (masked[i] === '<') depth++;
    else if (masked[i] === '>' && masked[i - 1] !== '=' && --depth === 0) return i + 1;
  }
  return at;
}

export function expandImportGlobs(code, file, root, warn = console.warn) {
  if (!code.includes('import.meta.glob')) return code;
  const masked = maskLiterals(code);
  const dir = posix(path.dirname(file));
  const calls = [];
  for (const m of masked.matchAll(/\bimport\.meta\.glob\b/g)) {
    let at = m.index + m[0].length;
    while (/\s/.test(masked[at])) at++;
    at = skipTypeArguments(masked, at);
    while (/\s/.test(masked[at])) at++;
    if (masked[at] !== '(') continue;
    const close = closingParen(masked, at);
    if (close < 0) continue;
    const where = `import.meta.glob in ${path.basename(file)}`;
    let args;
    try { args = Function(`"use strict"; return [${code.slice(at + 1, close).replace(/\bas\s+const\b/g, '')}];`)(); }
    catch (e) { warn(`${where}: the arguments are not static (${e.message}); left as written`); continue; }
    const globs = Array.isArray(args[0]) ? args[0] : [args[0]];
    if (!globs.length || globs.some(g => typeof g !== 'string')) { warn(`${where}: patterns must be strings; left as written`); continue; }
    const resolved = globs.map(g => absoluteGlob(g, posix(root), dir));
    if (resolved.includes(null)) { warn(`${where}: '${globs[resolved.indexOf(null)]}' must start with '/', './' or '../'; left as written`); continue; }
    const before = masked.slice(0, m.index);
    calls.push({start: m.index, end: close + 1, globs, resolved, opts: globOptions(args[1]),
      onlyKeys: /\bObject\.keys\(\s*$/.test(before), onlyValues: /\bObject\.values\(\s*$/.test(before)});
  }
  if (!calls.length) return code;
  const hoisted = [];
  let out = '', from = 0;
  calls.forEach((call, index) => {
    const isRelative = call.globs.every(g => '.!'.includes(g[0]));
    const files = globFiles(call.resolved, {exhaustive: !!call.opts.exhaustive, importer: file});
    const query = call.opts.query ?? '';
    const importKey = call.opts.import && call.opts.import !== '*' ? call.opts.import : undefined;
    const props = files.map((f, i) => {
      let importPath = path.posix.relative(dir, f);
      if (importPath[0] !== '.') importPath = './' + importPath;
      let key = importPath;
      if (!isRelative) { key = path.posix.relative(posix(root), f); if (key[0] !== '.') key = '/' + key; }
      const spec = JSON.stringify(importPath + query);
      if (call.onlyKeys) return `${JSON.stringify(key)}: 0`;
      let value;
      if (call.opts.eager) {
        value = `__jsgbGlob_${index}_${i}`;
        hoisted.push(`import ${importKey ? `{ ${importKey} as ${value} }` : `* as ${value}`} from ${spec}`);
      } else value = `() => import(${spec})${importKey ? `.then(m => m[${JSON.stringify(importKey)}])` : ''}`;
      return call.onlyValues ? value : `${JSON.stringify(key)}: ${value}`;
    });
    // The call's line breaks stay, so later lines keep their numbers in error stacks.
    const breaks = '\n'.repeat((code.slice(call.start, call.end).match(/\n/g) ?? []).length);
    const body = call.onlyKeys ? `{${props.join(',')}${breaks}}` : call.onlyValues ? `[${props.join(',')}${breaks}]` : `/* #__PURE__ */ Object.assign({${props.join(',')}${breaks}})`;
    out += code.slice(from, call.start) + body;
    from = call.end;
  });
  out += code.slice(from);
  if (!hoisted.length) return out;
  // Imports go first, after a #! line if the module has one.
  const bang = out.startsWith('#!') ? out.indexOf('\n') + 1 : 0;
  return out.slice(0, bang) + hoisted.join(';') + ';' + out.slice(bang);
}
