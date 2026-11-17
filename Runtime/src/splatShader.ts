import * as THREE from 'three-real';

/** The material Unreal draws Gaussian splats with (splatStandIn.ts). Each splat is one instance of a quad. Its instance
 *  transform is the splat's own frame: the splat's centre, and its three axes scaled by its standard deviations, so the
 *  vertex stage reads the splat's covariance straight from the model matrix (axes times their transpose). The quad is
 *  turned to face the camera and stretched to the splat's projected ellipse out to SPLAT_RANGE deviations, as Spark's
 *  own vertex shader does (3D Gaussian Splatting's EWA projection with a 0.3 pixel low-pass).
 *
 *  Transparency without sorting: Spark sorts every splat back to front on a worker for each view. Unreal draws an
 *  instanced mesh in instance order, so the fragment stage keeps or drops each pixel at random, kept with the splat's
 *  alpha at that pixel (stochastic transparency), and writes it opaque. The result is depth correct against the rest
 *  of the scene and never needs sorting; the noise moves every frame (splatFrame) and Unreal's temporal upscaler
 *  averages it into the blend. Each splat adds its own offset to the noise, so overlapping splats cover each other
 *  independently. */

/** How far out a splat is drawn, in standard deviations (Spark's maxStdDev default, the square root of 8). */
export const SPLAT_RANGE = Math.sqrt(8);
/** The largest radius a splat is drawn at, in pixels (Spark's maxPixelRadius default); a larger one is drawn smaller. */
export const SPLAT_MAX_PIXELS = 512;

const RANGE = SPLAT_RANGE.toFixed(6), MAX = SPLAT_MAX_PIXELS.toFixed(1);

export const SPLAT_VERTEX = /* glsl */ `
attribute float splatAlpha;
uniform vec2 splatViewport;
uniform float splatOpacity;
uniform vec3 splatTint;
varying vec2 vSplatUv;
varying vec4 vSplatColor;
varying float vSplatSeed;
void main() {
  mat4 world = modelMatrix * instanceMatrix;
  vec4 centre = viewMatrix * (world * vec4(0.0, 0.0, 0.0, 1.0));
  mat3 axes = mat3(viewMatrix) * mat3(world);
  mat3 cov = axes * transpose(axes);
  vec4 clip = projectionMatrix * centre;
  vec2 focal = vec2(projectionMatrix[0][0], projectionMatrix[1][1]) * 0.5 * splatViewport;
  float depth = -centre.z;
  bool perspective = projectionMatrix[3][3] < 0.5;
  mat3 jac = perspective
    ? mat3(focal.x / depth, 0.0, 0.0, 0.0, focal.y / depth, 0.0, focal.x * centre.x / (depth * depth), focal.y * centre.y / (depth * depth), 0.0)
    : mat3(focal.x, 0.0, 0.0, 0.0, focal.y, 0.0, 0.0, 0.0, 0.0);
  mat3 c2 = jac * cov * transpose(jac);
  float a = c2[0][0] + 0.3, b = c2[0][1], d = c2[1][1] + 0.3;
  float mid = 0.5 * (a + d), rad = length(vec2(0.5 * (a - d), b));
  vec2 sigma = sqrt(max(vec2(mid + rad, mid - rad), vec2(0.01)));
  vec2 v1 = abs(b) > 1e-9 ? normalize(vec2(b, mid + rad - a)) : (a >= d ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  vec2 v2 = vec2(-v1.y, v1.x);
  // A splat larger than the largest radius is drawn smaller rather than cut off, so the fragment stage reads only the
  // quad's corner: Unreal runs the vertex stage again for every pixel, and the corner alone needs none of the above.
  vec2 reach = min(sigma, vec2(${MAX} / ${RANGE})) * ${RANGE};
  vec2 pixels = position.x * reach.x * v1 + position.y * reach.y * v2;
  // Behind the camera nothing is offset: the quad stays at its own small size there, out of view.
  if (perspective && depth <= 1e-4) pixels = vec2(0.0);
  gl_Position = clip + vec4(pixels * 2.0 / splatViewport * clip.w, 0.0, 0.0);
  vSplatUv = position.xy * ${RANGE};
  vSplatColor = vec4(instanceColor * splatTint, splatAlpha * splatOpacity);
  vec3 at = world[3].xyz;
  vSplatSeed = fract(sin(dot(at, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
}`;

export const SPLAT_FRAGMENT = /* glsl */ `
uniform float splatFrame;
uniform float splatLinear;
varying vec2 vSplatUv;
varying vec4 vSplatColor;
varying float vSplatSeed;
void main() {
  float r2 = dot(vSplatUv, vSplatUv);
  float alpha = vSplatColor.a * exp(-0.5 * r2);
  if (r2 > ${RANGE} * ${RANGE} || alpha < 0.5 / 255.0) discard;
  // Interleaved gradient noise, moved each frame and offset per splat.
  vec2 p = gl_FragCoord.xy + 5.588238 * mod(splatFrame, 64.0);
  float noise = fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))) + vSplatSeed);
  if (alpha <= noise) discard;
  // Splats keep display (sRGB) colour, as Spark stores it; drawn into a linear target it is decoded, as Spark does.
  vec3 c = clamp(vSplatColor.rgb, 0.0, 1.0);
  vec3 linear = mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, vec3(lessThanEqual(c, vec3(0.04045))));
  gl_FragColor = vec4(splatLinear > 0.5 ? linear : c, 1.0);
}`;

/** A material for one splat's stand-in: its own uniforms carry the splat's opacity and tint. */
export function splatMaterial(): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    name: 'jsgb-splats',
    vertexShader: SPLAT_VERTEX, fragmentShader: SPLAT_FRAGMENT,
    uniforms: {
      splatViewport: {value: new THREE.Vector2(1920, 1080)}, splatOpacity: {value: 1}, splatTint: {value: new THREE.Color(1, 1, 1)},
      splatFrame: {value: 0}, splatLinear: {value: 1},
    },
    side: THREE.DoubleSide,
  });
  // The quad faces the camera by itself: no pull toward the camera (shaders.ts depthPull), which would draw a splat
  // over the surface it sits on.
  m.userData.jsgbDepthPull = 0;
  return m;
}
