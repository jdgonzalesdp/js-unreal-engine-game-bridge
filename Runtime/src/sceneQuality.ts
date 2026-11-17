// The scene's quality tier and resolved sun/sky, for Unreal's native lighting translation:
//   jsgb.setSceneQuality({tier, timeOfDay, intExt, skyMode, skySolidColor, sun, ambient})
//   jsgb.setSceneQuality(null)  drop the request
//   jsgb.sceneQuality()         the normalized request in force, or null
// The values describe the shared scene, not Unreal-local state: the same canonical data the browser
// renders, carried so Unreal can render the same intended result at higher quality. Stage 1 only
// carries and exposes the request; later lighting stages consume it. A browser has no such call:
// games test for window.jsgb before they use it.
import {host} from './host';

const g = globalThis as unknown as Record<string, any>;

export interface SceneQualitySun {
  on: boolean;
  castShadow: boolean;
  azDeg: number;
  elDeg: number;
  lux: number;
  cctK: number | null;
  colorHex: string | null;
  effectiveColorHex: string | null;
  discRadiusM: number;
  distanceM: number;
  falloff: number;
  mode: 'sun' | 'moon';
}

export interface SceneQuality {
  tier: 'low' | 'medium' | 'high' | 'ultra';
  timeOfDay: string | null;
  intExt: 'int' | 'ext' | null;
  skyMode: 'procedural' | 'color' | 'image';
  skySolidColor: string | null;
  sun: SceneQualitySun;
  ambient: {lux: number; cctK: number | null; colorHex: string | null};
}

const TIERS = new Set(['low', 'medium', 'high', 'ultra']);
const SKY_MODES = new Set(['procedural', 'color', 'image']);
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const record = (value: unknown): Record<string, any> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : null;
const finite = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null;
const nullableFinite = (value: unknown, min: number, max: number): number | null | undefined =>
  value === null || value === undefined ? null : finite(value, min, max) ?? undefined;
const hex = (value: unknown): string | null | undefined =>
  value === null || value === undefined ? null : typeof value === 'string' && HEX.test(value) ? value : undefined;
const preset = (value: unknown): string | null | undefined =>
  value === null || value === undefined ? null
    : typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value) ? value : undefined;

/** A scene-quality request as the host holds it, or null when the value does not carry one. Numbers are
 *  held to the ranges PrepViz's sun settings use, so a malformed page cannot hand Unreal extremes. */
export function sceneQualityRequest(value: unknown): SceneQuality | null {
  const input = record(value);
  const sun = record(input?.sun);
  const ambient = record(input?.ambient);
  if (!input || !sun || !ambient || !TIERS.has(input.tier) || !SKY_MODES.has(input.skyMode)) return null;

  const timeOfDay = preset(input.timeOfDay);
  const skySolidColor = hex(input.skySolidColor);
  const sunColorHex = hex(sun.colorHex);
  const sunEffectiveColorHex = hex(sun.effectiveColorHex);
  const ambientColorHex = hex(ambient.colorHex);
  const sunCctK = nullableFinite(sun.cctK, 1000, 20000);
  const ambientCctK = nullableFinite(ambient.cctK, 1000, 20000);
  const azDeg = finite(sun.azDeg, -3600, 3600);
  const elDeg = finite(sun.elDeg, -90, 90);
  const lux = finite(sun.lux, 0, 250000);
  const discRadiusM = finite(sun.discRadiusM, 0, 100000);
  const distanceM = finite(sun.distanceM, 0, 100000);
  const falloff = finite(sun.falloff, 0, 100);
  const ambientLux = finite(ambient.lux, 0, 250000);
  if (timeOfDay === undefined || skySolidColor === undefined || sunColorHex === undefined || sunEffectiveColorHex === undefined || ambientColorHex === undefined ||
    sunCctK === undefined || ambientCctK === undefined || azDeg === null || elDeg === null || lux === null ||
    discRadiusM === null || distanceM === null || falloff === null || ambientLux === null ||
    typeof sun.on !== 'boolean' || typeof sun.castShadow !== 'boolean' || (sun.mode !== 'sun' && sun.mode !== 'moon') ||
    (input.intExt !== null && input.intExt !== undefined && input.intExt !== 'int' && input.intExt !== 'ext')) return null;

  return {
    tier: input.tier,
    timeOfDay,
    intExt: input.intExt ?? null,
    skyMode: input.skyMode,
    skySolidColor: input.skyMode === 'color' ? skySolidColor : null,
    sun: {
      on: sun.on,
      castShadow: sun.castShadow,
      azDeg,
      elDeg,
      lux,
      cctK: sunCctK,
      colorHex: sunColorHex,
      effectiveColorHex: sunEffectiveColorHex,
      discRadiusM,
      distanceM,
      falloff,
      mode: sun.mode,
    },
    ambient: {lux: ambientLux, cctK: ambientCctK, colorHex: ambientColorHex},
  };
}

let asked: SceneQuality | null = null;
let askedJson = '';

/** Asks the host to hold this scene quality, or drops the request with null. Malformed objects are
 *  ignored, leaving the request in force untouched. The host hears only changes. Returns the request. */
export function setSceneQuality(value: unknown): SceneQuality | null {
  const next = value === null || value === undefined ? null : sceneQualityRequest(value);
  if (value !== null && value !== undefined && !next) return asked;
  const json = next ? JSON.stringify(next) : '';
  if (json === askedJson) return asked;
  asked = next;
  askedJson = json;
  try { host.sceneQuality?.(json); } catch (e) { host.log('warn', 'scene quality: ' + e); }
  return asked;
}

/** The request in force, or null. */
export const sceneQuality = (): SceneQuality | null => asked ? JSON.parse(askedJson) as SceneQuality : null;

g.jsgb = Object.assign(g.jsgb ?? {}, {setSceneQuality, sceneQuality});
