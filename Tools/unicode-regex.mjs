// Rewrites Unicode property escapes in regular expression literals (/\p{Script=Hangul}/u) into the code point ranges
// they stand for. Puerts' V8 is built without ICU, so it can't look up a property and throws "Invalid property name"
// when such a regex first runs. The rewrite happens at build time, so code that travels as text (worker modules that
// troika-three-text sends to its workers as function source) carries the ranges too.
// Only literals are rewritten here. A pattern built from a string at run time (new RegExp('\\p{L}', 'u')) is rewritten
// when it is made, from a table the build writes into the bundle (Tools/unicode-props.mjs, Runtime/src/unicodeRegExp.ts).
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../Runtime');
let rewritePattern = null;
const rewriter = () => (rewritePattern ??= createRequire(path.join(runtime, 'package.json'))('regexpu-core'));

/** A regular expression literal starting at `start`: [whole, body, flags], or null. */
const LITERAL = /\/((?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+)\/([dgimsuyv]*)/y;

function literalAround(code, at) {
  // The nearest '/' before the escape that opens a literal reaching past it, and which Node's V8 (with ICU) accepts.
  // lastIndexOf clamps a negative start to 0, so the walk stops by itself only once it has looked at offset 0.
  for (let start = code.lastIndexOf('/', at); start >= 0 && at - start < 4000; start = start > 0 ? code.lastIndexOf('/', start - 1) : -1) {
    LITERAL.lastIndex = start;
    const m = LITERAL.exec(code);
    if (!m || start + m[0].length <= at || !/[uv]/.test(m[2])) continue;
    try { new RegExp(m[1], m[2]); } catch { continue; }
    return {start, end: start + m[0].length, body: m[1], flags: m[2]};
  }
  return null;
}

/** Returns the code with every Unicode property escape in a literal replaced by ranges, and how many literals changed. */
export function rewriteUnicodePropertyRegexes(code) {
  if (!code.includes('\\p{') && !code.includes('\\P{')) return {code, count: 0};
  let out = '', from = 0, count = 0;
  const escape = /\\[pP]\{/g;
  for (let m = escape.exec(code); m; m = escape.exec(code)) {
    if (m.index < from) continue;
    const lit = literalAround(code, m.index);
    if (!lit || lit.start < from) continue;
    const body = rewriter()(lit.body, lit.flags, {unicodePropertyEscapes: 'transform'});
    out += code.slice(from, lit.start) + '/' + body + '/' + lit.flags;
    from = lit.end; escape.lastIndex = lit.end; count++;
  }
  return {code: out + code.slice(from), count};
}

const loaders = {'.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx'};

/** esbuild: rewrite dependencies' literals. A game's own files go through the main onLoad, which calls the function. */
export function unicodeRegexPlugin(b, fs) {
  b.onLoad({filter: /[\\/]node_modules[\\/].*\.(m?[jt]sx?|cjs)$/}, async a => {
    if (a.namespace !== 'file') return undefined;
    const source = await fs.promises.readFile(a.path, 'utf8');
    const {code, count} = rewriteUnicodePropertyRegexes(source);
    return count ? {contents: code, loader: loaders[path.extname(a.path)] ?? 'js', resolveDir: path.dirname(a.path)} : undefined;
  });
}
