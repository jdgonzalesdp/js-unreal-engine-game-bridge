// three.js draw order sent to Unreal (Runtime/src/drawOrder.ts): sort priorities from three's list, group order and
// renderOrder; depthFunc AlwaysDepth as a draw-through; a backdrop sky dome pushed out behind the scene.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three-real';
import * as order from '../../Runtime/src/drawOrder.ts';

const mark = (renderOrder, opts = {}) => {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({transparent: true, ...opts}));
  m.renderOrder = renderOrder;
  return m;
};

test('a mark outline and its fill at one place get distinct priorities in three order', () => {
  const events = [];
  order.noteDrawOrder(1, mark(976)); order.noteDrawOrder(2, mark(977)); order.noteDrawOrder(3, mark(0));
  order.flushDrawOrders(e => events.push(e));
  const p = Object.fromEntries(events.map(e => [e.id, e.priority]));
  assert.equal(p[3], undefined, 'a plain transparent object keeps the default 0 and sends nothing');
  assert.ok(p[1] > 0 && p[2] > p[1], `outline ${p[1]} under fill ${p[2]}`);
  // Nothing changed: nothing is sent again.
  const again = [];
  order.noteDrawOrder(1, mark(976)); order.noteDrawOrder(2, mark(977)); order.noteDrawOrder(3, mark(0));
  order.flushDrawOrders(e => again.push(e));
  assert.deepEqual(again, []);
});

test('the opaque list sorts under the transparent one, and group order outranks renderOrder', () => {
  const sky = mark(-1000, {transparent: false, depthWrite: false, depthTest: false});
  const late = mark(5000, {transparent: false, depthWrite: false});
  const group = new THREE.Group(); group.renderOrder = 10;
  const inGroup = mark(0); group.add(inGroup);
  const rank = order.priorities([[0, 0, -1000], [0, 0, 5000], [2, 0, 10000], [2, 10, 0]]);
  assert.ok(rank.get('0,0,-1000') < rank.get('0,0,5000'));
  assert.ok(rank.get('0,0,5000') < 0, 'an opaque-list object still draws before plain transparent ones');
  assert.ok(rank.get('2,10,0') > rank.get('2,0,10000'), 'group order sorts first');
  assert.equal(order.groupOrderOf(inGroup), 10);
  assert.equal(order.listOf(sky.material), 0);
  assert.equal(order.listOf(late.material), 0);
  // Opaque surfaces that write depth stay opaque in Unreal: no priority to send.
  const events = [];
  order.noteDrawOrder(9, new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  order.flushDrawOrders(e => events.push(e));
  assert.deepEqual(events, []);
});

test('depthFunc AlwaysDepth and depthTest false both draw through', () => {
  assert.equal(order.drawsThrough(new THREE.MeshBasicMaterial({depthFunc: THREE.AlwaysDepth})), true);
  assert.equal(order.drawsThrough(new THREE.MeshBasicMaterial({depthTest: false})), true);
  assert.equal(order.drawsThrough(new THREE.MeshBasicMaterial()), false);
});

test('a backdrop is scaled about the camera, so it covers the same pixels from much further away', () => {
  const dome = new THREE.Mesh(new THREE.SphereGeometry(100), new THREE.ShaderMaterial({depthWrite: false, depthTest: false, side: THREE.BackSide}));
  const cam = new THREE.PerspectiveCamera(50, 1.5, 0.1, 3600);
  cam.position.set(51, 10, -4); cam.lookAt(400, 7, 54); cam.updateMatrixWorld();
  dome.position.copy(cam.position); dome.updateMatrixWorld();
  order.setDrawEye(cam);
  const m = order.backdropMatrix(dome, dome.material);
  const p = new THREE.Vector3(100, 0, 0).applyMatrix4(dome.matrixWorld);
  const q = new THREE.Vector3(100, 0, 0).applyMatrix4(m);
  assert.ok(q.distanceTo(cam.position) > 99000, 'pushed far past anything in the scene');
  const a = p.clone().project(cam), b = q.clone().project(cam);
  assert.ok(Math.abs(a.x - b.x) < 1e-5 && Math.abs(a.y - b.y) < 1e-5, 'same place on screen');
  // An ordinary surface keeps its own matrix.
  const box = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  assert.equal(order.backdropMatrix(box, box.material), box.matrixWorld);
  // An orthographic view would see a scaled backdrop bigger, so it is left alone there.
  order.setDrawEye(new THREE.OrthographicCamera());
  assert.equal(order.backdropMatrix(dome, dome.material), dome.matrixWorld);
});
