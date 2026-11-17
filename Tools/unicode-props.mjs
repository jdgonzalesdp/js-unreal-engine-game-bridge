// Unicode property tables for regular expressions built from strings at run time (new RegExp('\\p{L}', 'u')).
// Puerts' V8 is built without ICU, so it can't look a property up and throws "Invalid property name". Regex literals
// are rewritten at build time (Tools/unicode-regex.mjs); a pattern made from a string only exists once the game runs.
// After the build, this module scans each bundle for the property escapes it mentions (in strings, template strings
// and any literal left over), works out each one's code points with the data regexpu-core uses, and writes them at
// the top of the bundle as globalThis.__jsgbUnicodeProps. Runtime/src/unicodeRegExp.ts puts them in place of \p{...}.
//   node Tools/unicode-props.mjs L N Script=Greek     print the table for those properties and its size
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../Runtime');
let deps = null;
// The packages regexpu-core reads, resolved from its own folder so both agree on the Unicode version.
function load() {
  if (deps) return deps;
  const req = createRequire(createRequire(path.join(runtime, 'package.json')).resolve('regexpu-core'));
  deps = {property: req('unicode-match-property-ecmascript'), value: req('unicode-match-property-value-ecmascript'),
    set: file => req(`regenerate-unicode-properties/${file}.js`)};
  return deps;
}

/** The property escape bodies a text mentions after \p{ or \P{ (L, Script=Greek), and which signs each one has. */
export function scanPropertyEscapes(text) {
  const found = new Map();
  for (const m of text.matchAll(/\\([pP])\{([A-Za-z0-9_]+(?:=[A-Za-z0-9_]+)?)\}/g)) {
    if (!found.has(m[2])) found.set(m[2], new Set());
    found.get(m[2]).add(m[1]);
  }
  return found;
}

/** The code points of one property escape body as sorted [first, last] pairs, as the ECMAScript rules read it:
 *  a General_Category value or a binary property alone, or General_Category, Script or Script_Extensions = a value.
 *  'strings' for a property of strings (RGI_Emoji and friends need the v flag), null for an unknown name. */
export function propertyRanges(name) {
  const {property, value, set} = load();
  const [first, second, ...extra] = name.split('=');
  if (extra.length) return null;
  let data;
  try {
    if (second !== undefined) {
      const p = property(first);
      if (!['General_Category', 'Script', 'Script_Extensions'].includes(p)) return null;
      data = set(`${p}/${value(p, second)}`);
    } else {
      try { data = set(`General_Category/${value('General_Category', first)}`); } catch {
        try { set(`Property_of_Strings/${first}`); return 'strings'; } catch {}
        data = set(`Binary_Property/${property(first)}`);
      }
    }
  } catch { return null; }
  // regenerate keeps a set as [start, end + 1, start, end + 1, ...].
  const flat = data.characters.data, ranges = [];
  for (let i = 0; i < flat.length; i += 2) ranges.push([flat[i], flat[i + 1] - 1]);
  return ranges;
}

/** Every code point the ranges leave out. */
export function complementRanges(ranges) {
  const out = [];
  let next = 0;
  for (const [a, b] of ranges) { if (a > next) out.push([next, a - 1]); next = b + 1; }
  if (next <= 0x10ffff) out.push([next, 0x10ffff]);
  return out;
}

const hex = (n, width) => n.toString(16).toUpperCase().padStart(width, '0');
// One code point as JavaScript string source whose value is valid inside a class with the u or v flag. Letters and
// digits stay as they are; other ASCII becomes a regex escape (\x2D), since punctuation can be syntax there. Other
// characters are written with JavaScript escapes, so the value holds the character itself and the bundle stays ASCII.
// A surrogate code point stays a regex escape in braces, which the regex parser never joins with a neighbour.
function char(cp) {
  if (cp < 0x80) return /[0-9A-Za-z]/.test(String.fromCharCode(cp)) ? String.fromCharCode(cp) : '\\\\x' + hex(cp, 2);
  if (cp < 0x100) return '\\x' + hex(cp, 2);
  if (cp >= 0xd800 && cp <= 0xdfff) return '\\\\u{' + hex(cp, 4) + '}';
  return cp < 0x10000 ? '\\u' + hex(cp, 4) : '\\u{' + hex(cp, 5) + '}';
}

/** The inside of a character class for the ranges, as the source of a double-quoted JavaScript string. */
export function classContentsSource(ranges) {
  return ranges.map(([a, b]) => b === a ? char(a) : b === a + 1 ? char(a) + char(b) : char(a) + '-' + char(b)).join('');
}

/** The table source for the names: {"L": ["<inside of [\p{L}]>", "<inside of [\P{L}]>"], ...}, the names in it, and
 *  the names left out with why. */
export function propertyTableSource(names) {
  const entries = [], included = [], skipped = [];
  for (const name of [...names].sort()) {
    const ranges = propertyRanges(name);
    if (ranges === null) { skipped.push(`${name} (unknown)`); continue; }
    if (ranges === 'strings') { skipped.push(`${name} (property of strings, needs the v flag)`); continue; }
    entries.push(`${JSON.stringify(name)}:["${classContentsSource(ranges)}","${classContentsSource(complementRanges(ranges))}"]`);
    included.push(name);
  }
  return {source: `{${entries.join(',')}}`, included, skipped};
}

const MARK = 'globalThis.__jsgbUnicodeProps = Object.assign(globalThis.__jsgbUnicodeProps || {}, ';

/** Writes the table each built file needs at its top (after a "use strict" directive), and logs what went in. */
export function injectUnicodeProperties(files, log = console.log) {
  let total = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let code = fs.readFileSync(file, 'utf8');
    const strict = /^(['"])use strict\1;?\r?\n/.exec(code);
    const at = strict ? strict[0].length : 0;
    // A file that already has a table (written twice without a rebuild) gets a new one in its place.
    if (code.startsWith(MARK, at)) code = code.slice(0, at) + code.slice(code.indexOf('\n', at) + 1);
    const names = scanPropertyEscapes(code);
    if (!names.size) continue;
    const {source, included, skipped} = propertyTableSource(names.keys());
    const line = included.length ? `${MARK}${source});\n` : '';
    fs.writeFileSync(file, code.slice(0, at) + line + code.slice(at));
    total += line.length;
    log(`unicode properties in ${path.basename(file)}: ${included.join(', ') || 'none'} (${(line.length / 1024).toFixed(1)} KB)` +
      (skipped.length ? `; left out: ${skipped.join(', ')}` : ''));
  }
  return total;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {source, included, skipped} = propertyTableSource(process.argv.slice(2));
  console.log(source);
  console.error(`${included.join(', ')}: ${(source.length / 1024).toFixed(1)} KB${skipped.length ? '; left out: ' + skipped.join(', ') : ''}`);
}
