import * as THREE from 'three-real';

/** Skinned and morph-target meshes the scene exporter draws as ordinary Unreal meshes. The vertices are what three's
 *  vertex shader would make of them (morph targets first, then the bones, as morphtarget_vertex, skinning_vertex and
 *  skinnormal_vertex do), written into a copy of the geometry that is sent like any other.
 *
 *  The copy is computed again only when something that moves the vertices changed:
 *  - the skin matrices in the mesh's own space (bindMatrixInverse * bone matrix * bindMatrix), so a character that is
 *    carried or turned whole, bones and all, keeps its geometry and only its transform goes out;
 *  - the morph influences;
 *  - the source positions or normals (a game that bends a mesh on the CPU while it also has morph targets: PrepViz
 *    bends a sculpted head's neck to the body's pose and opens and closes its eyelids with morphs).
 *  A source that changes shape (attributes, index or morph targets swapped) gets a new copy, and the old one is
 *  disposed so Unreal lets its mesh go. */

type Attr = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
type Copy = {
  geometry: THREE.BufferGeometry;
  /** The source objects the copy was made from: the source, its attributes, index and morph arrays. */
  refs: unknown[];
  /** Versions of the source position, normal and morph attributes when the copy was last deformed. */
  versions: number[];
  /** Per joint, the 12 affine values of the skin matrix last applied; null for a mesh without bones. */
  skin: Float64Array | null;
  /** The largest coordinate of the source positions: the scale of a joint's translation. */
  extent: number;
  /** The morph influences last applied, as the game set them. */
  influences: Float64Array;
};
const copies = new WeakMap<THREE.Mesh, Copy>();
let live = 0;

const DEFORMED = new Set(['position', 'normal', 'skinIndex', 'skinWeight']);
const ownerOf = (a: Attr) => ((a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute ? (a as THREE.InterleavedBufferAttribute).data : a) as {version: number};

/** The attribute's values as a flat array of `size` per vertex: its own array when that is already so, else a float
 *  copy (interleaved, normalized or quantized data), made again when the attribute's version moves. */
const flat = new WeakMap<object, {version: number; array: Float32Array}>();
function valuesOf(a: Attr, size: number): ArrayLike<number> {
  const interleaved = (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute;
  if (!interleaved && !a.normalized && a.itemSize === size) return (a as THREE.BufferAttribute).array;
  const version = ownerOf(a).version, had = flat.get(a);
  if (had && had.version === version) return had.array;
  const n = a.count, out = new Float32Array(n * size);
  for (let i = 0; i < n; i++) {
    out[i * size] = a.getX(i);
    if (size > 1) out[i * size + 1] = a.itemSize > 1 ? a.getY(i) : 0;
    if (size > 2) out[i * size + 2] = a.itemSize > 2 ? a.getZ(i) : 0;
    if (size > 3) out[i * size + 3] = a.itemSize > 3 ? a.getW(i) : 0;
  }
  flat.set(a, {version, array: out});
  return out;
}

function refsOf(o: THREE.Mesh, src: THREE.BufferGeometry, into: unknown[]): unknown[] {
  into.length = 0;
  into.push(src, src.index, src.morphTargetsRelative, (o as THREE.SkinnedMesh).isSkinnedMesh ? (o as THREE.SkinnedMesh).skeleton : null);
  for (const name in src.attributes) into.push(name, src.attributes[name]);
  const mp = src.morphAttributes.position, mn = src.morphAttributes.normal;
  into.push(mp?.length ?? 0, mn?.length ?? 0);
  if (mp) for (const a of mp) into.push(a);
  if (mn) for (const a of mn) into.push(a);
  return into;
}
const sameRefs = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function newCopy(src: THREE.BufferGeometry, refs: unknown[]): Copy {
  const g = new THREE.BufferGeometry();
  g.name = src.name;
  for (const name in src.attributes) if (!DEFORMED.has(name)) g.setAttribute(name, src.attributes[name]);
  const n = src.attributes.position.count;
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  if (src.index) g.setIndex(src.index);
  const p = valuesOf(src.attributes.position, 3);
  let extent = 0;
  for (let i = 0; i < n * 3; i++) extent = Math.max(extent, Math.abs(p[i]));
  return {geometry: g, refs: refs.slice(), versions: [], skin: null, extent, influences: new Float64Array(0)};
}

const identity = new THREE.Matrix4(), skinScratch = new THREE.Matrix4();
/** The skin matrices in the mesh's own space, 12 affine values per joint, in double precision from the bones' world
 *  matrices (as Skeleton.update does, a missing bone counting as the identity), so a mesh carried whole computes the
 *  same values again to within rounding. */
function skinMatrices(o: THREE.SkinnedMesh, out: Float64Array | null): Float64Array {
  // The bone matrices too, as WebGLRenderer updates them for each skinned mesh it draws.
  o.skeleton.update();
  const {bones, boneInverses} = o.skeleton;
  const joints = bones.length;
  const m = out && out.length === joints * 12 ? out : new Float64Array(joints * 12);
  for (let j = 0; j < joints; j++) {
    skinScratch.multiplyMatrices(o.bindMatrixInverse, bones[j] ? bones[j].matrixWorld : identity);
    skinScratch.multiply(boneInverses[j] ?? identity).multiply(o.bindMatrix);
    const e = skinScratch.elements, k = j * 12;
    m[k] = e[0]; m[k + 1] = e[1]; m[k + 2] = e[2]; m[k + 3] = e[4]; m[k + 4] = e[5]; m[k + 5] = e[6];
    m[k + 6] = e[8]; m[k + 7] = e[9]; m[k + 8] = e[10]; m[k + 9] = e[12]; m[k + 10] = e[13]; m[k + 11] = e[14];
  }
  return m;
}

// Rounding: a change under a millionth of the mesh's size (a micrometre on a body two metres tall) is not a pose change.
const SKIN_EPSILON = 1e-6;
function skinMoved(last: Float64Array | null, next: Float64Array, extent: number): boolean {
  if (!last || last.length !== next.length) return true;
  for (let i = 0; i < next.length; i++) {
    const scale = i % 12 >= 9 ? extent : 1;
    if (Math.abs(next[i] - last[i]) > SKIN_EPSILON * (scale + Math.abs(next[i]))) return true;
  }
  return false;
}

let skinNext: Float64Array | null = null;
const refScratch: unknown[] = [];

/** The geometry to draw for a skinned or morphed mesh, or null for any other (the caller draws its own geometry). */
export function deformedCopy(o: THREE.Mesh): THREE.BufferGeometry | null {
  const src = o.geometry, sk = (o as THREE.SkinnedMesh).isSkinnedMesh ? (o as THREE.SkinnedMesh).skeleton : null;
  const skinned = !!sk && !!src?.attributes.skinIndex && !!src.attributes.skinWeight;
  const mp = src?.morphAttributes.position, own = o.morphTargetInfluences;
  const targets = mp && own ? Math.min(mp.length, own.length) : 0;
  if ((!skinned && !targets) || !src?.attributes.position) {
    if (live) { const old = copies.get(o); if (old) { copies.delete(o); live--; old.geometry.dispose(); } }
    // A skinned mesh without skin weights draws as it is, rather than going to a path that needs them.
    return sk && src ? src : null;
  }
  let c = copies.get(o);
  const refs = refsOf(o, src, refScratch);
  if (!c || !sameRefs(c.refs, refs)) {
    if (c) c.geometry.dispose(); else live++;
    c = newCopy(src, refs);
    copies.set(o, c);
  }
  c.geometry.groups = src.groups;
  c.geometry.drawRange = src.drawRange;

  // What moves the vertices this frame.
  const pos = src.attributes.position, nrm = src.attributes.normal as Attr | undefined, mn = src.morphAttributes.normal;
  let moved = c.versions.length === 0;
  const versions = [ownerOf(pos).version, nrm ? ownerOf(nrm).version : -1];
  for (let t = 0; t < targets; t++) versions.push(ownerOf(mp![t]).version, mn?.[t] ? ownerOf(mn[t]).version : -1);
  if (!moved && !sameRefs(c.versions, versions)) moved = true;
  if (skinned) { skinNext = skinMatrices(o as THREE.SkinnedMesh, skinNext); if (skinMoved(c.skin, skinNext, c.extent)) moved = true; }
  if (c.influences.length !== targets) moved = true;
  else for (let t = 0; t < targets; t++) if (c.influences[t] !== own![t]) { moved = true; break; }
  if (!moved) return c.geometry;

  c.versions = versions;
  if (skinned) { const keep = c.skin; c.skin = skinNext; skinNext = keep; }
  if (c.influences.length !== targets) c.influences = new Float64Array(targets);
  for (let t = 0; t < targets; t++) c.influences[t] = own![t];
  deform(c, src, skinned, targets);
  return c.geometry;
}

/** Writes the copy's positions and normals: morph targets, then the blended skin matrix of each vertex. */
function deform(c: Copy, src: THREE.BufferGeometry, skinned: boolean, targets: number) {
  const outP = c.geometry.attributes.position as THREE.BufferAttribute, outN = c.geometry.attributes.normal as THREE.BufferAttribute;
  const P = outP.array as Float32Array, N = outN.array as Float32Array;
  const n = Math.min(src.attributes.position.count, P.length / 3);
  const base = valuesOf(src.attributes.position, 3);
  const baseN = src.attributes.normal ? valuesOf(src.attributes.normal, 3) : null;
  // Morph targets that count this frame, as three's shader skips a zero influence.
  const relative = src.morphTargetsRelative, mp = src.morphAttributes.position, mn = src.morphAttributes.normal;
  const active: {w: number; p: ArrayLike<number>; n: ArrayLike<number> | null}[] = [];
  for (let t = 0; t < targets; t++) {
    const w = c.influences[t];
    if (w) active.push({w, p: valuesOf(mp![t], 3), n: mn?.[t] ? valuesOf(mn[t], 3) : null});
  }
  const S = c.skin, joints = S ? S.length / 12 : 0;
  const J = skinned ? valuesOf(src.attributes.skinIndex, 4) : null, W = skinned ? valuesOf(src.attributes.skinWeight, 4) : null;
  for (let i = 0, k = 0; i < n; i++, k += 3) {
    let px = base[k], py = base[k + 1], pz = base[k + 2];
    let nx = baseN ? baseN[k] : 0, ny = baseN ? baseN[k + 1] : 0, nz = baseN ? baseN[k + 2] : 0;
    for (let a = 0; a < active.length; a++) {
      const {w, p, n: dn} = active[a];
      if (relative) { px += w * p[k]; py += w * p[k + 1]; pz += w * p[k + 2]; }
      else { px += w * (p[k] - base[k]); py += w * (p[k + 1] - base[k + 1]); pz += w * (p[k + 2] - base[k + 2]); }
      if (dn && baseN) {
        if (relative) { nx += w * dn[k]; ny += w * dn[k + 1]; nz += w * dn[k + 2]; }
        else { nx += w * (dn[k] - baseN[k]); ny += w * (dn[k + 1] - baseN[k + 1]); nz += w * (dn[k + 2] - baseN[k + 2]); }
      }
    }
    if (S) {
      let m0 = 0, m1 = 0, m2 = 0, m3 = 0, m4 = 0, m5 = 0, m6 = 0, m7 = 0, m8 = 0, m9 = 0, m10 = 0, m11 = 0;
      for (let q = i * 4, e = q + 4; q < e; q++) {
        const w = W![q], j = J![q];
        if (!w || j >= joints) continue;
        const o = j * 12;
        m0 += w * S[o]; m1 += w * S[o + 1]; m2 += w * S[o + 2]; m3 += w * S[o + 3]; m4 += w * S[o + 4]; m5 += w * S[o + 5];
        m6 += w * S[o + 6]; m7 += w * S[o + 7]; m8 += w * S[o + 8]; m9 += w * S[o + 9]; m10 += w * S[o + 10]; m11 += w * S[o + 11];
      }
      const x = px, y = py, z = pz;
      px = m0 * x + m3 * y + m6 * z + m9; py = m1 * x + m4 * y + m7 * z + m10; pz = m2 * x + m5 * y + m8 * z + m11;
      const a = nx, b = ny, d = nz;
      nx = m0 * a + m3 * b + m6 * d; ny = m1 * a + m4 * b + m7 * d; nz = m2 * a + m5 * b + m8 * d;
    }
    P[k] = px; P[k + 1] = py; P[k + 2] = pz;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 0) { N[k] = nx / len; N[k + 1] = ny / len; N[k + 2] = nz / len; } else { N[k] = 0; N[k + 1] = 1; N[k + 2] = 0; }
  }
  outP.needsUpdate = true;
  // A source without normals: three would light it with normals it computes from the drawn triangles.
  if (baseN) outN.needsUpdate = true; else c.geometry.computeVertexNormals();
}
