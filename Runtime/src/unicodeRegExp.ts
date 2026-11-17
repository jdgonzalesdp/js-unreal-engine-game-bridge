/** Unicode property escapes (\p{L}, \P{Script=Greek}) in regular expressions built from strings at run time.
 *  Puerts' V8 is built without ICU, so new RegExp('\\p{L}', 'u') throws "Invalid property name". Regex literals are
 *  rewritten at build time (Tools/unicode-regex.mjs). For patterns made from strings, the build writes a table of the
 *  properties each bundle mentions at its top (Tools/unicode-props.mjs), and this module wraps the global RegExp so a
 *  u- or v-flag pattern gets each property's code points in its place. The wrapper is installed only when the engine
 *  can't look properties up itself, so a browser or Node keeps its own RegExp.
 *
 *  What stays as it was: instanceof RegExp, RegExp.prototype, RegExp() without new, subclasses and Symbol.species,
 *  RegExp.$1 and the other legacy statics, and the native fast paths for every regex (RegExp.prototype is untouched).
 *  A rewritten regex is a plain native one: its `source` shows the code points in place of \p{...}, so copies made
 *  any way (new RegExp(re.source, re.flags), new re.constructor(...), structuredClone, lodash cloneDeep) work, and
 *  it keeps V8's fast paths. One difference: `re.constructor` is still the engine's RegExp, so
 *  `re.constructor === RegExp` is false while the wrapper is installed.
 *  Not covered: a property name assembled at run time that the bundle never spells out (it is not in the table, so
 *  it throws as before, with a warning), and properties of strings. */

type Table = Record<string, [string, string]>;
type Ctor = RegExpConstructor & Record<PropertyKey, unknown>;

const g = globalThis as Record<string, any>;
const has = (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k);
const tableNow = (): Table => g.__jsgbUnicodeProps ?? {};

const refuse = (source: string, flags: string, why: string) =>
  new SyntaxError(`Invalid regular expression: /${source}/${flags}: ${why} (this engine has no ICU)`);
const SET_OPERATION = 'a property inside a v-flag set operation or nested class is not supported';

/** The pattern with every \p{...} and \P{...} replaced by the code points it stands for, for a u- or v-flag pattern.
 *  Outside a class a property becomes a class of its own; inside one its contents go in, and \P takes the table's
 *  complement, so [^\P{L}] stays right. null when a property is not in the table, or sits at one end of a range
 *  (the native constructor then throws its own SyntaxError for the original). Throws for v-flag set operations,
 *  nested classes and \q{...} next to a property, and for \P with both the i and v flags, which this does not do. */
export function rewriteUnicodeProperties(source: string, flags: string, table: Table = tableNow()): string | null {
  const v = flags.includes('v');
  if (v && flags.includes('i') && source.includes('\\P{')) throw refuse(source, flags, '\\P{...} with the i and v flags is not supported');
  let out = '', i = 0, inClass = false;
  // Inside a class, the last element, so a property never becomes one end of a range: 'atom' can start a range,
  // 'dash' is the '-' after one, 'set' is a class escape (\d, \p{L}) and 'end' closes a range or starts the class.
  let last: 'end' | 'atom' | 'dash' | 'set' = 'end';
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      const e = source[i + 1];
      if ((e === 'p' || e === 'P') && source[i + 2] === '{') {
        const close = source.indexOf('}', i + 3);
        const name = close < 0 ? '' : source.slice(i + 3, close);
        if (!name || !has(table, name)) return null;
        const body = table[name][e === 'P' ? 1 : 0];
        i = close + 1;
        if (!inClass) { out += '[' + body + ']'; continue; }
        if (v && source.startsWith('--', i)) throw refuse(source, flags, SET_OPERATION);
        if (last === 'dash' || (source[i] === '-' && source[i + 1] !== ']')) return null;
        out += body; last = 'set';
        continue;
      }
      if (v && inClass && e === 'q') throw refuse(source, flags, 'a property next to \\q{...} is not supported');
      const end = escapeEnd(source, i);
      out += source.slice(i, end); i = end;
      if (inClass) {
        const set = e !== undefined && 'dDsSwW'.includes(e);
        if (set && last === 'dash') return null;
        last = set ? 'set' : last === 'dash' ? 'end' : 'atom';
      }
      continue;
    }
    if (!inClass) {
      if (c === '[') {
        inClass = true; last = 'end';
        if (source[i + 1] === '^') { out += '[^'; i += 2; continue; }
      }
    } else if (c === ']') inClass = false;
    else if (v && (c === '[' || ((c === '&' || c === '-') && source[i + 1] === c))) {
      throw refuse(source, flags, SET_OPERATION);
    } else if (c === '-') {
      if (last === 'atom' && source[i + 1] !== ']') last = 'dash';
      else if (last === 'set' && source[i + 1] !== ']') return null;
      else last = last === 'dash' ? 'end' : 'atom';
    } else last = last === 'dash' ? 'end' : 'atom';
    // A literal ^ that an empty property (\P{Any}) left first in the class would negate it.
    if (inClass && c === '^' && out.endsWith('[')) { out += '\\^'; i++; continue; }
    // A surrogate pair written out is one atom.
    const n = c >= '\uD800' && c <= '\uDBFF' && source[i + 1] >= '\uDC00' && source[i + 1] <= '\uDFFF' ? 2 : 1;
    out += source.slice(i, i + n); i += n;
  }
  return out;
}

// Where the escape at i ends, so one escape is one class atom: \u{..}, \uHHHH (two for a surrogate pair), \xHH, \cX.
// Plain string tests, not a regex: running one here would overwrite RegExp.$1 and the other legacy statics.
const hex = (s: string, at: number, n: number) => {
  for (let k = at; k < at + n; k++) { const c = s[k]; if (!c || !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false; }
  return true;
};
function escapeEnd(s: string, i: number) {
  const e = s[i + 1], next = s[i + 2] ?? '';
  if (e === 'u' && next === '{') return s.indexOf('}', i) + 1 || s.length;
  if (e === 'u' && hex(s, i + 2, 4)) {
    const lead = parseInt(s.slice(i + 2, i + 6), 16), trail = s.startsWith('\\u', i + 6) && hex(s, i + 8, 4) ? parseInt(s.slice(i + 8, i + 12), 16) : 0;
    return lead >= 0xd800 && lead <= 0xdbff && trail >= 0xdc00 && trail <= 0xdfff ? i + 12 : i + 6;
  }
  if (e === 'x' && hex(s, i + 2, 2)) return i + 4;
  if (e === 'c' && ((next >= 'a' && next <= 'z') || (next >= 'A' && next <= 'Z'))) return i + 3;
  return i + 2;
}

let cache = new Map<string, string | null>();
const warned = new Set<string>();

/** Wraps globalThis.RegExp when the engine can't read \p{L} (or always, with force). Returns a function that puts
 *  the previous RegExp back, or null when nothing was installed. native: the constructor to wrap (tests pass one
 *  that behaves like an engine without ICU). */
export function installUnicodeRegExp(options: {force?: boolean; native?: RegExpConstructor} = {}): (() => void) | null {
  const Native = (options.native ?? g.RegExp) as Ctor;
  if (Native.__jsgbUnicode) return null;
  if (!options.force) {
    // ASCII, not L: the build puts every property this file spells out into the table, and ASCII's entry is tiny.
    try { new Native('\\p{ASCII}', 'u'); return null; } catch { /* no ICU: install */ }
  }
  const nativeSource = Object.getOwnPropertyDescriptor(Native.prototype, 'source')!.get!;
  // IsRegExp as the spec reads it: Symbol.match decides first (core-js tests RegExp(re) with it set to false).
  const isRegExp = (v: object) => {
    const m = (v as any)[Symbol.match];
    if ((m !== undefined && !m) || v === Native.prototype) return false;
    try { nativeSource.call(v); return true; } catch { return false; }
  };

  function rewrite(source: string, flags: string) {
    const key = flags + '/' + source;
    let hit = cache.get(key);
    if (hit === undefined) {
      hit = rewriteUnicodeProperties(source, flags);
      if (hit === null) warnMissing(source);
      if (cache.size >= 500) cache = new Map();
      cache.set(key, hit);
    }
    return hit;
  }

  const Wrapper = function RegExp(this: unknown, pattern?: unknown, flags?: unknown): RegExp {
    const target = new.target as Ctor | undefined;
    let source = pattern, f = flags;
    if (pattern !== null && typeof pattern === 'object' && isRegExp(pattern)) {
      const re = pattern as RegExp;
      // RegExp(re) without new hands re back, as the engine's own does.
      if (!target && flags === undefined && re.constructor === Native) return re;
      // A regex given new flags is read as its source (/\p{L}/ given 'u' becomes a property, as in an ICU engine).
      if (flags !== undefined) source = re.source;
    }
    if (typeof source === 'string' && typeof f === 'string' && (f.includes('u') || f.includes('v'))
      && (source.includes('\\p{') || source.includes('\\P{'))) {
      const rewritten = rewrite(source, f);
      if (rewritten !== null) {
        let re: RegExp;
        try { re = Reflect.construct(Native, [rewritten, f], !target || target === Wrapper ? Native : target); } catch (e) {
          // An error elsewhere in the pattern names the pattern as written, not the rewritten one.
          throw e instanceof SyntaxError ? new SyntaxError(e.message.split(rewritten).join(source)) : e;
        }
        // No own `source`: an own property takes the regex off V8's fast paths (split 30x, replace 4x slower) and
        // makes new re.constructor(re.source, re.flags) hand \p{...} to the engine RegExp, which throws.
        return re;
      }
    }
    return target ? Reflect.construct(Native, [source, f], target === Wrapper ? Native : target) : (Native as any)(source, f);
  } as unknown as Ctor;

  // The engine's prototype, and its statics forwarded, so RegExp.$1 and RegExp.lastMatch read the same match data.
  Object.defineProperty(Wrapper, 'prototype', {value: Native.prototype, writable: false});
  for (const key of Reflect.ownKeys(Native)) {
    if (key === 'prototype' || key === 'length' || key === 'name' || key === Symbol.species) continue;
    const d = Object.getOwnPropertyDescriptor(Native, key)!;
    Object.defineProperty(Wrapper, key, d.get || d.set ? {configurable: d.configurable, enumerable: d.enumerable,
      get: d.get && (() => Native[key]), set: d.set && ((value: unknown) => { Native[key] = value; })} : d);
  }
  Object.defineProperty(Wrapper, Symbol.species, {configurable: true, get() { return this; }});
  Object.defineProperty(Wrapper, '__jsgbUnicode', {value: true});
  // Bundlers may rename the function expression (RegExp2); the engine's name is what code and stack traces expect.
  Object.defineProperty(Wrapper, 'name', {value: 'RegExp', configurable: true});
  const before = Object.getOwnPropertyDescriptor(g, 'RegExp');
  Object.defineProperty(g, 'RegExp', {value: Wrapper, writable: true, configurable: true, enumerable: false});
  cache = new Map();
  return () => { if (before) Object.defineProperty(g, 'RegExp', before); };
}

// A property the bundle never spelled out is missing from the table; say so once, since the engine's own error
// ("Invalid property name") reads as if the name were wrong.
function warnMissing(source: string) {
  const table = tableNow();
  for (const m of source.matchAll(/\\[pP]\{([^}]*)\}/g)) {
    if (has(table, m[1]) || warned.has(m[1])) continue;
    warned.add(m[1]);
    g.console?.warn?.(`RegExp: \\p{${m[1]}} is not in the bundle's Unicode property table (Tools/unicode-props.mjs), so this engine without ICU can't read it`);
  }
}

/** How many rewritten patterns are cached (for tests). */
export const cachedRewrites = () => cache.size;

installUnicodeRegExp();
