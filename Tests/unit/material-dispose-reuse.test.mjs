// three.js lets a disposed material be drawn again: the renderer uploads it afresh. The exporter tells Unreal to free a
// disposed material, so it must send the description again on the next use. It used to keep the description it had
// sent and skip the send, so Unreal drew the object with no material record: PrepViz's floor dots (a PointsMaterial
// disposed while still on screen) lost their size and drew as 50 cm discs instead of 6 cm dots.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime, moduleThreeUrl} from './load-runtime.mjs';
import {recordingHost} from './scene-churn-scenes.mjs';

const THREE = await import(moduleThreeUrl);
const camera = new THREE.PerspectiveCamera(50, 1.5, 0.1, 100);
camera.position.set(0, 2, 8); camera.lookAt(0, 0, 0);

async function exporter() {
  const {host, rec} = recordingHost();
  // As the Unreal mirror does: a released material is gone until it is described again.
  host.sink.releaseMaterial = id => rec.materials.delete(id);
  const x = await loadRuntime('../../Tests/unit/scene-churn-fixture.ts', host, moduleThreeUrl);
  const frame = scene => { x.lastFrame.scene = scene; x.lastFrame.camera = camera; x.exportFrame(); };
  return {rec, frame};
}

function dotField() {
  const scene = new THREE.Scene();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 1], 3));
  const material = new THREE.PointsMaterial({size: 0.1143, sizeAttenuation: true, transparent: true, depthWrite: false});
  scene.add(new THREE.Points(geometry, material));
  return {scene, material};
}

test('a material disposed while still drawn is described to Unreal again', async () => {
  const {rec, frame} = await exporter();
  const {scene, material} = dotField();
  frame(scene);
  assert.equal(rec.materials.size, 1);
  const [id, json] = [...rec.materials][0];
  assert.equal(JSON.parse(json).size, 0.1143);
  for (let cycle = 0; cycle < 3; cycle++) {
    material.dispose();
    assert.equal(rec.materials.has(id), false, 'dispose releases the Unreal copy');
    frame(scene);
    assert.equal(rec.materials.get(id), json, `cycle ${cycle}: the next frame sends the same description again`);
  }
});

test('repeated dispose and reuse adds one dispose listener, not one per cycle', async () => {
  const {frame} = await exporter();
  const {scene, material} = dotField();
  frame(scene);
  const listeners = () => material._listeners?.dispose?.length ?? 0;
  const first = listeners();
  for (let cycle = 0; cycle < 5; cycle++) { material.dispose(); frame(scene); }
  assert.equal(listeners(), first);
});
