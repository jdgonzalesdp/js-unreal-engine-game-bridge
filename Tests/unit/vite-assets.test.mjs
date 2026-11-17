// Vite's asset rules in the bridge's build (Tools/vite-assets.mjs, vite-import-glob.mjs, vite-glob.mjs, js-mask.mjs):
// new URL(..., import.meta.url) files are copied into the build and their URLs rewritten, and import.meta.glob
// expands with Vite's keys and options.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {maskLiterals} from '../../Tools/js-mask.mjs';
import {globFiles, expandBraces} from '../../Tools/vite-glob.mjs';
import {expandImportGlobs} from '../../Tools/vite-import-glob.mjs';
import {rewriteNewUrls, rebaseCssUrls, assetUrl} from '../../Tools/vite-assets.mjs';

// A monorepo like PrepViz's: the game in apps/web, a workspace package beside it with the model files.
const top = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgb-vite-assets-'));
const put = (rel, text = rel) => { const f = path.join(top, rel); fs.mkdirSync(path.dirname(f), {recursive: true}); fs.writeFileSync(f, text); return f; };
put('packages/shapes/src/character/assets/heads/curly.glb', 'glTF-curly');
put('packages/shapes/src/character/assets/heads/bob.glb', 'glTF-bob');
put('packages/shapes/src/character/assets/heads/eyes/curly.glb', 'glTF-curly-eyes');
put('packages/shapes/src/character/assets/heads/.hidden.glb');
put('packages/shapes/src/character/assets/bodies/oval.glb', 'glTF-oval');
const heads = put('packages/shapes/src/character/heads.ts', '');
const bodies = put('packages/shapes/src/rig/bodies.ts', '');
put('apps/web/public/logo.png', 'png');
put('apps/web/src/levels/film-1.json', '{"n":1}');
put('apps/web/src/levels/film-12.json', '{"n":12}');
put('apps/web/src/levels/film-x.json', '{}');
put('apps/web/src/levels/a/document.json', '{}');
put('apps/web/src/levels/node_modules/b/document.json', '{}');
put('apps/web/src/levels/b/document.json', '{}');
const source = put('apps/web/src/state/source.ts', '');
const out = path.join(top, 'out');
const game = {repo: path.join(top, 'apps/web'), out, publicRoots: [path.join(top, 'apps/web/public'), out, path.join(top, 'apps/web')]};
const quiet = [];
const warn = t => quiet.push(t);

test('masking blanks comments and literal text but keeps code and every offset', () => {
  const code = "const a = 'new URL(x)'; // new URL('./y', import.meta.url)\nconst b = `t ${new URL('./z', import.meta.url)} u`; /* c */ const r = /new URL\\(/;";
  const masked = maskLiterals(code);
  assert.equal(masked.length, code.length);
  assert.equal(masked.match(/new URL/g).length, 1, 'only the call inside the template expression is code');
  assert.ok(masked.includes("new URL('   ', import.meta.url)"));
});

test('globs follow picomatch: classes, braces, ** and !, no dot files, no node_modules', () => {
  const dir = path.join(top, 'apps/web/src').replaceAll('\\', '/');
  const rel = files => files.map(f => path.posix.relative(dir, f));
  assert.deepEqual(rel(globFiles([`${dir}/levels/film-[1-9].json`, `${dir}/levels/film-[1-9][0-9].json`])), ['levels/film-1.json', 'levels/film-12.json']);
  assert.deepEqual(rel(globFiles([`${dir}/levels/*/document.json`])), ['levels/a/document.json', 'levels/b/document.json']);
  assert.deepEqual(rel(globFiles([`${dir}/levels/**/document.json`, `!${dir}/levels/b/**`])), ['levels/a/document.json']);
  assert.deepEqual(rel(globFiles([`${dir}/levels/**/document.json`], {exhaustive: true})), ['levels/a/document.json', 'levels/b/document.json', 'levels/node_modules/b/document.json']);
  assert.deepEqual(expandBraces('a/{b,c{d,e}}/{1..3}.x').length, 9);
  const shapes = path.join(top, 'packages/shapes/src/character/assets/heads').replaceAll('\\', '/');
  assert.deepEqual(globFiles([`${shapes}/*.glb`]).map(f => path.basename(f)), ['bob.glb', 'curly.glb']);
});

test('import.meta.glob expands with Vite 6 keys: ./ and ../ for relative patterns, /x for root ones', async () => {
  const code = [
    'const films = import.meta.glob(["../levels/film-[1-9].json", "../levels/film-[1-9][0-9].json"], { eager: true, import: "default" });',
    'const lazy = import.meta.glob<{ default: unknown }>("../levels/*/document.json");',
    'const keys = Object.keys(import.meta.glob("/src/levels/*.json"));',
    'const raw = import.meta.glob("../levels/film-1.json", { query: "?raw", import: "default", eager: true });',
    '// import.meta.glob("./not-a-call/*") stays a comment',
  ].join('\n');
  const outCode = expandImportGlobs(code, source, game.repo, warn);
  assert.match(outCode, /^import \{ default as __jsgbGlob_0_0 \} from "\.\.\/levels\/film-1\.json";import \{ default as __jsgbGlob_0_1 \} from "\.\.\/levels\/film-12\.json";/);
  assert.match(outCode, /"\.\.\/levels\/film-1\.json": __jsgbGlob_0_0,"\.\.\/levels\/film-12\.json": __jsgbGlob_0_1/);
  assert.match(outCode, /"\.\.\/levels\/a\/document\.json": \(\) => import\("\.\.\/levels\/a\/document\.json"\)/);
  assert.ok(!outCode.includes('node_modules'));
  assert.match(outCode, /Object\.keys\(\{"\/src\/levels\/film-1\.json": 0,"\/src\/levels\/film-12\.json": 0,"\/src\/levels\/film-x\.json": 0\}\)/);
  assert.match(outCode, /from "\.\.\/levels\/film-1\.json\?raw"/);
  assert.match(outCode, /\/\/ import\.meta\.glob\("\.\/not-a-call\/\*"\) stays a comment/);
  assert.equal(outCode.split('\n').length, code.split('\n').length, 'line numbers kept');
});

test('a template new URL looks the file up among every file it can name, copied into the build', () => {
  const code = 'export const head = (id: string) => new URL(`./assets/heads/${id}.glb`, import.meta.url);';
  const outCode = rewriteNewUrls(code, heads, game, warn);
  const map = /new URL\(\((\{[^}]*\})\)\[`\.\/assets\/heads\/\$\{id\}\.glb`\], import\.meta\.url\)/.exec(outCode);
  assert.ok(map, outCode);
  const urls = JSON.parse(map[1]);
  assert.deepEqual(Object.keys(urls), ['./assets/heads/bob.glb', './assets/heads/curly.glb'], 'one level, no dot files');
  for (const [key, url] of Object.entries(urls)) {
    assert.match(url, /^\/assets\/(bob|curly)-[0-9a-f]{8}\.glb$/);
    assert.equal(fs.readFileSync(path.join(out, url), 'utf8'), fs.readFileSync(path.resolve(path.dirname(heads), key), 'utf8'));
  }
  const body = rewriteNewUrls('const u = (b) => new URL(`../character/assets/bodies/${b.id}.glb`, import.meta.url);', bodies, game, warn);
  assert.match(body, /\{"\.\.\/character\/assets\/bodies\/oval\.glb": "\/assets\/oval-[0-9a-f]{8}\.glb"\}/);
});

test('a static new URL becomes the copied file; public files, data: URLs, workers and missing files stay', () => {
  const eyes = '../../../../packages/shapes/src/character/assets/heads/eyes/curly.glb';
  const code = [
    `const a = new URL("${eyes}", import.meta.url);`,
    'const b = new URL("/logo.png", import.meta.url);',
    'const c = new URL("data:text/plain,x", import.meta.url);',
    'const d = new Worker(new URL("./w.ts", import.meta.url));',
    'const e = new URL("./missing.bin", import.meta.url);',
    '// const f = new URL("./commented.glb", import.meta.url);',
    'const g = new URL(/* @vite-ignore */ "./bob.glb", import.meta.url);',
  ].join('\n');
  quiet.length = 0;
  const lines = rewriteNewUrls(code, source, game, warn).split('\n');
  assert.match(lines[0], /^const a = new URL\("\/assets\/curly-[0-9a-f]{8}\.glb", import\.meta\.url\);$/);
  assert.equal(fs.readFileSync(path.join(out, /"(\/assets\/[^"]+)"/.exec(lines[0])[1]), 'utf8'), 'glTF-curly-eyes');
  assert.equal(lines[1], 'const b = new URL("/logo.png", import.meta.url);');
  assert.deepEqual(lines.slice(2), code.split('\n').slice(2));
  assert.equal(quiet.length, 1, 'one warning, for the missing file');
  assert.equal(assetUrl(game, path.join(top, 'apps/web/public/logo.png')), '/logo.png');
});

test('relative url() in a linked stylesheet is rebased to the site root', () => {
  const css = "@font-face{src:url('Saans.woff2') format('woff2')} a{background:url(../img/x.png?v=2)} b{mask:url(#m)} c{background:url(data:image/png;base64,AA==)} d{background:url(/abs.png)}";
  assert.equal(rebaseCssUrls(css, '/fonts/saans/saans.css'),
    "@font-face{src:url('/fonts/saans/Saans.woff2') format('woff2')} a{background:url(/fonts/img/x.png?v=2)} b{mask:url(#m)} c{background:url(data:image/png;base64,AA==)} d{background:url(/abs.png)}");
});

test.after(() => fs.rmSync(top, {recursive: true, force: true}));
