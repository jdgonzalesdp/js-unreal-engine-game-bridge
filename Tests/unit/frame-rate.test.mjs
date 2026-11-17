// How many frames a second Unreal presents: the game's request (window.jsgb.setFrameRate, Runtime/src/frameRate.ts)
// and the default a game config names ("sceneFps", Tools/game-frame-rate.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadRuntime} from './load-runtime.mjs';
import {sceneFps, SCENE_FPS_MAX} from '../../Tools/game-frame-rate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A host that keeps every frame rate it is sent, and every warning. */
function frameRateHost() {
  const host = {registry: '', sent: [], warnings: []};
  host.log = (level, text) => { if (level === 'warn') host.warnings.push(text); };
  host.frameRate = fps => host.sent.push(fps);
  return host;
}

test('a request is a finite number above 0, held to 1 to 240', async () => {
  const m = await loadRuntime('frameRate.ts', frameRateHost());
  assert.equal(m.frameRateRequest(24), 24);
  assert.equal(m.frameRateRequest(23.976), 23.976);
  assert.equal(m.frameRateRequest(0.5), 1);
  assert.equal(m.frameRateRequest(1000), 240);
  for (const none of [null, undefined, 0, -24, NaN, Infinity, '24', {}]) assert.equal(m.frameRateRequest(none), null, String(none));
});

test('the host hears each change once, and 0 when the request is dropped', async () => {
  const host = frameRateHost();
  const m = await loadRuntime('frameRate.ts', host);
  assert.equal(m.setFrameRate(24), 24);
  assert.equal(m.setFrameRate(24), 24);
  assert.equal(m.frameRate(), 24);
  assert.equal(m.setFrameRate(48), 48);
  assert.equal(m.setFrameRate(null), null);
  assert.equal(m.setFrameRate(undefined), null);
  assert.equal(m.frameRate(), null);
  assert.deepEqual(host.sent, [24, 48, 0]);
});

test('window.jsgb gains setFrameRate and frameRate beside what is already there', async () => {
  const display = {get() {}};
  globalThis.jsgb = {display};
  const host = frameRateHost();
  const m = await loadRuntime('frameRate.ts', host);
  assert.equal(globalThis.jsgb.display, display);
  assert.equal(globalThis.jsgb.setFrameRate, m.setFrameRate);
  globalThis.jsgb.setFrameRate(30);
  assert.equal(globalThis.jsgb.frameRate(), 30);
  assert.deepEqual(host.sent, [30]);
  delete globalThis.jsgb;
});

test('a host without the call keeps the request and does not throw; one that throws is logged', async () => {
  const quiet = await loadRuntime('frameRate.ts', {log() {}, registry: ''});
  assert.equal(quiet.setFrameRate(24), 24);
  assert.equal(quiet.frameRate(), 24);
  const host = frameRateHost();
  host.frameRate = () => { throw Error('gone'); };
  const m = await loadRuntime('frameRate.ts', host);
  assert.equal(m.setFrameRate(24), 24);
  assert.equal(host.warnings.length, 1);
  assert.match(host.warnings[0], /gone/);
});

test('"sceneFps" in a game config: 0 when absent, the number when valid, and a stopped build otherwise', () => {
  assert.equal(sceneFps({}), 0);
  assert.equal(sceneFps({sceneFps: null}), 0);
  assert.equal(sceneFps({sceneFps: 60}), 60);
  assert.equal(sceneFps({sceneFps: 0}), 0);
  assert.equal(sceneFps({sceneFps: SCENE_FPS_MAX}), SCENE_FPS_MAX);
  for (const bad of ['60', -1, SCENE_FPS_MAX + 1, NaN, true]) assert.throws(() => sceneFps({id: 'g', sceneFps: bad}), /sceneFps/, String(bad));
});

test('every game config names a valid sceneFps, and PrepViz presents at 60 by default', () => {
  for (const file of fs.readdirSync(path.join(root, 'Games')).filter(f => f.endsWith('.json'))) {
    const game = JSON.parse(fs.readFileSync(path.join(root, 'Games', file), 'utf8'));
    assert.doesNotThrow(() => sceneFps(game), file);
  }
  assert.equal(sceneFps(JSON.parse(fs.readFileSync(path.join(root, 'Games/prepviz.json'), 'utf8'))), 60);
});
