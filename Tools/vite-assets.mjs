// Vite's asset URLs for the bridge's esbuild build (Tools/jsgb.mjs). A browser build of the game gets these from
// Vite; without them the files are never copied into the build and their URLs point back at the source tree.
//  - new URL('./x.glb', import.meta.url): the file is copied to <out>/assets/<name>-<hash>.<ext> and the URL becomes
//    '/assets/<name>-<hash>.<ext>', which the host serves from <out> (vite/src/node/plugins/assetImportMetaUrl.ts).
//    A file in the game's public folder keeps its public path. A URL that names no file is left as written.
//  - new URL(`./heads/${id}.glb`, import.meta.url): every file the template can name (./heads/*.glb) is copied, and
//    the URL is looked up by the template's value, as Vite does through import.meta.glob(..., {query: '?url'}).
//  - import.meta.glob: Tools/vite-import-glob.mjs.
//  - Dependencies' own new URL(..., import.meta.url) files (an Emscripten module's .wasm), as Vite does in a build.
//  - Asset types Vite knows that the build had no loader for (avif, mp4, ico, ...) load as files.
//  - Relative url() in a stylesheet the page links from its public folder is rebased, since the build merges every
//    stylesheet into one file at the root.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {maskLiterals} from './js-mask.mjs';
import {globFiles, globSafe} from './vite-glob.mjs';
import {expandImportGlobs} from './vite-import-glob.mjs';
import {rewriteUnicodePropertyRegexes} from './unicode-regex.mjs';

const posix = p => p.replaceAll('\\', '/');
// The bridge's own runtime packages are not the game's: a browser build of the game never sees them.
const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../Runtime') + path.sep;
const NEW_URL = /\bnew\s+URL\s*\(\s*('[^']+'|"[^"]+"|`[^`]+`)\s*,\s*import\.meta\.url\s*(?:,\s*)?\)/g;
// Vite's KNOWN_ASSET_TYPES that the build's loader table (Tools/jsgb.mjs) leaves out.
const EXTRA_ASSETS = /\.(apng|bmp|jfif|pjpeg|pjp|ico|avif|cur|jxl|mp4|webm|flac|aac|opus|mov|m4a|vtt|eot|webmanifest|pdf)$/i;
const LOADERS = {'.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx'};

// Copies already made by this process, by output folder and source file state.
const emitted = new Map();

/** Copies a file into <out>/assets under a content hash and returns its served path ('/assets/name-hash.ext'). A file
 *  inside one of the game's public folders is served as it is, at its public path. */
export function assetUrl(game, file) {
  const publics = game.publicRoots.filter(r => r !== game.out && r !== game.repo);
  for (const root of publics) {
    const rel = posix(path.relative(root, file));
    if (rel && !rel.startsWith('../') && !path.isAbsolute(rel)) return '/' + rel;
  }
  const stat = fs.statSync(file);
  const key = `${game.out}\0${file}\0${stat.size}\0${stat.mtimeMs}`;
  const known = emitted.get(key);
  if (known && fs.existsSync(path.join(game.out, known))) return known;
  const bytes = fs.readFileSync(file);
  const ext = path.extname(file);
  const rel = `/assets/${path.basename(file, ext)}-${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}${ext}`;
  const dest = path.join(game.out, rel);
  if (!fs.existsSync(dest) || fs.statSync(dest).size !== bytes.length) { fs.mkdirSync(path.dirname(dest), {recursive: true}); fs.writeFileSync(dest, bytes); }
  emitted.set(key, rel);
  return rel;
}

const isFile = f => { try { return fs.statSync(f).isFile(); } catch { return false; } };

/** The file a static new URL() names, as Vite's resolver finds it, or null (a folder, a missing file, another origin). */
function assetFile(url, importer, game) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//') || url.startsWith('#')) return null;
  const dir = path.dirname(importer);
  if (url.startsWith('.')) return isFile(path.resolve(dir, url)) ? path.resolve(dir, url) : null;
  if (url.startsWith('/')) {
    // A public file keeps its URL; otherwise the path is from the project root.
    for (const root of game.publicRoots.filter(r => r !== game.out && r !== game.repo)) if (isFile(path.join(root, url))) return path.join(root, url);
    return isFile(path.join(game.repo, url)) ? path.join(game.repo, url) : null;
  }
  // A bare name is first a file beside the module (Vite's preferRelative), then a package file.
  if (isFile(path.resolve(dir, url))) return path.resolve(dir, url);
  for (let d = dir; ; d = path.dirname(d)) {
    if (isFile(path.join(d, 'node_modules', url))) return path.join(d, 'node_modules', url);
    if (path.dirname(d) === d) return null;
  }
}

// A template literal's text parts and whether it has any ${...}; null when the braces don't balance.
function templateParts(raw) {
  const quasis = [];
  let text = '', dynamic = false;
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw[i] === '\\') { text += raw[i] + raw[i + 1]; i++; continue; }
    if (raw[i] !== '$' || raw[i + 1] !== '{') { text += raw[i]; continue; }
    let depth = 0, j = i + 1;
    for (; j < raw.length - 1; j++) { if (raw[j] === '{') depth++; else if (raw[j] === '}' && --depth === 0) break; }
    if (depth !== 0) return null;
    quasis.push(text); text = ''; dynamic = true; i = j;
  }
  quasis.push(text);
  return {quasis, dynamic};
}

// The template's glob (Vite's buildGlobPattern): each ${...} is one *.
const templateGlob = quasis => quasis.reduce((g, q, i) => g + (i && !g.endsWith('*') ? '*' : '') + q, '');

/** Rewrites every new URL(<literal>, import.meta.url) in a module as Vite does. */
export function rewriteNewUrls(code, file, game, warn = console.warn) {
  if (!code.includes('new URL') || !code.includes('import.meta.url')) return code;
  const masked = maskLiterals(code);
  const dir = posix(path.dirname(file));
  let out = '', from = 0;
  for (const m of masked.matchAll(NEW_URL)) {
    const urlStart = m.index + m[0].indexOf(m[1]);
    const raw = code.slice(urlStart, urlStart + m[1].length);
    // new Worker(new URL(...)) is a worker, not an asset (Tools/jsgb.mjs bundles those).
    if (/\bnew\s+(?:Shared)?Worker\s*\(\s*$/.test(masked.slice(Math.max(0, m.index - 40), m.index))) continue;
    if (/\/\*\s*@vite-ignore\s*\*\//.test(code.slice(m.index, urlStart))) continue;
    let replacement = null;
    if (raw[0] === '`' && raw.includes('${')) {
      const t = templateParts(raw);
      if (!t?.dynamic) continue;
      const q = raw.search(/\?(?![^{]*\})/);
      const pure = q > 0 ? raw.slice(0, q) + '`' : raw;
      const glob = templateGlob(templateParts(pure)?.quasis ?? t.quasis);
      if (glob.startsWith('*')) continue;
      const relative = glob.startsWith('./') || glob.startsWith('../');
      if (!relative && !glob.startsWith('/')) { warn(`${path.basename(file)}: new URL(${raw}) is not relative; left as written`); continue; }
      const abs = relative ? path.posix.join(globSafe(dir), glob) : path.posix.join(globSafe(posix(game.repo)), glob.slice(1));
      const entries = globFiles([abs], {importer: file}).map(f => {
        let key = relative ? path.posix.relative(dir, f) : '/' + path.posix.relative(posix(game.repo), f);
        if (relative && key[0] !== '.') key = './' + key;
        return `${JSON.stringify(key)}: ${JSON.stringify(assetUrl(game, f))}`;
      });
      replacement = `new URL(({${entries.join(', ')}})[${pure}], import.meta.url)`;
    } else {
      const url = raw.slice(1, -1);
      if (url.startsWith('data:') || raw.includes('${')) continue;
      const cut = url.search(/[?#]/), name = cut < 0 ? url : url.slice(0, cut), postfix = cut < 0 ? '' : url.slice(cut);
      const target = assetFile(name, file, game);
      if (!target) { if (!/[\\/]node_modules[\\/]/.test(file)) warn(`${path.basename(file)}: new URL(${raw}, import.meta.url) names no file at build time; left as written`); continue; }
      replacement = `new URL(${JSON.stringify(assetUrl(game, target) + postfix)}, import.meta.url)`;
    }
    out += code.slice(from, m.index) + replacement;
    from = m.index + m[0].length;
  }
  return from ? out + code.slice(from) : code;
}

/** A game module's asset URLs and globs, before the build's other rewrites (Tools/jsgb.mjs). */
export function transformModule(code, file, game, warn) {
  if (!code.includes('import.meta')) return code;
  return expandImportGlobs(rewriteNewUrls(code, file, game, warn), file, game.repo, warn);
}

/** url(...) in a stylesheet linked from the page at `href`, made relative to the site root. */
export function rebaseCssUrls(text, href) {
  const base = 'http://jsgb' + path.posix.dirname('/' + posix(href).replace(/^\/+/, '')) + '/';
  return text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, q, url) =>
    /^([a-z][a-z0-9+.-]*:|\/|#)/i.test(url) ? whole : `url(${q}${(u => u.pathname + u.search + u.hash)(new URL(url, base))}${q})`);
}

/** Installs the asset rules on the build's esbuild plugin and returns the per-module transform for the game's files. */
export function viteAssets(b, game) {
  const seen = new Set();
  const warn = text => { if (!seen.has(text)) { seen.add(text); console.warn(text); } };
  b.onLoad({filter: EXTRA_ASSETS}, async a => a.namespace === 'file' ? {contents: await fs.promises.readFile(a.path), loader: 'file'} : undefined);
  // Dependencies. A module this loads also gets the Unicode rewrite its own onLoad (Tools/unicode-regex.mjs) would.
  b.onLoad({filter: /[\\/]node_modules[\\/].*\.(m?[jt]sx?|cjs)$/}, async a => {
    if (a.namespace !== 'file' || a.path.startsWith(runtime)) return undefined;
    const source = await fs.promises.readFile(a.path, 'utf8');
    if (!source.includes('import.meta')) return undefined;
    const code = transformModule(source, a.path, game, warn);
    if (code === source) return undefined;
    return {contents: rewriteUnicodePropertyRegexes(code).code, loader: LOADERS[path.extname(a.path)] ?? 'js', resolveDir: path.dirname(a.path)};
  });
  return (code, file) => transformModule(code, file, game, warn);
}
