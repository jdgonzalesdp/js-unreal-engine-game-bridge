import * as THREE from 'three-real';

/** The bridge's own material for troika-three-text (drei's <Text>), drawn on the glyph quads troikaGlyphs.ts builds.
 *  It ports troika's signed distance field decode (TextDerivedMaterial.js): find the glyph's cell in the atlas, read
 *  its channel, undo the exponential encoding, and turn the distance into coverage with derivative-based smoothing.
 *  Outline quads (layer 0) and fill quads (layer 1) share it, so one record draws the whole label.
 *
 *  The vertex shader places vertices with the plain model, view and projection matrices, so Unreal draws the mesh
 *  where it already is (no world position offset). Every varying comes from uv, the vertex colour or the glyph
 *  attribute, never from position: the generated material runs this vertex stage again for each pixel. */

export const TEXT_SHADER_NAME = 'JsgbTroikaText';

export const TEXT_VERTEX = `
attribute vec4 aJsgbTextGlyph;
uniform vec2 uJsgbSdfSize;
uniform float uJsgbGlyphSize;
varying vec2 vJsgbGlyphUV;
varying vec4 vJsgbAtlasRect;
varying vec4 vJsgbGlyph;
varying vec3 vJsgbGlyphColor;
void main() {
  // aJsgbTextGlyph: atlas index, glyph width, glyph height, layer (0 outline, 1 fill).
  float index = floor(aJsgbTextGlyph.x + 0.5);
  float square = floor((index + 0.5) / 4.0);
  // As troika does: the unrounded column count, with mod().
  float columns = uJsgbSdfSize.x / max(uJsgbGlyphSize, 1.0);
  float row = floor(square / columns);
  vec2 cell = vec2(uJsgbGlyphSize) / max(uJsgbSdfSize, vec2(1.0));
  vec2 start = cell * vec2(mod(square, columns), row);
  vJsgbAtlasRect = vec4(start, start + cell);
  vJsgbGlyph = vec4(index - square * 4.0, aJsgbTextGlyph.yzw);
  vJsgbGlyphUV = uv;
  vJsgbGlyphColor = color;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const TEXT_FRAGMENT = `
uniform sampler2D uJsgbSdf;
uniform float uJsgbGlyphSize;
uniform float uJsgbExponent;
uniform vec3 uJsgbFillColor;
uniform float uJsgbFillOpacity;
uniform float uJsgbUseGlyphColors;
uniform vec3 uJsgbOutlineColor;
uniform float uJsgbOutlineOpacity;
uniform float uJsgbOutlineWidth;
uniform float uJsgbOutlineBlur;
uniform vec3 uJsgbStrokeColor;
uniform float uJsgbStrokeWidth;
uniform float uJsgbStrokeOpacity;
varying vec2 vJsgbGlyphUV;
varying vec4 vJsgbAtlasRect;
varying vec4 vJsgbGlyph;
varying vec3 vJsgbGlyphColor;
float jsgbSdfValue(vec2 glyphUV) {
  vec4 texel = texture2DLodEXT(uJsgbSdf, mix(vJsgbAtlasRect.xy, vJsgbAtlasRect.zw, glyphUV), 0.0);
  float channel = vJsgbGlyph.x;
  return channel < 0.5 ? texel.r : channel < 1.5 ? texel.g : channel < 2.5 ? texel.b : texel.a;
}
float jsgbDistance(vec2 glyphUV, vec2 size) {
  // Outside the glyph's cell the distance is extrapolated from its edge, as troika does.
  vec2 inside = clamp(glyphUV, vec2(0.5 / uJsgbGlyphSize), vec2(1.0 - 0.5 / uJsgbGlyphSize));
  float value = jsgbSdfValue(inside);
  float encoded = value > 0.5 ? 1.0 - value : value;
  float dist = (1.0 - pow(2.0 * encoded, 1.0 / uJsgbExponent)) * max(size.x, size.y);
  if (value > 0.5) dist = -dist;
  return dist + length((glyphUV - inside) * size);
}
void main() {
  vec2 size = vJsgbGlyph.yz;
  float outline = vJsgbGlyph.w < 0.5 ? 1.0 : 0.0;
  float aa = length(fwidth(vJsgbGlyphUV * size)) * 0.5;
  float dist = jsgbDistance(vJsgbGlyphUV, size);
  float edge = outline * uJsgbOutlineWidth;
  float soft = max(aa, outline * uJsgbOutlineBlur);
  float alpha = smoothstep(edge + soft, edge - soft, dist);
  // troika mixes fill, stroke and outline in linear light and encodes once at the end (troika-three-utils moves
  // MeshBasicMaterial's colorspace_fragment behind its own colour code).
  vec4 fill = vec4(uJsgbUseGlyphColors > 0.5 ? vJsgbGlyphColor : uJsgbFillColor, uJsgbFillOpacity);
  vec4 stroke = uJsgbStrokeWidth == 0.0 ? fill : vec4(uJsgbStrokeColor, uJsgbStrokeOpacity);
  if (fill.a == 0.0) fill.rgb = stroke.rgb;
  vec4 body = mix(fill, stroke, smoothstep(-uJsgbStrokeWidth - aa, -uJsgbStrokeWidth + aa, dist));
  vec4 color = outline > 0.5 ? vec4(uJsgbOutlineColor, uJsgbOutlineOpacity) : body;
  if (alpha <= 0.0) discard;
  gl_FragColor = linearToOutputTexel(vec4(color.rgb, color.a * alpha));
}`;

/** A text mesh's own copy of the material (each label has its own colours and atlas). */
export function createTextMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: TEXT_SHADER_NAME, vertexShader: TEXT_VERTEX, fragmentShader: TEXT_FRAGMENT, vertexColors: true, transparent: true,
    uniforms: {
      uJsgbSdf: {value: null}, uJsgbSdfSize: {value: new THREE.Vector2(1, 1)}, uJsgbGlyphSize: {value: 64}, uJsgbExponent: {value: 9},
      uJsgbFillColor: {value: new THREE.Color(1, 1, 1)}, uJsgbFillOpacity: {value: 1}, uJsgbUseGlyphColors: {value: 0},
      uJsgbOutlineColor: {value: new THREE.Color(0, 0, 0)}, uJsgbOutlineOpacity: {value: 1}, uJsgbOutlineWidth: {value: 0}, uJsgbOutlineBlur: {value: 0},
      uJsgbStrokeColor: {value: new THREE.Color(0.5, 0.5, 0.5)}, uJsgbStrokeWidth: {value: 0}, uJsgbStrokeOpacity: {value: 1},
    },
  });
}

type ColorInput = THREE.ColorRepresentation | null | undefined;
const lastInput = new WeakMap<THREE.Color, unknown>();
/** Sets a colour uniform from a troika prop (a number, CSS string or Color), parsing a string only when it changes. */
function setColor(target: THREE.Color, value: ColorInput, fallback: THREE.ColorRepresentation) {
  const v = value ?? fallback;
  if (typeof v === 'object' || lastInput.get(target) !== v) { target.set(v); lastInput.set(target, v); }
}

/** The text props troika reads when it prepares each pass (Text.js _prepareForRender), already resolved to numbers. */
export type TextLook = {fillColor: ColorInput; inheritedColor: THREE.Color | null; fillOpacity: number; glyphColors: boolean;
  outlineColor: ColorInput; outlineOpacity: number; outlineWidth: number; outlineBlur: number;
  strokeColor: ColorInput; strokeOpacity: number; strokeWidth: number};
export type AtlasInfo = {sdfTexture: THREE.Texture; sdfGlyphSize: number; sdfExponent: number};

export function updateTextUniforms(m: THREE.ShaderMaterial, atlas: AtlasInfo, look: TextLook) {
  const u = m.uniforms;
  const image = atlas.sdfTexture.image as {width?: number; height?: number} | undefined;
  u.uJsgbSdf.value = atlas.sdfTexture;
  (u.uJsgbSdfSize.value as THREE.Vector2).set(image?.width || 1, image?.height || 1);
  u.uJsgbGlyphSize.value = atlas.sdfGlyphSize;
  u.uJsgbExponent.value = atlas.sdfExponent;
  // No colour prop: the base material's own colour, as troika's derived material inherits it.
  const fill = u.uJsgbFillColor.value as THREE.Color;
  if (look.fillColor == null && look.inheritedColor) { fill.copy(look.inheritedColor); lastInput.delete(fill); }
  else setColor(fill, look.fillColor, 0xffffff);
  u.uJsgbFillOpacity.value = look.fillOpacity;
  u.uJsgbUseGlyphColors.value = look.glyphColors ? 1 : 0;
  setColor(u.uJsgbOutlineColor.value as THREE.Color, look.outlineColor || 0, 0);
  u.uJsgbOutlineOpacity.value = look.outlineOpacity;
  u.uJsgbOutlineWidth.value = look.outlineWidth;
  u.uJsgbOutlineBlur.value = look.outlineBlur;
  setColor(u.uJsgbStrokeColor.value as THREE.Color, look.strokeColor, 0x808080);
  u.uJsgbStrokeWidth.value = look.strokeWidth;
  u.uJsgbStrokeOpacity.value = look.strokeOpacity;
}
