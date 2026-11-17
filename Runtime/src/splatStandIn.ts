import * as THREE from 'three-real';
import {host} from './host';
import {lastFrame} from './renderer';
import {frameCount} from './frameCount';
import {splatMaterial} from './splatShader';

/** Gaussian splats drawn by Spark (@sparkjsdev/spark). Spark draws every splat in a scene through one SparkRenderer,
 *  a Mesh it puts in the scene: each frame it runs the splats' generator programs into integer render targets on the
 *  GPU, reads their depths back, sorts them on a worker and draws instanced quads that sample those targets. None of
 *  that reaches the mirror (it would need GPU compute on unsigned integer textures), so the bridge draws the splats
 *  itself: where the game's scene holds a Spark renderer, each splat it would draw goes to Unreal as an instanced mesh
 *  of camera-facing quads, one instance per splat (splatShader.ts), and the renderer itself is never drawn or run.
 *
 *  The splats are read once from the splat's own PackedSplats (forEachSplat, so any encoding Spark reads works) and
 *  only again when its data changes. The splat object's world matrix places the whole instanced mesh, so moving a
 *  splat sends one matrix, not its millions of points. Not carried over: view-dependent colour (spherical harmonics),
 *  SplatEdits and generator modifiers; a splat draws its base colour. */

type Obj = Record<string, any>;
type StandIn = {mesh: THREE.InstancedMesh; array: unknown; count: number};

const standIns = new WeakMap<object, StandIn>();

/** A Spark renderer: a Mesh that gathers the scene's splats (compileScene) and draws them as instanced quads. */
export function isSplatRenderer(o: unknown): boolean {
  const r = o as Obj;
  return !!r?.isMesh && typeof r.compileScene === 'function' && !!r.geometry?.isInstancedBufferGeometry;
}

/** A splat with data in memory: a Spark SplatMesh (or any generator carrying PackedSplats). */
export function packedSplatsOf(o: unknown): Obj | null {
  const p = (o as Obj)?.packedSplats;
  return p && typeof p.forEachSplat === 'function' && p.packedArray && p.numSplats > 0 ? p : null;
}

/** The stand-ins of the splats a Spark renderer would draw this frame; null when `o` is not a Spark renderer. */
export function splatStandIns(o: THREE.Object3D): THREE.InstancedMesh[] | null {
  if (!isSplatRenderer(o)) return null;
  let top: THREE.Object3D = o; while (top.parent) top = top.parent;
  let visible: THREE.Object3D[] = [];
  try {
    // The renderer's own gathering, with whatever the game adds to it (PrepViz draws one copy of each splat per view).
    visible = ((o as unknown as Obj).compileScene(top)?.visibleGenerators ?? []) as THREE.Object3D[];
  } catch (error) { warnOnce('gather', `splats: the Spark renderer could not gather its splats: ${error}`); return []; }
  const out: THREE.InstancedMesh[] = [];
  const size = viewportSize();
  for (const g of visible) {
    const mesh = standInFor(g); if (!mesh) continue;
    mesh.matrixWorld.copy(g.matrixWorld);
    const u = (mesh.material as THREE.ShaderMaterial).uniforms, own = g as unknown as Obj;
    u.splatOpacity.value = typeof own.opacity === 'number' ? own.opacity : 1;
    if (own.recolor?.isColor) u.splatTint.value.copy(own.recolor);
    u.splatViewport.value.copy(size);
    u.splatFrame.value = frameCount.animation % 64;
    u.splatLinear.value = lastFrame.linear ? 1 : 0;
    out.push(mesh);
  }
  return out;
}

const viewport = new THREE.Vector2();
function viewportSize(): THREE.Vector2 {
  const r = lastFrame.renderer as Obj | null;
  try {
    if (r?.getDrawingBufferSize) r.getDrawingBufferSize(viewport);
    else if (r?.getSize) { r.getSize(viewport); viewport.multiplyScalar(r.getPixelRatio?.() ?? 1); }
  } catch { /* the default below */ }
  if (!(viewport.x > 0 && viewport.y > 0)) viewport.set(1920, 1080);
  return viewport;
}

function standInFor(g: THREE.Object3D): THREE.InstancedMesh | null {
  const packed = packedSplatsOf(g);
  if (!packed) return null;
  let s = standIns.get(g);
  if (s && s.array === packed.packedArray && s.count === packed.numSplats) return s.mesh;
  const started = host.now();
  const mesh = buildStandIn(packed, s?.mesh ?? null);
  if (!s) { s = {mesh, array: null, count: 0}; standIns.set(g, s); }
  s.mesh = mesh; s.array = packed.packedArray; s.count = packed.numSplats;
  host.log('log', `splats: ${packed.numSplats} splats of "${g.name || g.uuid}" sent to Unreal as instances in ${Math.round(host.now() - started)} ms`);
  return mesh;
}

/** A quad from -1 to 1 in x and y: each vertex names its corner of the splat's ellipse. */
function quad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/** One instance per splat: its matrix is the splat's frame (splatFrame), its colour the splat's, its alpha splatAlpha. */
export function buildStandIn(packed: Obj, previous: THREE.InstancedMesh | null): THREE.InstancedMesh {
  const n = packed.numSplats as number;
  const matrices = new Float32Array(n * 16), colours = new Float32Array(n * 3), alphas = new Float32Array(n);
  packed.forEachSplat((i: number, centre: THREE.Vector3, scales: THREE.Vector3, q: THREE.Quaternion, opacity: number, colour: THREE.Color) => {
    splatFrame(centre, scales, q, matrices, i * 16);
    colours[i * 3] = colour.r; colours[i * 3 + 1] = colour.g; colours[i * 3 + 2] = colour.b;
    alphas[i] = opacity;
  });
  const geometry = quad();
  geometry.setAttribute('splatAlpha', new THREE.InstancedBufferAttribute(alphas, 1));
  const mesh = new THREE.InstancedMesh(geometry, (previous?.material as THREE.ShaderMaterial | undefined) ?? splatMaterial(), n);
  mesh.instanceMatrix = new THREE.InstancedBufferAttribute(matrices, 16);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(colours, 3);
  mesh.count = n;
  mesh.name = 'jsgb-splats';
  mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  previous?.geometry.dispose();
  return mesh;
}

/** A splat's frame as a column-major matrix at `out[at]`: its centre, and its rotation's axes scaled by its standard
 *  deviations. The covariance is the frame's axes times their transpose, which no reordering or sign of the axes
 *  changes, so they are put longest first and the frame kept right-handed: the quad lies across the splat's two widest
 *  axes, and Unreal takes the frame as an ordinary rotation and scale. A vanishing axis keeps a thousandth of the
 *  longest, so Unreal can still invert the frame (it does, per pixel, to read the quad's corner). No allocation: it
 *  runs once per splat, millions of times for a large capture. */
export function splatFrame(centre: THREE.Vector3, scales: THREE.Vector3, q: THREE.Quaternion, out: Float32Array, at: number) {
  const len = Math.hypot(q.x, q.y, q.z, q.w) || 1, x = q.x / len, y = q.y / len, z = q.z / len, w = q.w / len;
  rot[0] = 1 - 2 * (y * y + z * z); rot[1] = 2 * (x * y + w * z); rot[2] = 2 * (x * z - w * y);
  rot[3] = 2 * (x * y - w * z); rot[4] = 1 - 2 * (x * x + z * z); rot[5] = 2 * (y * z + w * x);
  rot[6] = 2 * (x * z + w * y); rot[7] = 2 * (y * z - w * x); rot[8] = 1 - 2 * (x * x + y * y);
  sc[0] = scales.x; sc[1] = scales.y; sc[2] = scales.z;
  // Longest first; an odd reordering of a rotation's axes flips its handedness, undone by turning the last axis.
  let i0 = 0, i1 = 1, i2 = 2, t: number;
  if (sc[i1] > sc[i0]) { t = i0; i0 = i1; i1 = t; }
  if (sc[i2] > sc[i1]) { t = i1; i1 = i2; i2 = t; }
  if (sc[i1] > sc[i0]) { t = i0; i0 = i1; i1 = t; }
  const odd = !((i0 === 0 && i1 === 1) || (i0 === 1 && i1 === 2) || (i0 === 2 && i1 === 0));
  const floor = Math.max(sc[i0], 1e-7) * 1e-3;
  pick[0] = i0; pick[1] = i1; pick[2] = i2;
  for (let c = 0; c < 3; c++) {
    const k = pick[c], f = Math.max(sc[k], floor) * (c === 2 && odd ? -1 : 1);
    out[at + c * 4] = rot[k * 3] * f; out[at + c * 4 + 1] = rot[k * 3 + 1] * f; out[at + c * 4 + 2] = rot[k * 3 + 2] * f; out[at + c * 4 + 3] = 0;
  }
  out[at + 12] = centre.x; out[at + 13] = centre.y; out[at + 14] = centre.z; out[at + 15] = 1;
}
const rot = new Float64Array(9), sc = new Float64Array(3), pick = new Int32Array(3);

const warned = new Set<string>();
function warnOnce(key: string, text: string) { if (!warned.has(key)) { warned.add(key); host.log('warn', text); } }
