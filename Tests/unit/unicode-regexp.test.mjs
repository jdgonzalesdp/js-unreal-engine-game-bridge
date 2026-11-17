// Unicode property escapes in patterns built from strings at run time (Runtime/src/unicodeRegExp.ts), with the table
// the build writes into a bundle (Tools/unicode-props.mjs). Node has ICU, so the wrapper is forced on: over Node's
// own RegExp (its results must match Node's), and over a stand-in that rejects \p{...} as Puerts' V8 does.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {installUnicodeRegExp, rewriteUnicodeProperties, cachedRewrites} from '../../Runtime/src/unicodeRegExp.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The build module runs from its own folder (not bundled into the test), so it finds the Runtime packages.
const props = await import(pathToFileURL(path.join(root, 'Tools/unicode-props.mjs')).href);
const NativeRegExp = RegExp;
const nativeSource = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get;
globalThis.__jsgbUnicodeProps = (0, eval)(`(${props.propertyTableSource(['L', 'N', 'Lu', 'Script=Greek', 'sc=Han',
  'Extended_Pictographic', 'Emoji_Component', 'Regional_Indicator', 'Any']).source})`);

const PREPVIZ = '(?<![\\p{L}\\p{N}_])(?:XP|Leaderboard)s?(?![\\p{L}\\p{N}_])';
const ZOD_EMOJI = '^(?=[\\s\\S]*[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u20E3])[\\p{Extended_Pictographic}\\p{Emoji_Component}]+$';

// Puerts' V8 without ICU: any \p{...} in a u- or v-flag pattern is a SyntaxError.
function NoIcuRegExp(pattern, flags) {
  const isRe = pattern instanceof NativeRegExp;
  const source = isRe ? pattern.source : String(pattern ?? ''), f = flags === undefined ? (isRe ? pattern.flags : '') : String(flags);
  if (/[uv]/.test(f) && /\\[pP]\{/.test(source)) throw new SyntaxError(`Invalid regular expression: /${source}/${f}: Invalid property name`);
  return new.target ? Reflect.construct(NativeRegExp, [pattern, flags], new.target === NoIcuRegExp ? NativeRegExp : new.target) : NativeRegExp(pattern, flags);
}
NoIcuRegExp.prototype = NativeRegExp.prototype;

/** fn(the wrapped RegExp), forced on over Node's RegExp unless options say otherwise; RegExp is put back after. */
function withWrapper(fn, options = {force: true}) {
  const restore = installUnicodeRegExp(options);
  assert.ok(restore, 'the wrapper installs');
  try { return fn(globalThis.RegExp); } finally { restore(); assert.equal(globalThis.RegExp, NativeRegExp); }
}
const noIcu = {native: NoIcuRegExp};

test('the wrapper installs only where \\p{L} fails, and Node keeps its own RegExp', () => {
  assert.equal(globalThis.RegExp, NativeRegExp);
  assert.equal(installUnicodeRegExp(), null);
  withWrapper(R => assert.notEqual(R, NativeRegExp), noIcu);
});

test('the PrepViz challenge pattern builds without ICU and matches whole words only', () => withWrapper(R => {
  assert.throws(() => new NoIcuRegExp(PREPVIZ, 'u'), /Invalid property name/);
  assert.deepEqual('XP and Leaderboards, not myXP or XPs1'.match(new R(PREPVIZ, 'gu')), ['XP', 'Leaderboards']);
  for (const flags of ['u', 'iu']) {
    const re = new R(PREPVIZ, flags);
    for (const s of ['XP', 'Leaderboards', 'Leaderboard', 'Top XP!', '(XPs)']) assert.ok(re.test(s), `${s} /${flags}`);
    for (const s of ['myXP', 'XPs1', 'αXP', 'XP_', 'Leaderboardz', '中XP']) assert.ok(!re.test(s), `${s} /${flags}`);
    assert.ok(!/\\[pP]\{/.test(nativeSource.call(re)), 'no property escape reaches the engine');
  }
  assert.ok(new R(PREPVIZ, 'iu').test('xp'));
  assert.ok(new R(ZOD_EMOJI, 'u').test('😀🇺🇸'));
  assert.ok(!new R(ZOD_EMOJI, 'u').test('a'));
}, noIcu));

test('Greek and CJK letters, astral ones included', () => withWrapper(R => {
  const letters = new R('^\\p{L}+$', 'u');
  for (const s of ['αβγ', 'Ωμέγα', '中文字', 'かな', 'abc', '𠀀']) assert.ok(letters.test(s), s);
  for (const s of ['123', 'a b', '😀', '_']) assert.ok(!letters.test(s), s);
  assert.ok(new R('^\\p{Script=Greek}+$', 'u').test('αβγΩ'));
  assert.ok(!new R('^\\p{Script=Greek}+$', 'u').test('abc'));
  assert.ok(new R('^\\p{sc=Han}+$', 'u').test('中文𠀀'));
  assert.ok(!new R('^\\p{sc=Han}+$', 'u').test('かな'));
  assert.deepEqual('x=1, y=٣, z=四'.match(new R('\\p{N}', 'gu')), ['1', '٣']);
}, noIcu));

test('\\P outside and inside classes, negated classes too', () => withWrapper(R => {
  assert.ok(new R('^\\P{L}+$', 'u').test('123 !😀'));
  assert.ok(!new R('^\\P{L}+$', 'u').test('1a'));
  assert.ok(new R('^[\\P{L}a]+$', 'u').test('1a!'));
  assert.ok(!new R('^[\\P{L}a]+$', 'u').test('b'));
  assert.ok(new R('^[^\\P{L}]+$', 'u').test('αβ中'));
  assert.ok(!new R('^[^\\P{L}]+$', 'u').test('1'));
  assert.ok(new R('^[^\\p{N}]+$', 'u').test('abc'));
}, noIcu));

test('a class mixing properties with ranges and dashes', () => withWrapper(R => {
  const mixed = new R('^[\\p{Script=Greek}0-9_-]+$', 'u');
  assert.ok(mixed.test('αβ_12-'));
  assert.ok(!mixed.test('αb'));
  assert.ok(new R('^[a-f\\p{N}]+$', 'u').test('ab12'));
  assert.ok(!new R('^[a-f\\p{N}]+$', 'u').test('g'));
  assert.ok(new R('^[-\\p{N}]+$', 'u').test('-1'));
  assert.ok(new R('^[\\p{N}-]+$', 'u').test('1-'));
  assert.ok(new R('^[a-z-\\p{N}]+$', 'u').test('q-7'));
  // A property can't be one end of a range: still a SyntaxError.
  for (const p of ['[a-\\p{L}]', '[\\p{L}-z]', '[\\d-\\p{L}]', '[\\p{L}-\\p{N}]']) assert.throws(() => new R(p, 'u'), SyntaxError, p);
}, noIcu));

test('with Node\'s RegExp underneath, every result matches Node\'s own (i flag and case folding too)', () => {
  const patterns = [['^\\p{L}+$', 'u'], ['^\\P{L}$', 'u'], ['^[\\P{L}a]$', 'u'], ['^[^\\P{L}]$', 'u'], ['^[^\\p{L}]$', 'u'],
    ['^\\P{Lu}$', 'iu'], ['^\\p{Lu}$', 'iu'], ['^[^\\p{Lu}]$', 'iu'], ['^[^\\P{Lu}]$', 'iu'], ['^[\\p{Lu}\\p{N}_-]$', 'iu'],
    ['^\\p{Script=Greek}$', 'iu'], ['^\\p{sc=Han}$', 'u'], [PREPVIZ, 'iu'], [ZOD_EMOJI, 'u'], ['^[\\p{L}--[a-z]]$', 'u']];
  const samples = ['A', 'a', 'z', '1', '_', '-', ' ', 'Σ', 'σ', 'ς', 'ß', 'ẞ', 'K', 'ſ', 'ǅ', '中', '𠀀', '😀', '🇺', '\uD800', 'αβ', 'XP', 'myXP', 'Leaderboards'];
  withWrapper(R => {
    for (const [p, f] of patterns) {
      let ours, theirs;
      try { theirs = new NativeRegExp(p, f); } catch (e) { assert.throws(() => new R(p, f), {name: 'SyntaxError', message: e.message}); continue; }
      ours = new R(p, f);
      for (const s of samples) assert.equal(ours.test(s), theirs.test(s), `/${p}/${f} on ${JSON.stringify(s)}`);
    }
  });
});

test('an unknown property throws the same SyntaxError as before', () => {
  const message = f => { try { new f('\\p{NotAProperty}', 'u'); } catch (e) { return e.message; } };
  const warn = console.warn, warnings = [];
  console.warn = text => warnings.push(text);
  try {
    withWrapper(R => assert.throws(() => new R('\\p{NotAProperty}', 'u'), {name: 'SyntaxError', message: message(NativeRegExp)}));
    withWrapper(R => {
      assert.throws(() => new R('\\p{NotAProperty}', 'u'), {name: 'SyntaxError', message: message(NoIcuRegExp)});
      // A real property the bundle never mentions is not in the table: the same error, and a warning naming it.
      assert.throws(() => new R('\\p{Script=Latin}', 'u'), {name: 'SyntaxError', message: /Invalid property name/});
    }, noIcu);
  } finally { console.warn = warn; }
  assert.ok(warnings.some(w => w.includes('Script=Latin')));
});

test('literal regexes are left as they are', () => withWrapper(R => {
  const lit = /\p{L}+/u;
  assert.equal(lit.source, '\\p{L}+');
  assert.ok(!Object.hasOwn(lit, 'source'));
  assert.ok(lit instanceof R);
  assert.equal(Object.getPrototypeOf(lit), R.prototype);
  assert.equal(R(lit), lit);
  assert.equal(/a\d/g.constructor, NativeRegExp);
  assert.equal(new R(/a\d/g).source, 'a\\d');
}));

test('RegExp keeps its contract: prototype, calls, subclasses, species, statics, flags, lastIndex, source', () => withWrapper(R => {
  assert.equal(R.prototype, NativeRegExp.prototype);
  assert.equal(R.name, 'RegExp');
  assert.equal(R.length, 2);
  assert.equal(R[Symbol.species], R);
  const called = R('\\p{N}+', 'u');
  assert.ok(called instanceof R && called.test('٣٤'));
  class Words extends R { first(s) { return this.exec(s)?.[0]; } }
  const words = new Words('\\p{L}+', 'u');
  assert.ok(words instanceof Words && words instanceof R);
  assert.equal(words.first('12 αβγ'), 'αβγ');
  assert.equal(Words[Symbol.species], Words);

  const re = new R('(\\p{L}+)(\\p{N})', 'giu');
  assert.equal(re.flags, 'giu');
  // No own source: the regex keeps V8's fast paths, and its source is what the engine compiled.
  assert.ok(!Object.hasOwn(re, 'source'));
  assert.ok(!/\\[pP]\{/.test(re.source));
  assert.equal(re.exec('ab1 γδ2')[0], 'ab1');
  assert.equal(re.lastIndex, 3);
  assert.equal(R.$1, 'ab');
  assert.equal(R.$2, '1');
  assert.equal(R.lastMatch, 'ab1');
  new R('a/[\\x41\\p{L}]', 'u');
  assert.equal(R.$1, 'ab', 'building a \\p regex leaves the legacy statics alone');
  assert.equal(re.exec('ab1 γδ2')[0], 'γδ2');
  assert.equal(re.lastIndex, 7);
  re.lastIndex = 0;

  assert.deepEqual('a1b2c'.split(new R('\\p{N}', 'u')), ['a', 'b', 'c']);
  assert.equal('x1 y2'.replace(re, '[$2$1]'), '[1x] [2y]');
  assert.deepEqual([...'α1β2'.matchAll(new R('\\p{L}', 'gu'))].map(m => m.index), [0, 2]);
  assert.deepEqual('α1β2'.match(new R('\\p{N}', 'gu')), ['1', '2']);
  assert.equal('α1'.search(new R('\\p{N}', 'u')), 1);
  // Copies, made any way, keep the code points.
  assert.equal(new R(re).source, re.source);
  assert.ok(new R(re.source, re.flags).test('q9'));
  assert.ok(new re.constructor(re.source, re.flags).test('q9'));
  // A regex given the u flag later reads \p as a property, as in an engine with ICU.
  assert.ok(new R(/^\p{L}$/, 'u').test('α'));
  assert.ok(new R('^a/b\\p{L}$', 'u').test('a/bα'));
}));

test('copies through the engine RegExp work without ICU (lodash cloneRegExp: new re.constructor(source, flags))', () => {
  const ctor = Object.getOwnPropertyDescriptor(NativeRegExp.prototype, 'constructor');
  Object.defineProperty(NativeRegExp.prototype, 'constructor', {...ctor, value: NoIcuRegExp});
  try {
    withWrapper(R => {
      const re = new R(PREPVIZ, 'iu');
      assert.ok(new re.constructor(re.source, /\w*$/.exec(re)[0]).test('XP'));
      const b = /b/g; b[Symbol.match] = false;
      assert.notEqual(R(b), b, 'IsRegExp reads Symbol.match first');
    }, noIcu);
  } finally { Object.defineProperty(NativeRegExp.prototype, 'constructor', ctor); }
});

test('one escape or surrogate pair is one class atom; an empty property never negates a class', () => withWrapper(R => {
  for (const p of ['[\\x41-\\x5A-\\p{L}]', '[\\u0041-\\u005A-\\p{L}]', '[\\cA-\\cZ-\\p{L}]', '[a-😀-\\p{L}]']) {
    for (const s of ['-', 'q', '1']) assert.equal(new R(p, 'u').test(s), new NativeRegExp(p, 'u').test(s), `${p} on ${s}`);
  }
  assert.ok(!new R('^[\\P{Any}^a]$', 'u').test('b'));
  assert.ok(new R('^[\\P{Any}^a]$', 'u').test('^'));
}, noIcu));

test('rewrites are cached by pattern and flags', () => withWrapper(R => {
  const before = cachedRewrites();
  for (let i = 0; i < 1000; i++) new R('^\\p{L}\\p{N}$', 'u');
  new R('^\\p{L}\\p{N}$', 'iu');
  assert.equal(cachedRewrites() - before, 2);
}));

test('v-flag patterns: plain classes are rewritten, set operations are refused clearly', () => {
  assert.throws(() => rewriteUnicodeProperties('[\\p{L}--[a-z]]', 'v'), /set operation or nested class is not supported/);
  assert.throws(() => rewriteUnicodeProperties('[\\p{L}&&\\p{Lu}]', 'v'), /set operation/);
  assert.throws(() => rewriteUnicodeProperties('\\P{Lu}', 'iv'), /with the i and v flags/);
  assert.equal(rewriteUnicodeProperties('a\\p{Unknown}', 'u'), null);
  withWrapper(R => {
    assert.throws(() => new R('[\\p{L}--[a-z]]', 'v'), SyntaxError);
    assert.ok(new R('^[\\p{Script=Greek}_]+$', 'v').test('αβ_'));
  });
});
