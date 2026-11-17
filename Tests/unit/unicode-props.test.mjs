// The Unicode property table the build writes into each bundle (Tools/unicode-props.mjs): which escapes it finds, that
// each class it writes holds exactly the property's code points (and the complement exactly the rest), and how it
// lands at the top of a built file.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Run from its own folder (not bundled into the test), so it finds the Runtime packages.
const props = await import(pathToFileURL(path.join(root, 'Tools/unicode-props.mjs')).href);

// Bundle text as esbuild writes it: escapes inside strings and template strings have their backslash doubled.
const BUNDLE = String.raw`
  const a = new RegExp("(?<![\\p{L}\\p{N}_])(?:XP)s?", "iu");
  const b = ${'`'}^[\\p{Extended_Pictographic}\\p{Emoji_Component}]+$${'`'};
  const c = /\P{Lu}/u, d = "\\p{Script=Greek}\\p{scx=Hani}\\p{General_Category=Decimal_Number}\\p{Alpha}";
  const e = "\\p{Nope}\\p{RGI_Emoji}\\p{Greek}\\p{Lowercase=Yes}";`;

test('finds every property escape, in strings, template strings and literals', () => {
  const found = props.scanPropertyEscapes(BUNDLE);
  assert.deepEqual([...found.keys()].sort(), ['Alpha', 'Emoji_Component', 'Extended_Pictographic', 'General_Category=Decimal_Number',
    'L', 'Lowercase=Yes', 'Lu', 'N', 'Nope', 'RGI_Emoji', 'Script=Greek', 'scx=Hani', 'Greek'].sort());
  assert.deepEqual([...found.get('Lu')], ['P']);
  assert.deepEqual([...found.get('L')], ['p']);
});

test('the table keeps the properties ECMAScript knows and says why it leaves the rest out', () => {
  const {included, skipped, source} = props.propertyTableSource(props.scanPropertyEscapes(BUNDLE).keys());
  assert.deepEqual(included, ['Alpha', 'Emoji_Component', 'Extended_Pictographic', 'General_Category=Decimal_Number', 'L', 'Lu', 'N', 'Script=Greek', 'scx=Hani']);
  assert.deepEqual(skipped, ['Greek (unknown)', 'Lowercase=Yes (unknown)', 'Nope (unknown)', 'RGI_Emoji (property of strings, needs the v flag)']);
  assert.match(source, /^[\x20-\x7e]*$/, 'the table is plain ASCII');
});

test('each class holds exactly the property, and the complement exactly the rest', () => {
  const names = ['L', 'N', 'Lu', 'Script=Greek', 'sc=Han', 'Extended_Pictographic', 'Emoji_Component', 'Regional_Indicator', 'Any', 'ASCII', 'Cs'];
  const table = (0, eval)(`(${props.propertyTableSource(names).source})`);
  for (const name of names) {
    const ranges = props.propertyRanges(name);
    for (const [form, list] of [[0, ranges], [1, props.complementRanges(ranges)]]) {
      const inside = new RegExp(`^[${table[name][form]}]$`, 'u'), outside = new RegExp(`^[^${table[name][form]}]$`, 'u');
      for (const [a, b] of list) {
        for (const cp of [a, b, (a + b) >> 1]) assert.ok(inside.test(String.fromCodePoint(cp)), `${name}[${form}] has U+${cp.toString(16)}`);
        for (const cp of [a - 1, b + 1]) if (cp >= 0 && cp <= 0x10ffff) assert.ok(outside.test(String.fromCodePoint(cp)), `${name}[${form}] lacks U+${cp.toString(16)}`);
      }
      // Node reads \p itself (it has ICU): the class must agree with it on a spread of code points.
      const own = new RegExp(`^${form ? '\\P' : '\\p'}{${name}}$`, 'u');
      for (let cp = 0; cp <= 0x10ffff; cp += 97) assert.equal(inside.test(String.fromCodePoint(cp)), own.test(String.fromCodePoint(cp)), `${name}[${form}] U+${cp.toString(16)}`);
    }
  }
  assert.equal(table.Any[1], '', 'nothing is outside Any');
});

test('the table goes at the top of each built file, after "use strict", once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgb-unicode-props-'));
  try {
    const worker = path.join(dir, 'worker.js'), main = path.join(dir, 'main.mjs'), plain = path.join(dir, 'plain.js');
    fs.writeFileSync(worker, '"use strict";\n(() => { globalThis.made = new RegExp("^\\\\p{L}+$", "u").source; })();\n');
    fs.writeFileSync(main, 'var x = `\\\\P{N}`;\n');
    fs.writeFileSync(plain, 'var y = /\\d+/;\n');
    const logs = [];
    props.injectUnicodeProperties([worker, main, plain, path.join(dir, 'missing.js')], line => logs.push(line));
    props.injectUnicodeProperties([worker], () => {});
    const code = fs.readFileSync(worker, 'utf8');
    assert.ok(code.startsWith('"use strict";\nglobalThis.__jsgbUnicodeProps = '));
    assert.equal(code.split('globalThis.__jsgbUnicodeProps =').length, 2, 'one table after two runs');
    const context = {};
    vm.runInNewContext(code, context);
    assert.deepEqual(Object.keys(context.__jsgbUnicodeProps), ['L']);
    assert.ok(fs.readFileSync(main, 'utf8').startsWith('globalThis.__jsgbUnicodeProps = '));
    assert.equal(fs.readFileSync(plain, 'utf8'), 'var y = /\\d+/;\n');
    assert.equal(logs.length, 2);
    assert.match(logs[0], /^unicode properties in worker\.js: L \(\d+\.\d KB\)$/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
