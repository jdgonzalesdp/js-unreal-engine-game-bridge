import * as THREE from 'three-real';
import {buildGlyphGeometry, copyInto, orientationMatrix, resolvePercent, sameShape, type GlyphInfo} from './troikaGlyphs';
import {createTextMaterial, updateTextUniforms, type AtlasInfo} from './troikaTextShader';
import {shaderDrawable} from './shaderGuard';

/** troika-three-text (drei's <Text>) in Unreal. troika draws each label as an InstancedBufferGeometry of one template
 *  quad, placed per glyph in a vertex shader that onBeforeCompile grafts onto a MeshBasicMaterial, with the outline as
 *  a second material sharing the fill's uniforms. None of that survives the generic path (the labels showed as 1 m
 *  squares in the outline colour). Instead each label is drawn through a stand-in mesh the bridge owns: the glyph
 *  quads built on the CPU from the label's textRenderInfo (troikaGlyphs.ts) and one fixed shader that decodes the
 *  glyph atlas (troikaTextShader.ts). The stand-in follows the label's matrix and props every frame, and its geometry
 *  is rebuilt only when troika lays the text out again or a prop that moves the quads changes.
 *
 *  Detection is by feature, not by class: a label is a mesh with troika's glyph attribute, a troika text material,
 *  or isTroikaText. Anything else, and troika's BatchedText (its members are placed from a data texture), keeps the
 *  ordinary path, where the instanced-geometry guard (shaderGuard.ts) hides what can't be placed. */

type RenderInfo = GlyphInfo & AtlasInfo & {blockBounds: ArrayLike<number>};
type TroikaText = THREE.Mesh & Record<string, any> & {textRenderInfo?: RenderInfo | null};
type StandIn = {mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>; info: RenderInfo | null; key: string; orient: THREE.Matrix3};

const standIns = new WeakMap<THREE.Mesh, StandIn>();
/** Counters for checks from a capture or smoke script: stand-ins made, geometry builds, draws, and draws held back. */
export const textStats = {standIns: 0, builds: 0, drawn: 0, hidden: 0};
(globalThis as Record<string, unknown>).__jsgbTextStats = textStats;

const firstMaterial = (m: unknown) => (Array.isArray(m) ? m[0] : m) as (THREE.Material & Record<string, any>) | undefined;
const lastMaterial = (m: unknown) => (Array.isArray(m) ? m[m.length - 1] : m) as (THREE.Material & Record<string, any>) | undefined;

/** A troika text mesh, by feature (see above). */
export function isTroikaText(o: THREE.Mesh): boolean {
  const t = o as TroikaText;
  if (t.isTroikaText) return true;
  if ((o.geometry?.attributes as Record<string, unknown> | undefined)?.aTroikaGlyphBounds) return true;
  return 'textRenderInfo' in o && !!firstMaterial(o.material)?.isTroikaTextMaterial;
}

/** The mesh to draw for `o`: `o` itself when it isn't troika text, the label's stand-in when it is, or null when the
 *  label has nothing to show yet (not laid out, empty, hidden material) or its shader isn't ready. `describe` is the
 *  exporter's syncMaterial: the stand-in's material is described first, so a shader still translating holds the
 *  label back instead of drawing bare quads with the generic material. */
export function textStandIn(o: THREE.Mesh, describe: (m: THREE.Material) => number): THREE.Mesh | null {
  if (!isTroikaText(o)) return o;
  const t = o as TroikaText;
  if (t._members instanceof Map) return o;
  const info = t.textRenderInfo;
  const fill = lastMaterial(o.material);
  if (!info?.sdfTexture || !info.glyphAtlasIndices?.length || !info.glyphBounds || !fill || !fill.visible || fill.colorWrite === false) return null;
  let s = standIns.get(o);
  if (!s) s = createStandIn(o);
  const fontSize = +t.fontSize || 0.1;
  const outlined = !!(t.outlineWidth || t.outlineBlur || t.outlineOffsetX || t.outlineOffsetY);
  const outline = outlined ? {width: resolvePercent(t.outlineWidth, fontSize), blur: Math.max(0, resolvePercent(t.outlineBlur, fontSize)),
    offsetX: resolvePercent(t.outlineOffsetX, fontSize), offsetY: resolvePercent(t.outlineOffsetY, fontSize)} : null;
  const clip = clipRect(t.clipRect, info.blockBounds, fontSize);
  const orientation = typeof t.orientation === 'string' ? t.orientation : '+x+y';
  const curveRadius = +t.curveRadius || 0;
  const key = `${outline ? `${outline.width},${outline.blur},${outline.offsetX},${outline.offsetY}` : '-'}|${clip.join(',')}|${orientation}|${curveRadius}`;
  if (s.info !== info || s.key !== key) {
    const old = s.mesh.geometry;
    const next = buildGlyphGeometry(info, {outline, clip, orient: orientationMatrix(orientation, s.orient), curveRadius});
    // A re-layout with as many glyphs (a readout ticking) rewrites the arrays in place, so Unreal keeps the same mesh.
    if (sameShape(old, next)) { copyInto(old, next); next.dispose(); } else { s.mesh.geometry = next; old.dispose(); }
    s.info = info; s.key = key; textStats.builds++;
  }
  const m = s.mesh.material;
  // Each pass's alpha is the material's opacity times its own opacity prop (troika's outline material inherits the
  // fill's opacity through its prototype).
  const opacity = typeof fill.opacity === 'number' ? fill.opacity : 1;
  updateTextUniforms(m, info, {
    fillColor: t.color, inheritedColor: (fill.baseMaterial?.color ?? fill.color) as THREE.Color | null, fillOpacity: opacity * num(t.fillOpacity, 1),
    glyphColors: !!info.glyphColors, outlineColor: t.outlineColor, outlineOpacity: opacity * num(t.outlineOpacity, 1),
    outlineWidth: outline?.width ?? 0, outlineBlur: outline?.blur ?? 0,
    strokeColor: t.strokeColor, strokeOpacity: num(t.strokeOpacity, 1), strokeWidth: Math.max(0, resolvePercent(t.strokeWidth, fontSize)),
  });
  m.side = fill.side; m.depthTest = fill.depthTest; m.depthWrite = fill.depthWrite; m.blending = fill.blending; m.depthFunc = fill.depthFunc;
  m.toneMapped = fill.toneMapped; m.fog = fill.fog !== false;
  const mesh = s.mesh;
  mesh.name = o.name; mesh.userData = o.userData;
  mesh.castShadow = o.castShadow; mesh.receiveShadow = o.receiveShadow; mesh.frustumCulled = o.frustumCulled; mesh.renderOrder = o.renderOrder;
  mesh.matrixWorld.copy(o.matrixWorld);
  describe(m);
  if (!shaderDrawable(m, 'troika text')) { textStats.hidden++; return null; }
  textStats.drawn++;
  return mesh;
}

const num = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** troika's clip rect: the label's clipRect, or a rect no glyph or outline can reach (Text.js _prepareForRender). */
function clipRect(rect: unknown, block: ArrayLike<number>, fontSize: number): number[] {
  if (Array.isArray(rect) && rect.length === 4 && rect.every(v => typeof v === 'number')) return rect as number[];
  const pad = fontSize * 100;
  return [block[0] - pad, block[1] - pad, block[2] + pad, block[3] + pad];
}

function createStandIn(o: THREE.Mesh): StandIn {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), createTextMaterial());
  mesh.matrixAutoUpdate = false; mesh.matrixWorldAutoUpdate = false;
  const s: StandIn = {mesh, info: null, key: '', orient: new THREE.Matrix3()};
  standIns.set(o, s);
  textStats.standIns++;
  // A label taken out of the scene and disposed (an unmounted drei <Text>) frees its stand-in, so the Unreal copies go
  // at once rather than at the exporter's next sweep. troika also disposes the geometry while the label is still in
  // the scene, when the glyph count changes; that one is ignored.
  const geometry = o.geometry;
  const onDispose = () => {
    if (o.parent) return;
    geometry.removeEventListener('dispose', onDispose);
    if (standIns.get(o) !== s) return;
    standIns.delete(o);
    mesh.geometry.dispose(); mesh.material.dispose();
  };
  geometry?.addEventListener('dispose', onDispose);
  return s;
}
