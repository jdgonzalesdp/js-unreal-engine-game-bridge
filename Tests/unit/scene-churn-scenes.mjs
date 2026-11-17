// Scenes that change the way a page does every frame without changing what it draws, for scene-export-churn.test.mjs:
// materials set needsUpdate every frame with new hook closures (as react-three-fiber applies props), and fat lines get
// new buffers every frame (setPositions, computeLineDistances, a new LineGeometry). Real changes land on set frames.
// Also the recording host that keeps what Unreal would hold, and the frame resolved against it.
import {createHash} from 'node:crypto';

// A description as the host reads it: the same JSON whatever order its keys were written in (a frame where only uniform
// values moved writes them first).
const sortKeys = v => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v;
const canonical = json => JSON.stringify(sortKeys(JSON.parse(json)));

/** A host whose sink keeps each id's latest geometry bytes and material description, as the Unreal mirror does. */
export function recordingHost() {
  const rec = {geometries: new Map(), materials: new Map(), frame: null, geometrySends: 0, materialSends: 0, logs: []};
  const hash = (...bufs) => { const h = createHash('sha1'); for (const b of bufs) h.update(b ? new Uint8Array(b) : new Uint8Array(0)).update('|'); return h.digest('hex'); };
  const host = {log: (level, text) => rec.logs.push(`${level} ${text}`), registry: '', search: '', now: () => 0, readFile: () => null,
    storage: {load: () => null, save() {}},
    sink: {
      geometry: (id, pos, nrm, uv, col, cs, idx, groups) => { rec.geometrySends++; rec.geometries.set(id, hash(pos, nrm, uv, col, idx) + ` ${cs} ${groups}`); },
      releaseGeometry: id => rec.geometries.delete(id), releaseMaterial() {}, releaseTexture() {},
      material: (id, json) => { rec.materialSends++; rec.materials.set(id, canonical(json)); },
      texture() {}, shader() {}, events() {},
      frame: (floats, count) => { rec.frame = new Float32Array(floats, 0, count).slice(); },
    }};
  return {host, rec};
}

/** The last frame as Unreal would draw it: the header, then each record with its geometry and material ids replaced by
 *  what those ids hold (object ids left out: two exporters number objects differently). */
export function resolveFrame(x, rec) {
  const f = rec.frame, out = [Array.from(f.subarray(0, x.HEADER_FLOATS)).join(',')];
  for (let i = x.HEADER_FLOATS; i < f.length;) {
    const kind = f[i];
    if (kind === x.MESH) {
      const n = f[i + 4], mats = Array.from(f.subarray(i + 5, i + 5 + n), id => rec.materials.get(id));
      out.push(`mesh ${rec.geometries.get(f[i + 2])} flags ${f[i + 3]} ${mats.join(' ')} at ${f.subarray(i + 5 + n, i + 21 + n).join(',')}`);
      i += 21 + n;
    } else if (kind === x.LINES) {
      out.push(`lines ${rec.geometries.get(f[i + 2])} ${rec.materials.get(f[i + 3])} flags ${f[i + 4]} at ${f.subarray(i + 5, i + 21).join(',')}`);
      i += 21;
    } else throw Error(`record kind ${kind} at ${i}`);
  }
  return out;
}

/** Materials that set needsUpdate twice a frame and get new hook closures each frame. Real changes: a colour (frame 3),
 *  a hook uniform's value (4), blending factors (5), a define (6), the fragment source (7), the program key (8).
 *  counts.hook: how often the exporter ran the patched material's hook while counts.on is set. */
export function materialChurn(THREE, counts = {on: false, hook: 0}) {
  const scene = new THREE.Scene(), box = new THREE.BoxGeometry(1, 1, 1);
  const lift = {value: 0.25};
  let version = 'lift-v1';
  const patched = new THREE.MeshStandardMaterial({color: 0x808080, roughness: 0.6});
  const hooks = () => {
    const key = version;
    patched.onBeforeCompile = shader => {
      if (counts.on) counts.hook++;
      shader.uniforms.uLift = lift;
      shader.vertexShader = 'uniform float uLift;\n' + shader.vertexShader.replace('#include <begin_vertex>', key === 'lift-v1'
        ? '#include <begin_vertex>\ntransformed.y += uLift;' : '#include <begin_vertex>\ntransformed.y -= uLift;');
    };
    patched.customProgramCacheKey = () => key;
  };
  const basic = new THREE.MeshBasicMaterial({color: 0x3366ff, blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor});
  const custom = new THREE.ShaderMaterial({uniforms: {uTint: {value: new THREE.Color(1, 0.5, 0)}},
    vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 uTint; void main() { gl_FragColor = vec4(uTint, 1.0); }'});
  for (const [mat, x] of [[patched, -2], [basic, 0], [custom, 2]]) { const m = new THREE.Mesh(box, mat); m.position.x = x; scene.add(m); }
  hooks();
  const step = frame => {
    if (frame === 3) patched.color.setRGB(0.9, 0.2, 0.2);
    if (frame === 4) lift.value = 0.5;
    if (frame === 5) basic.blendDst = THREE.OneMinusSrcAlphaFactor;
    if (frame === 6) patched.defines = {LIFT_TWICE: ''};
    if (frame === 7) custom.fragmentShader = 'uniform vec3 uTint; void main() { gl_FragColor = vec4(uTint * 0.5, 1.0); }';
    if (frame === 8) version = 'lift-v2';
    hooks();
    for (const m of [patched, basic, custom]) { m.needsUpdate = true; m.needsUpdate = true; }
  };
  return {scene, step, frames: 10};
}

/** A LineSegments2 or Line2 as three builds one: one quad per segment, placed by instanceStart and instanceEnd in an
 *  interleaved buffer that setPositions makes anew each call. */
function fatLine(THREE, points, material, line2 = false) {
  const o = new THREE.Mesh(new THREE.InstancedBufferGeometry(), material);
  o.isLineSegments2 = true; if (line2) o.isLine2 = true;
  setPositions(THREE, o.geometry, points);
  return o;
}
function setPositions(THREE, g, points) {
  const buffer = new THREE.InstancedInterleavedBuffer(new Float32Array(points), 6, 1);
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 2, 0, 1, 2, 0, -1, 1, 0, 1, 1, 0], 3));
  g.setAttribute('instanceStart', new THREE.InterleavedBufferAttribute(buffer, 3, 0));
  g.setAttribute('instanceEnd', new THREE.InterleavedBufferAttribute(buffer, 3, 3));
}
function computeLineDistances(THREE, g) {
  const s = g.attributes.instanceStart, e = g.attributes.instanceEnd, d = new Float32Array(2 * s.count);
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (let i = 0, j = 0; i < s.count; i++, j += 2) { a.fromBufferAttribute(s, i); b.fromBufferAttribute(e, i); d[j] = j === 0 ? 0 : d[j - 1]; d[j + 1] = d[j] + a.distanceTo(b); }
  const buffer = new THREE.InstancedInterleavedBuffer(d, 2, 1);
  g.setAttribute('instanceDistanceStart', new THREE.InterleavedBufferAttribute(buffer, 1, 0));
  g.setAttribute('instanceDistanceEnd', new THREE.InterleavedBufferAttribute(buffer, 1, 1));
}
function lineMaterial(THREE, props) {
  const m = new THREE.ShaderMaterial({vertexShader: 'void main() {}', fragmentShader: 'void main() {}'});
  return Object.assign(m, {isLineMaterial: true, color: new THREE.Color(1, 1, 1), linewidth: 2, worldUnits: false, dashed: false, dashSize: 1, gapSize: 1, dashScale: 1}, props);
}

/** Fat lines that get new buffers or geometries every frame. Real changes: a leader's end points (frames 2 and 5), a
 *  path's points (4), a dash size following the camera (3 and 6), a line width (5). sameContent: frames where every
 *  line is drawn as before, so nothing needs sending. */
export function lineChurn(THREE) {
  const scene = new THREE.Scene();
  const leader = fatLine(THREE, [0, 0, 0, 1, 1, 0, 1, 1, 0, 2, 0, 0], lineMaterial(THREE, {color: new THREE.Color(0.1, 0.1, 0.1)}));
  const path = fatLine(THREE, [0, 0, 1, 3, 0, 1], lineMaterial(THREE, {}), true);
  const dashed = fatLine(THREE, [0, 0, 2, 4, 0, 2, 4, 0, 2, 4, 0, 6], lineMaterial(THREE, {dashed: true, dashSize: 0.2, gapSize: 0.1}), true);
  computeLineDistances(THREE, dashed.geometry);
  const width = fatLine(THREE, [0, 1, 0, 0, 3, 0], lineMaterial(THREE, {linewidth: 1}));
  scene.add(leader, path, dashed, width);
  let leaderEnd = 2, pathEnd = 3;
  const step = frame => {
    if (frame === 2 || frame === 5) leaderEnd += 0.5;
    if (frame === 4) pathEnd = 3.5;
    // Every frame: the leader is set again (new buffer), the path gets a new geometry, the dashes are measured again.
    setPositions(THREE, leader.geometry, [0, 0, 0, 1, 1, 0, 1, 1, 0, leaderEnd, 0, 0]);
    const g = new THREE.InstancedBufferGeometry(); setPositions(THREE, g, [0, 0, 1, pathEnd, 0, 1]); path.geometry = g;
    computeLineDistances(THREE, dashed.geometry);
    if (frame === 3) dashed.material.dashSize = 0.3;
    if (frame === 6) dashed.material.gapSize = 0.25;
    if (frame === 5) width.material.linewidth = 4;
  };
  return {scene, step, frames: 8, changes: new Set([2, 3, 4, 5, 6])};
}
