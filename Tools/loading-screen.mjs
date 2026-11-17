// The host's loading screen look ("loading" in Games/<game>.json), checked and written into publication.json.
//   "loading": {
//     "background": "#14181a",                 the screen's colour
//     "title": "PrepViz",                      the name shown (the game's title when left out)
//     "titleColor": "#f1f3ee",
//     "logo": "/brand/wordmark.png",           a wordmark image drawn instead of the title
//     "byline": "from",                        a short line under the name
//     "bylineColor": "#b2b9b4",
//     "bylineLogo": {"file": "Games/brand/house.png", "height": 18, "tint": "#f1f3ee"},
//     "accent": "#f07b2b",                     the moving bar
//     "statusColor": "#787e7b"                 the files and shaders line
//   }
// Colours are #rgb, #rrggbb or #rrggbbaa. An image is a PNG path or {file, height, tint}: a path starting with "/" is
// looked up in the game's public folders, as the page would load it; any other path is relative to the bridge folder,
// like "repo". "height" is the drawn height in points, and "tint" repaints a one-colour mark (ink on transparent) in
// that colour, keeping its alpha. The images are copied to <out>/jsgb/loading, and the host draws them at the screen's
// pixel scale (Source/JsGameBridge/Private/JsgbLoadingLook.cpp). A game without "loading" keeps the host's own look.
import fs from 'node:fs';
import path from 'node:path';

const COLORS = ['background', 'titleColor', 'bylineColor', 'accent', 'statusColor'];
const TEXTS = ['title', 'byline'];
const IMAGES = {logo: {height: 56, name: 'logo.png'}, bylineLogo: {height: 18, name: 'byline-logo.png'}};
const IMAGE_KEYS = ['file', 'height', 'tint'];

/** "#rgb", "#rrggbb" or "#rrggbbaa" as lowercase "#rrggbbaa"; throws on anything else. */
export function normalizeColor(value, where) {
  const m = typeof value === 'string' ? /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim()) : null;
  if (!m) throw Error(`${where}: "${value}" is not a colour; use #rgb, #rrggbb or #rrggbbaa`);
  let hex = m[1].toLowerCase();
  if (hex.length === 3) hex = [...hex].map(c => c + c).join('');
  return '#' + (hex.length === 6 ? hex + 'ff' : hex);
}

/** Width and height from a PNG's header; throws when the file is not a PNG. */
export function pngSize(file) {
  const head = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, head, 0, 24, 0); } finally { fs.closeSync(fd); }
  if (head.readUInt32BE(0) !== 0x89504e47 || head.readUInt32BE(4) !== 0x0d0a1a0a || head.toString('latin1', 12, 16) !== 'IHDR') {
    throw Error(`${file} is not a PNG; the loading screen draws PNG images only`);
  }
  return {width: head.readUInt32BE(16), height: head.readUInt32BE(20)};
}

/** Where an image path points: "/x.png" in the first public folder that has it, else relative to the bridge. */
export function resolveImage(file, {bridge, publicRoots = []}) {
  if (file.startsWith('/')) {
    const found = publicRoots.map(root => path.join(root, file.slice(1))).find(f => fs.existsSync(f));
    if (!found) throw Error(`${file} is in none of the game's public folders`);
    return found;
  }
  return path.resolve(bridge, file);
}

function readImage(key, value, ctx) {
  const where = `loading.${key}`;
  const spec = typeof value === 'string' ? {file: value} : value;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || typeof spec.file !== 'string' || !spec.file) {
    throw Error(`${where}: give a PNG path or {"file", "height", "tint"}`);
  }
  for (const k of Object.keys(spec)) if (!IMAGE_KEYS.includes(k)) throw Error(`${where}: unknown field "${k}"`);
  const height = spec.height ?? IMAGES[key].height;
  if (typeof height !== 'number' || !(height > 0) || height > 1000) throw Error(`${where}.height: a number of points above 0`);
  const source = resolveImage(spec.file, ctx);
  if (!fs.existsSync(source)) throw Error(`${where}: ${source} does not exist`);
  pngSize(source);
  const image = {source, file: 'jsgb/loading/' + IMAGES[key].name, height};
  if (spec.tint !== undefined) image.tint = normalizeColor(spec.tint, `${where}.tint`);
  return image;
}

/** The checked look, with each image's source path; throws with the field's name on any mistake. */
export function parseLoading(loading, ctx) {
  if (loading === undefined || loading === null) return null;
  if (typeof loading !== 'object' || Array.isArray(loading)) throw Error('loading: an object of colours, texts and images');
  const look = {};
  for (const [key, value] of Object.entries(loading)) {
    if (COLORS.includes(key)) look[key] = normalizeColor(value, `loading.${key}`);
    else if (TEXTS.includes(key)) {
      if (typeof value !== 'string') throw Error(`loading.${key}: a string`);
      look[key] = value;
    } else if (key in IMAGES) look[key] = readImage(key, value, ctx);
    else throw Error(`loading: unknown field "${key}"`);
  }
  return look;
}

/** Copies the look's images into <out>/jsgb/loading and returns what publication.json carries (paths relative to
 *  the game's folder), or undefined for a game without "loading". */
export function publishLoading(game, bridge) {
  const look = parseLoading(game.loading, {bridge, publicRoots: game.publicRoots ?? []});
  const dir = path.join(game.out, 'jsgb', 'loading');
  fs.rmSync(dir, {recursive: true, force: true});
  if (!look) return undefined;
  for (const key of Object.keys(IMAGES)) {
    if (!look[key]) continue;
    fs.mkdirSync(dir, {recursive: true});
    fs.copyFileSync(look[key].source, path.join(game.out, look[key].file));
    delete look[key].source;
  }
  return look;
}
