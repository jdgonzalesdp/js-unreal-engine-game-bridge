// The loading screen look in a game's config (Tools/loading-screen.mjs): colours, texts and images are checked, the
// images are copied into the build, and publication.json carries paths relative to the game's folder.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeColor, parseLoading, pngSize, publishLoading} from '../../Tools/loading-screen.mjs';

const bridge = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mark = path.join(bridge, 'Games/brand/livalittle-wordmark-ink.png');
const made = [];
after(() => { for (const dir of made) fs.rmSync(dir, {recursive: true, force: true}); });

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgb-loading-'));
  made.push(dir);
  const pub = path.join(dir, 'public');
  fs.mkdirSync(path.join(pub, 'brand'), {recursive: true});
  fs.copyFileSync(mark, path.join(pub, 'brand/mark.png'));
  fs.writeFileSync(path.join(pub, 'brand/not-a-png.png'), 'GIF89a, not a PNG at all');
  return {dir, pub, ctx: {bridge, publicRoots: [pub]}};
}

test('colours become lowercase #rrggbbaa', () => {
  assert.equal(normalizeColor('#ABC', 'x'), '#aabbccff');
  assert.equal(normalizeColor('#14181a', 'x'), '#14181aff');
  assert.equal(normalizeColor(' #F1F3EEDB ', 'x'), '#f1f3eedb');
  for (const bad of ['14181a', '#12345', 'red', '#ggg', 7, null]) assert.throws(() => normalizeColor(bad, 'loading.accent'), /loading\.accent/);
});

test('a game without "loading" keeps the host look', () => {
  assert.equal(parseLoading(undefined, {bridge}), null);
  assert.equal(parseLoading(null, {bridge}), null);
});

test('texts, colours and images are read; images default their height', () => {
  const {ctx} = scratch();
  const look = parseLoading({background: '#000', title: 'Game', byline: 'from', accent: '#f07b2b', logo: '/brand/mark.png',
    bylineLogo: {file: 'Games/brand/livalittle-wordmark-ink.png', height: 20, tint: '#fff'}}, ctx);
  assert.equal(look.background, '#000000ff');
  assert.equal(look.title, 'Game');
  assert.equal(look.byline, 'from');
  assert.equal(look.accent, '#f07b2bff');
  assert.deepEqual({...look.logo, source: undefined}, {source: undefined, file: 'jsgb/loading/logo.png', height: 56});
  assert.equal(look.logo.source, path.join(ctx.publicRoots[0], 'brand/mark.png'));
  assert.deepEqual({...look.bylineLogo, source: undefined}, {source: undefined, file: 'jsgb/loading/byline-logo.png', height: 20, tint: '#ffffffff'});
  assert.equal(look.bylineLogo.source, mark);
});

test('mistakes name the field', () => {
  const {ctx} = scratch();
  const cases = [
    [[], /loading: an object/],
    [{colour: '#fff'}, /unknown field "colour"/],
    [{title: 3}, /loading\.title: a string/],
    [{titleColor: 'white'}, /loading\.titleColor/],
    [{logo: 5}, /loading\.logo: give a PNG path/],
    [{logo: {file: '/brand/mark.png', size: 3}}, /loading\.logo: unknown field "size"/],
    [{logo: {file: '/brand/mark.png', height: 0}}, /loading\.logo\.height/],
    [{logo: {file: '/brand/mark.png', tint: 'ink'}}, /loading\.logo\.tint/],
    [{logo: '/brand/missing.png'}, /none of the game's public folders/],
    [{bylineLogo: 'Games/brand/missing.png'}, /does not exist/],
    [{logo: '/brand/not-a-png.png'}, /is not a PNG/],
  ];
  for (const [loading, message] of cases) assert.throws(() => parseLoading(loading, ctx), message, JSON.stringify(loading));
});

test('the build copies the images and publishes paths inside the game folder', () => {
  const {dir, pub} = scratch();
  const out = path.join(dir, 'out');
  const game = {out, publicRoots: [pub], loading: {title: 'Game', logo: '/brand/mark.png', bylineLogo: {file: 'Games/brand/livalittle-wordmark-ink.png', tint: '#f1f3ee'}}};
  const look = publishLoading(game, bridge);
  assert.deepEqual(look, {title: 'Game', logo: {file: 'jsgb/loading/logo.png', height: 56},
    bylineLogo: {file: 'jsgb/loading/byline-logo.png', height: 18, tint: '#f1f3eeff'}});
  assert.deepEqual(pngSize(path.join(out, look.logo.file)), pngSize(mark));
  assert.ok(fs.existsSync(path.join(out, look.bylineLogo.file)));
  // A later build without the field leaves no stale images and publishes nothing.
  assert.equal(publishLoading({out, publicRoots: [pub]}, bridge), undefined);
  assert.ok(!fs.existsSync(path.join(out, 'jsgb/loading')));
});

test('PrepViz shows "PrepViz from Livalittle" with the Livalittle mark tinted for the dark screen', () => {
  const game = JSON.parse(fs.readFileSync(path.join(bridge, 'Games/prepviz.json'), 'utf8'));
  const look = parseLoading(game.loading, {bridge, publicRoots: []});
  assert.equal(look.title, 'PrepViz');
  assert.equal(look.byline, 'from');
  assert.equal(look.bylineLogo.source, mark);
  assert.match(look.bylineLogo.tint, /^#f1f3ee/);
  assert.deepEqual(pngSize(mark), {width: 697, height: 179});
  // House copy rule: no em dashes on screen.
  for (const text of [look.title, look.byline]) assert.ok(!text.includes('\u2014'), text);
});
