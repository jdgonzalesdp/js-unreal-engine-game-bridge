// The scene exporter keeps what it sent and skips what did not change. These tests drive pages that churn every frame
// (needsUpdate on every material, new hook closures, fat lines given new buffers or geometries) and check, frame by
// frame, that what Unreal ends up holding is what a fresh exporter, with nothing kept, sends for that frame: the same
// geometry bytes, material descriptions and records. They also check the churn costs nothing: no hook runs again and
// nothing is sent again unless a frame really changed. Before, PrepViz's needsUpdate on about 180 materials while dragging an object re-ran every hook and
// re-hashed every shader (58 ms of each frame in Unreal), and a fat line set again with setPositions never moved.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime, moduleThreeUrl} from './load-runtime.mjs';
import {recordingHost, resolveFrame, materialChurn, lineChurn} from './scene-churn-scenes.mjs';

const THREE = await import(moduleThreeUrl);
const camera = new THREE.PerspectiveCamera(50, 1.5, 0.1, 100);
camera.position.set(0, 2, 8); camera.lookAt(0, 0, 0);

async function exporter() {
  const {host, rec} = recordingHost();
  const x = await loadRuntime('../../Tests/unit/scene-churn-fixture.ts', host, moduleThreeUrl);
  const frame = scene => { x.lastFrame.scene = scene; x.lastFrame.camera = camera; x.exportFrame(); return resolveFrame(x, rec); };
  return {x, rec, frame};
}

/** Runs the scene's frames through one exporter that keeps state (what the bridge does) and, for each frame, through a
 *  fresh exporter (the truth for that frame). Returns the kept exporter's records and per-frame send counts. */
async function compare(make) {
  const counts = {on: false, hook: 0};
  const s = make(THREE, counts), kept = await exporter(), sends = [];
  for (let f = 0; f < s.frames; f++) {
    s.step(f);
    const before = kept.rec.geometrySends + kept.rec.materialSends;
    counts.on = true; const got = kept.frame(s.scene); counts.on = false;
    sends.push(kept.rec.geometrySends + kept.rec.materialSends - before);
    const fresh = await exporter();
    assert.deepEqual(got, fresh.frame(s.scene), `frame ${f}: the kept exporter's state differs from a fresh export`);
  }
  return {s, counts, sends, kept};
}

test('needsUpdate every frame: same bytes as a fresh export, and the hook runs only for a new program key', async () => {
  const {counts, sends, kept} = await compare(materialChurn);
  // Frames 1, 2 and 9 only set needsUpdate: nothing goes. Frames 3, 4, 5 and 7 each change what a material looks like.
  // (Frames 6 and 8 pick a new program; with no shader translator here, what they send is not checked.)
  for (const f of [1, 2, 9]) assert.equal(sends[f], 0, `frame ${f} only set needsUpdate but sent ${sends[f]}`);
  for (const f of [0, 3, 4, 5, 7]) assert.ok(sends[f] > 0, `frame ${f} changed a material but sent nothing`);
  // Three runs: the first frame, the define on frame 6, the program key on frame 8 (WebGLRenderer.getProgram does the same).
  assert.equal(counts.hook, 3);
  assert.equal(kept.rec.logs.filter(l => l.startsWith('error')).length, 0, kept.rec.logs.join('\n'));
});

test('fat lines given new buffers every frame: same bytes as a fresh export, sent only when they move', async () => {
  const {s, sends, kept} = await compare(lineChurn);
  for (let f = 1; f < s.frames; f++) assert.equal(sends[f] > 0, s.changes.has(f), `frame ${f} sent ${sends[f]}`);
  // One stand-in per line, rewritten in place: four geometry ids for the whole run.
  assert.equal(kept.rec.geometries.size, 4);
});
