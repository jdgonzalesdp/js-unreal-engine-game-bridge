import * as THREE from 'three-real';

/** Glyph quads for troika-three-text, built on the CPU as an ordinary mesh. troika draws one instanced template quad
 *  per glyph and places it in its vertex shader (aTroikaGlyphBounds, the uTroikaOrient matrix, the outline's edge
 *  offset and the clip rect). Unreal can't run that placement, so the same arithmetic runs here, once per layout:
 *  outline quads first (layer 0), then fill quads (layer 1), so a later glyph's outline never covers an earlier
 *  glyph's fill, matching troika's two passes in a single draw. */

/** The part of troika's textRenderInfo the quads need (TextBuilder.js). */
export type GlyphInfo = {glyphBounds: ArrayLike<number>; glyphAtlasIndices: ArrayLike<number>; glyphColors?: ArrayLike<number> | null};
/** Placement settings in text units: the outline's growth and shift, the clip rect [x0, y0, x1, y1], the orientation. */
export type GlyphLayout = {outline: {width: number; blur: number; offsetX: number; offsetY: number} | null;
  clip: ArrayLike<number>; orient: THREE.Matrix3; curveRadius: number};

const DEFAULT_ORIENT = '+x+y';
const lookAt = new THREE.Matrix4(), horizontal = new THREE.Vector3(), vertical = new THREE.Vector3(), origin = new THREE.Vector3();
/** troika's orientation string ('+x+y', '+x-z', ...) as the rotation its vertex shader applies (Text.js _prepareForRender). */
export function orientationMatrix(orientation: string | null | undefined, out = new THREE.Matrix3()): THREE.Matrix3 {
  const orient = (orientation || DEFAULT_ORIENT).replace(/[^-+xyz]/g, '');
  const match = orient !== DEFAULT_ORIENT && /^([-+])([xyz])([-+])([xyz])$/.exec(orient);
  if (!match) return out.identity();
  const [, hSign, hAxis, vSign, vAxis] = match as unknown as [string, string, 'x' | 'y' | 'z', string, 'x' | 'y' | 'z'];
  horizontal.set(0, 0, 0)[hAxis] = hSign === '-' ? 1 : -1;
  vertical.set(0, 0, 0)[vAxis] = vSign === '-' ? -1 : 1;
  lookAt.lookAt(origin, horizontal.cross(vertical), vertical);
  return out.setFromMatrix4(lookAt);
}

/** A size prop that may be a percentage of the font size ('10%'), as troika resolves it (Text.js _parsePercent). */
export function resolvePercent(value: unknown, fontSize: number): number {
  if (typeof value === 'string') {
    const match = /^(-?[\d.]+)%$/.exec(value);
    const pct = match ? parseFloat(match[1]) : NaN;
    return (isNaN(pct) ? 0 : pct / 100) * fontSize;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// troika's template quad (PlaneGeometry(1, 1) moved to 0..1): corners and winding, so front faces match.
const CORNERS = [0, 1, 1, 1, 0, 0, 1, 0];
const QUAD = [0, 2, 1, 2, 3, 1];
const p = new THREE.Vector3(), nrm = new THREE.Vector3();

/** One quad per glyph and layer. Attributes: position and normal in the text's local space, uv (the glyph's own
 *  0..1 square, past it where the outline reaches), color (a glyph colour from colorRanges, else white) and
 *  aJsgbTextGlyph (atlas index, glyph width, glyph height, layer). Glyphs with no area are left out. */
export function buildGlyphGeometry(info: GlyphInfo, layout: GlyphLayout): THREE.BufferGeometry {
  const bounds = info.glyphBounds, atlas = info.glyphAtlasIndices, colors = info.glyphColors;
  const count = Math.min(atlas.length, Math.floor(bounds.length / 4));
  const layers = layout.outline ? [0, 1] : [1];
  const quads = count * layers.length;
  const pos = new Float32Array(quads * 12), normals = new Float32Array(quads * 12), uv = new Float32Array(quads * 8);
  const col = new Float32Array(quads * 12), glyph = new Float32Array(quads * 16), index: number[] = [];
  const clip = layout.clip, r = layout.curveRadius;
  let v = 0;
  for (const layer of layers) {
    const o = layer === 0 ? layout.outline! : null;
    const shiftX = o ? o.offsetX : 0, shiftY = o ? o.offsetY : 0, grow = o ? o.width + o.blur : 0;
    for (let i = 0; i < count; i++) {
      // troika: bounds.xz += offset.x, bounds.yw -= offset.y, then grown by the edge offset and blur and clipped.
      const x0 = bounds[i * 4] + shiftX, y0 = bounds[i * 4 + 1] - shiftY, x1 = bounds[i * 4 + 2] + shiftX, y1 = bounds[i * 4 + 3] - shiftY;
      const w = x1 - x0, h = y1 - y0;
      if (!(w > 0 && h > 0)) continue;
      const cx0 = clamp(x0 - grow, clip[0], clip[2]), cy0 = clamp(y0 - grow, clip[1], clip[3]);
      const cx1 = clamp(x1 + grow, clip[0], clip[2]), cy1 = clamp(y1 + grow, clip[1], clip[3]);
      const red = colors && layer === 1 ? colors[i * 3] / 255 : 1, green = colors && layer === 1 ? colors[i * 3 + 1] / 255 : 1, blue = colors && layer === 1 ? colors[i * 3 + 2] / 255 : 1;
      for (let k = 0; k < 4; k++) {
        const x = cx0 + (cx1 - cx0) * CORNERS[k * 2], y = cy0 + (cy1 - cy0) * CORNERS[k * 2 + 1];
        p.set(x, y, 0); nrm.set(0, 0, 1);
        // troika's curveRadius bends the text around a vertical axis.
        if (r) { const angle = x / r; p.x = Math.sin(angle) * r; p.z = r - Math.cos(angle) * r; nrm.set(Math.sin(angle), 0, Math.cos(angle)); }
        p.applyMatrix3(layout.orient); nrm.applyMatrix3(layout.orient).normalize();
        pos.set([p.x, p.y, p.z], v * 3); normals.set([nrm.x, nrm.y, nrm.z], v * 3);
        uv[v * 2] = (x - x0) / w; uv[v * 2 + 1] = (y - y0) / h;
        col[v * 3] = red; col[v * 3 + 1] = green; col[v * 3 + 2] = blue;
        glyph.set([atlas[i], w, h, layer], v * 4);
        v++;
      }
      const first = v - 4;
      for (const q of QUAD) index.push(first + q);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normals.subarray(0, v * 3), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv.subarray(0, v * 2), 2));
  g.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, v * 3), 3));
  g.setAttribute('aJsgbTextGlyph', new THREE.BufferAttribute(glyph.subarray(0, v * 4), 4));
  g.setIndex(index);
  return g;
}

const GLYPH_ATTRIBUTES = ['position', 'normal', 'uv', 'color', 'aJsgbTextGlyph'];

/** Whether two glyph geometries have the same vertex and index counts, so one can take the other's values. */
export function sameShape(a: THREE.BufferGeometry, b: THREE.BufferGeometry): boolean {
  return a.attributes.position?.count === b.attributes.position.count && a.index?.count === b.index?.count;
}

/** Copies `from`'s glyph arrays into `into` (same shape) and marks them changed. */
export function copyInto(into: THREE.BufferGeometry, from: THREE.BufferGeometry) {
  for (const name of GLYPH_ATTRIBUTES) {
    const a = into.getAttribute(name) as THREE.BufferAttribute;
    (a.array as Float32Array).set(from.getAttribute(name).array as Float32Array);
    a.needsUpdate = true;
  }
  (into.index!.array as Uint16Array | Uint32Array).set(from.index!.array as ArrayLike<number>);
  into.index!.needsUpdate = true;
  into.boundingBox = null; into.boundingSphere = null;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
