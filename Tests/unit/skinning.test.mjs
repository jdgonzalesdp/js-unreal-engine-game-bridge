// Skinned and morphed meshes drawn as ordinary meshes: the copy holds what three's vertex shader would draw, and is
// computed again only when the pose, the morphs or the source vertices change.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three-real';
import {deformedCopy} from '../../Runtime/src/skinning.ts';

/** A 2 m column skinned to a hip and a spine bone, blended through the middle, with one morph target. */
function rig({relative = true, quantized = false} = {}) {
  const g = new THREE.CylinderGeometry(0.2, 0.2, 2, 8, 8);
  g.translate(0, 1, 0);
  const pos = g.attributes.position, n = pos.count;
  const index = [], weight = [], morph = [];
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, Math.max(0, (pos.getY(i) - 0.6) / 0.8));
    index.push(0, 1, 0, 0); weight.push(1 - t, t, 0, 0);
    morph.push(...(relative ? [0.05 * pos.getX(i), 0, 0] : [pos.getX(i) * 1.25, pos.getY(i), pos.getZ(i)]));
  }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(index, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weight, 4));
  g.morphAttributes.position = [new THREE.Float32BufferAttribute(morph, 3)];
  g.morphTargetsRelative = relative;
  if (quantized) {
    // KHR_mesh_quantization: normalized int16 positions, the scale on the node.
    const q = new Int16Array(n * 3);
    for (let i = 0; i < n * 3; i++) q[i] = Math.round(pos.array[i] / 2 * 32767);
    g.setAttribute('position', new THREE.BufferAttribute(q, 3, true));
  }
  const hip = new THREE.Bone(), spine = new THREE.Bone();
  spine.position.y = 1; hip.add(spine);
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshStandardMaterial());
  if (quantized) mesh.scale.setScalar(2);
  const root = new THREE.Group(); root.add(hip, mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([hip, spine]));
  mesh.morphTargetInfluences = [0];
  return {root, mesh, hip, spine};
}

/** Positions and normals as three's shader computes them (morphs, then the bones). */
function reference(mesh) {
  const n = mesh.geometry.attributes.position.count, p = new Float32Array(n * 3), nr = new Float32Array(n * 3);
  const v = new THREE.Vector3(), a = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    THREE.Mesh.prototype.getVertexPosition.call(mesh, i, v);
    a.fromBufferAttribute(mesh.geometry.attributes.normal, i).add(v);
    mesh.applyBoneTransform(i, v); mesh.applyBoneTransform(i, a);
    a.sub(v).normalize();
    p.set([v.x, v.y, v.z], i * 3); nr.set([a.x, a.y, a.z], i * 3);
  }
  return {p, nr};
}
const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
function frame(r) { r.root.updateMatrixWorld(true); return deformedCopy(r.mesh); }

test('bones and morphs: the copy matches three\'s own skinning, positions and normals', () => {
  for (const relative of [true, false]) {
    const r = rig({relative});
    r.spine.rotation.z = 0.7; r.hip.rotation.y = 0.3; r.mesh.morphTargetInfluences[0] = 0.6;
    const g = frame(r), want = reference(r.mesh);
    assert.notEqual(g, r.mesh.geometry);
    assert.ok(maxDiff(g.attributes.position.array, want.p) < 1e-5, `positions, relative ${relative}`);
    assert.ok(maxDiff(g.attributes.normal.array, want.nr) < 1e-5, `normals, relative ${relative}`);
    assert.equal(g.index, r.mesh.geometry.index);
    assert.equal(g.attributes.uv, r.mesh.geometry.attributes.uv, 'other attributes are shared');
  }
});

test('quantized positions are read through their normalization', () => {
  const r = rig({quantized: true});
  r.spine.rotation.x = -0.5;
  const g = frame(r), want = reference(r.mesh);
  assert.ok(maxDiff(g.attributes.position.array, want.p) < 1e-4);
});

test('a mesh carried whole keeps its copy; a new pose or morph computes it again', () => {
  const r = rig();
  r.spine.rotation.z = 0.4;
  const g = frame(r), version = g.attributes.position.version;
  assert.equal(frame(r).attributes.position.version, version, 'nothing moved');
  r.root.position.set(250, 3, -40); r.root.rotation.y = 2.1;
  assert.equal(frame(r), g);
  assert.equal(g.attributes.position.version, version, 'carried whole: the same vertices in its own space');
  r.spine.rotation.z = 0.41;
  assert.ok(frame(r).attributes.position.version > version, 'posed');
  const posed = g.attributes.position.version;
  r.mesh.morphTargetInfluences[0] = 0.2;
  assert.ok(frame(r).attributes.position.version > posed, 'morphed');
  assert.ok(maxDiff(g.attributes.position.array, reference(r.mesh).p) < 1e-4);
  const morphed = g.attributes.position.version;
  assert.equal(frame(r).attributes.position.version, morphed, 'an influence that is not a float32 value is still the same influence');
});

test('source vertices rewritten under morph targets are drawn (a head bent on the CPU that also has lid morphs)', () => {
  const g0 = new THREE.BoxGeometry(1, 1, 1);
  g0.morphAttributes.position = [new THREE.Float32BufferAttribute(new Float32Array(g0.attributes.position.count * 3).fill(0.1), 3)];
  g0.morphTargetsRelative = true;
  const mesh = new THREE.Mesh(g0, new THREE.MeshStandardMaterial());
  mesh.morphTargetInfluences = [0.5];
  const g = deformedCopy(mesh);
  assert.ok(Math.abs(g.attributes.position.getX(0) - (g0.attributes.position.getX(0) + 0.05)) < 1e-6);
  g0.attributes.position.setX(0, 3); g0.attributes.position.needsUpdate = true;
  assert.ok(Math.abs(deformedCopy(mesh).attributes.position.getX(0) - 3.05) < 1e-6);
});

test('a source that changes shape gets a new copy; the old one is disposed, as is the copy of a mesh that stops morphing', () => {
  const r = rig();
  const first = frame(r);
  let disposed = 0; first.addEventListener('dispose', () => disposed++);
  r.mesh.geometry.setIndex(new THREE.BufferAttribute(r.mesh.geometry.index.array.slice(0, 30), 1));
  const second = frame(r);
  assert.notEqual(second, first);
  assert.equal(disposed, 1);
  assert.equal(second.index.count, 30);
  let third = 0; second.addEventListener('dispose', () => third++);
  const p = r.mesh.geometry.attributes.position;
  r.mesh.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...p.array, 0, 0, 0]), 3));
  assert.equal(frame(r).attributes.position.count, p.count + 1, 'a new position attribute (more vertices) gets a new copy');
  assert.equal(third, 1);
  const plain = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  plain.morphTargetInfluences = [1];
  plain.geometry.morphAttributes.position = [plain.geometry.attributes.position.clone()];
  const copy = deformedCopy(plain);
  let gone = 0; copy.addEventListener('dispose', () => gone++);
  plain.geometry.morphAttributes = {}; delete plain.morphTargetInfluences;
  assert.equal(deformedCopy(plain), null, 'an ordinary mesh again: the caller draws its own geometry');
  assert.equal(gone, 1);
});

test('a skinned mesh without weights draws its own geometry; other meshes are passed on', () => {
  const m = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  m.bind(new THREE.Skeleton([new THREE.Bone()]));
  assert.equal(deformedCopy(m), m.geometry);
  assert.equal(deformedCopy(new THREE.Mesh(new THREE.BoxGeometry())), null);
});
