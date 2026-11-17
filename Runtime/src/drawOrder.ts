/** three.js draw order, as far as Unreal can follow it (sceneExport.ts sends it, JsgbDrawOrder.cpp applies it).
 *
 *  ORDER. WebGLRenderer draws its opaque list, then its transparent list, each sorted by group order (the renderOrder of
 *  the nearest enclosing Group), then renderOrder, then distance. Unreal sorts its translucent surfaces by a sort
 *  priority, then distance. Without the priority, two see-through surfaces at the same place (a mark's white outline
 *  and its fill, renderOrder 976 and 977) tie on distance, and Unreal picks either one from frame to frame: the mark
 *  flickers. Each object gets a priority from the rank of its (list, group order, renderOrder) key among this frame's
 *  keys, so the order is three's and the numbers stay small. A plain transparent object ranks 0, the default.
 *
 *  DRAW THROUGH. depthFunc AlwaysDepth passes the depth test everywhere, like depthTest false (PrepViz draws its
 *  movement paths, cue marks and plates this way so they show through walls). The mirror draws such a surface, and a
 *  see-through one with depthTest false, without the depth test.
 *
 *  BACKDROP. A surface three paints first, without the depth test and without writing depth (a sky dome riding the
 *  camera), sits under everything drawn after it whatever its distance. Unreal's see-through surfaces always test
 *  against the opaque depth, so a 100 m dome hid a sun disc 400 m out and the ground past 100 m. Scaled up about the
 *  camera it covers the same pixels (a perspective view cannot tell a scaled-about-the-eye shape from the original)
 *  and lies behind anything a scene holds. */
import * as THREE from 'three-real';

type Obj = THREE.Object3D & {material?: THREE.Material | THREE.Material[]};

/** How far a backdrop is pushed out: scaled about the camera by this much (a 100 m dome lies 100 km away). */
export const BACKDROP_SCALE = 1000;

/** three's opaque list (0), transmissive list (1) or transparent list (2) for a material. */
export const listOf = (m: THREE.Material | undefined) => !m ? 0 : m.transparent ? 2 : ((m as THREE.MeshPhysicalMaterial).transmission ?? 0) > 0 ? 1 : 0;

/** The group order three gives an object: the renderOrder of the nearest Group above it (0 when there is none). */
export function groupOrderOf(o: THREE.Object3D): number {
  for (let p = o.parent; p; p = p.parent) if ((p as THREE.Group).isGroup) return p.renderOrder || 0;
  return 0;
}

/** Passes the depth test at every pixel: depthTest false, or a depthFunc of AlwaysDepth. */
export const drawsThrough = (m: THREE.Material) => m.depthTest === false || m.depthFunc === THREE.AlwaysDepth;

/** Drawn first, opaque, writing no depth and testing none: a backdrop (see the header). */
export const isBackdrop = (m: THREE.Material | undefined) => !!m && !m.transparent && m.depthWrite === false && m.depthTest === false
  && m.blending === THREE.NormalBlending;

const eye = new THREE.Vector3(), scaled = new THREE.Matrix4(), about = new THREE.Matrix4();
let perspective = false;
/** The camera the next objects are drawn from (the view's, or a capture's). */
export function setDrawEye(cam: THREE.Camera) { cam.getWorldPosition(eye); perspective = !!(cam as THREE.PerspectiveCamera).isPerspectiveCamera; }

/** The world matrix a backdrop is sent with: scaled about the camera by BACKDROP_SCALE. Others keep their own, and so
 *  does a backdrop under an orthographic camera, whose picture does change with the scale. */
export function backdropMatrix(o: THREE.Object3D, m: THREE.Material | undefined): THREE.Matrix4 {
  if (!perspective || !isBackdrop(m)) return o.matrixWorld;
  const k = BACKDROP_SCALE;
  // T(eye) * S(k) * T(-eye) * matrixWorld
  about.makeScale(k, k, k).setPosition(eye.x * (1 - k), eye.y * (1 - k), eye.z * (1 - k));
  return scaled.multiplyMatrices(about, o.matrixWorld);
}

type Key = [number, number, number];
const frameKeys = new Map<number, Key>();
const sent = new Map<number, number>();
const BASE: Key = [2, 0, 0];
const compare = (a: Key, b: Key) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** An object drawn this frame, by the id its record carries. Only surfaces Unreal draws see-through take a priority:
 *  an opaque one that writes depth with normal blending stays opaque there, and sorting does not reach it. Lines
 *  (every: true) all take one, since Unreal draws every line object in one list in this order. */
export function noteDrawOrder(id: number, o: Obj, every = false) {
  const m = Array.isArray(o.material) ? o.material[0] : o.material;
  if (!m || (!every && !m.transparent && m.depthWrite !== false && m.blending === THREE.NormalBlending && listOf(m) === 0)) return;
  frameKeys.set(id, [listOf(m), groupOrderOf(o), o.renderOrder || 0]);
}

/** The priority of each key among the given ones: its rank, counted from the plain transparent key. */
export function priorities(keys: Iterable<Key>): Map<string, number> {
  const distinct = new Map<string, Key>([[BASE.join(','), BASE]]);
  for (const k of keys) distinct.set(k.join(','), k);
  const sorted = [...distinct.values()].sort(compare);
  const base = sorted.findIndex(k => compare(k, BASE) === 0);
  return new Map(sorted.map((k, i) => [k.join(','), i - base]));
}

/** End of a frame: an 'order' event for each object whose priority changed. */
export function flushDrawOrders(emit: (event: {kind: 'order'; id: number; priority: number}) => void) {
  if (!frameKeys.size) return;
  const rank = priorities(frameKeys.values());
  for (const [id, key] of frameKeys) {
    const priority = rank.get(key.join(',')) ?? 0;
    if ((sent.get(id) ?? 0) === priority) continue;
    if (priority === 0) sent.delete(id); else sent.set(id, priority);
    emit({kind: 'order', id, priority});
  }
  frameKeys.clear();
}
