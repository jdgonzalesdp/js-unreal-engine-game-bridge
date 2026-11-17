// How many frames a second Unreal presents, for a game that wants fewer at times: window.jsgb.setFrameRate.
//   jsgb.setFrameRate(fps)    present at most fps frames a second (held to 1 to 240)
//   jsgb.setFrameRate(null)   drop the request: back to the game's default ("sceneFps" in Games/<game>.json, or
//                             -JsgbSceneFps) or to the cap the player saved in the display settings
//   jsgb.frameRate()          the request in force, or null
// A request only lowers the cap. The game's default and a cap the player saved still apply, and the lowest one wins
// (Source/JsGameBridge/Private/JsgbFrameCap.h). A film's camera view can ask for its 24 frames a second this way.
// The game's frame, requestAnimationFrame included, runs once per Unreal frame, so it follows the cap with no pacing
// of its own here. A browser has no such call: games test for window.jsgb before they use it.
import {host} from './host';

const g = globalThis as unknown as Record<string, any>;
let asked: number | null = null;

/** fps as a request: a finite number above 0, held to 1 to 240. Anything else, null included, is no request. */
export function frameRateRequest(fps: unknown): number | null {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) return null;
  return Math.min(240, Math.max(1, fps));
}

/** Asks the host for at most fps frames a second, or drops the request with null. The host hears only changes.
 *  Returns the request now in force. */
export function setFrameRate(fps: number | null | undefined): number | null {
  const next = frameRateRequest(fps);
  if (next === asked) return asked;
  asked = next;
  try { host.frameRate?.(next ?? 0); } catch (e) { host.log('warn', 'frame rate: ' + e); }
  return asked;
}

/** The request in force, or null. */
export const frameRate = (): number | null => asked;

g.jsgb = Object.assign(g.jsgb ?? {}, {setFrameRate, frameRate});
