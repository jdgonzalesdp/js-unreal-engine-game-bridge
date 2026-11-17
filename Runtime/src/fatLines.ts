import * as THREE from 'three-real';

/** Line2 and LineSegments2 (three's fat lines) are meshes of one quad per segment, placed by instanceStart and
 *  instanceEnd. Unreal draws them as ordinary segments (sceneExport.ts emitFatLine) from a stand-in geometry of
 *  segment end points, one per dash when the LineMaterial is dashed.
 *
 *  Each line object keeps one stand-in, and its arrays are written in place, so the exporter sends it again only when
 *  the segments really moved, under the same id. Before, the stand-in was kept per source geometry and made anew on
 *  every change: a line rebuilt each frame (PrepViz rebuilds about 17 while an object is dragged) went to Unreal as a
 *  new geometry each frame, the old ones kept there until garbage collection, and a line whose points were set again
 *  with setPositions (which makes new buffers that start at version 0) never moved in Unreal. */

type Attr = THREE.InterleavedBufferAttribute;
type LineMat = THREE.Material & {dashed?: boolean; dashSize?: number; gapSize?: number; dashScale?: number};
type StandIn = {geometry: THREE.BufferGeometry; sig: unknown[]; empty: boolean; watched: WeakSet<object>};
const standIns = new WeakMap<THREE.Object3D, StandIn>();

/** The stand-in to draw for a fat line, or null when it has no segment to show (no points, or dashes that leave
 *  nothing, as three draws nothing there). */
export function fatLineGeometry(o: THREE.Mesh, lm: LineMat): THREE.BufferGeometry | null {
  const src = o.geometry;
  const a = src?.attributes as unknown as Record<string, Attr | undefined>;
  const start = a?.instanceStart, end = a?.instanceEnd;
  if (!start || !end) return null;
  const cs = a.instanceColorStart, ce = a.instanceColorEnd, ds = a.instanceDistanceStart, de = a.instanceDistanceEnd;
  const instanced = (src as THREE.InstancedBufferGeometry).instanceCount;
  const count = Math.min(start.count, Number.isFinite(instanced) ? instanced : start.count);
  const dashed = !!lm.dashed && !!ds && !!de;
  // The buffers themselves count, not only their versions: setPositions and computeLineDistances make new ones.
  const sig = [start.data, start.data.version, end.data, cs?.data, cs?.data.version, ce?.data, ds?.data, ds?.data.version, de?.data, count,
    dashed, dashed ? lm.dashSize : 0, dashed ? lm.gapSize : 0, dashed ? lm.dashScale : 0];
  let s = standIns.get(o);
  if (!s) { s = {geometry: new THREE.BufferGeometry(), sig: [], empty: true, watched: new WeakSet()}; standIns.set(o, s); }
  watchDispose(o, src, s);
  if (!sameSig(s.sig, sig)) {
    s.sig = sig;
    const seg = segments(start, end, cs && ce ? [cs, ce] : null, count);
    const out = dashed ? dashes(seg, ds!, de!, count, lm.dashSize ?? 1, lm.gapSize ?? 1, lm.dashScale ?? 1) ?? seg : seg;
    s.empty = out.pos.length === 0;
    write(s.geometry, 'position', out.pos);
    if (out.col) write(s.geometry, 'color', out.col); else if (s.geometry.attributes.color) s.geometry.deleteAttribute('color');
  }
  return s.empty ? null : s.geometry;
}

const sameSig = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** An unmounted line (its geometry disposed while out of the scene) frees its stand-in, and with it the Unreal copy. */
function watchDispose(o: THREE.Object3D, src: THREE.BufferGeometry, s: StandIn) {
  if (s.watched.has(src)) return;
  s.watched.add(src);
  const gone = () => { src.removeEventListener('dispose', gone); if (!o.parent && standIns.get(o) === s) { standIns.delete(o); s.geometry.dispose(); } };
  src.addEventListener('dispose', gone);
}

type Arrays = {pos: Float32Array; col: Float32Array | null};
function segments(start: Attr, end: Attr, colors: [Attr, Attr] | null, count: number): Arrays {
  const pos = new Float32Array(count * 6), col = colors ? new Float32Array(count * 6) : null;
  for (let i = 0, k = 0; i < count; i++, k += 6) {
    pos[k] = start.getX(i); pos[k + 1] = start.getY(i); pos[k + 2] = start.getZ(i);
    pos[k + 3] = end.getX(i); pos[k + 4] = end.getY(i); pos[k + 5] = end.getZ(i);
    if (col) {
      const [cs, ce] = colors!;
      col[k] = cs.getX(i); col[k + 1] = cs.getY(i); col[k + 2] = cs.getZ(i); col[k + 3] = ce.getX(i); col[k + 4] = ce.getY(i); col[k + 5] = ce.getZ(i);
    }
  }
  return {pos, col};
}

/** One segment per dash, as three's shader keeps the part of each segment where (scale x distance) mod (dash + gap) <
 *  dash. The same arithmetic as sceneExport.ts dashedGeometry, so a dashed line looks as it did. Null when no dash is
 *  left. */
function dashes(seg: Arrays, ds: Attr, de: Attr, count: number, dash: number, gap: number, scale: number): Arrays | null {
  if (dash <= 0) return seg;
  const period = dash + gap, pos: number[] = [], col: number[] = [];
  const p = seg.pos, c = seg.col, dist = new Float32Array(2);
  for (let i = 0; i < count; i++) {
    dist[0] = ds.getX(i); dist[1] = de.getX(i);
    const da = dist[0] * scale, db = dist[1] * scale;
    if (!(db > da)) continue;
    const a = i * 6, b = a + 3;
    for (let s = Math.floor(da / period) * period; s < db; s += period) {
      const t0 = (Math.max(s, da) - da) / (db - da), t1 = (Math.min(s + dash, db) - da) / (db - da);
      if (t1 <= t0) continue;
      for (const t of [t0, t1]) {
        pos.push(p[a] + (p[b] - p[a]) * t, p[a + 1] + (p[b + 1] - p[a + 1]) * t, p[a + 2] + (p[b + 2] - p[a + 2]) * t);
        if (c) for (let j = 0; j < 3; j++) col.push(c[a + j] + (c[b + j] - c[a + j]) * t);
      }
    }
  }
  return pos.length ? {pos: new Float32Array(pos), col: c ? new Float32Array(col) : null} : null;
}

/** Writes values into the stand-in's attribute: in place when the length is the same (marked changed only when a value
 *  differs), or as a new attribute when it is not. */
function write(g: THREE.BufferGeometry, name: string, values: Float32Array) {
  const attr = g.attributes[name] as THREE.BufferAttribute | undefined;
  if (attr && attr.array.length === values.length) {
    const arr = attr.array as Float32Array;
    for (let i = 0; i < values.length; i++) if (arr[i] !== values[i] && !(arr[i] !== arr[i] && values[i] !== values[i])) { arr.set(values); attr.needsUpdate = true; return; }
    return;
  }
  g.setAttribute(name, new THREE.BufferAttribute(values, 3));
}
