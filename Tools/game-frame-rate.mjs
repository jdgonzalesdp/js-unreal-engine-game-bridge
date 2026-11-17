// "sceneFps" in Games/<game>.json: how many frames a second Unreal presents a mirrored scene by default. It reaches
// the host through publication.json; -JsgbSceneFps=<n> on the command line wins over it, and 0 leaves Unreal's own
// cap. The game can lower it while it runs (window.jsgb.setFrameRate, Runtime/src/frameRate.ts).
//   "sceneFps": 60

/** The highest default the host accepts (the same range as -JsgbSceneFps). */
export const SCENE_FPS_MAX = 240;

/** The game's default scene frame rate for publication.json: 0 when it names none. A value that is not a number from
 *  0 to SCENE_FPS_MAX stops the build, so a typo in the config does not quietly leave the game uncapped. */
export function sceneFps(game) {
  const fps = game.sceneFps;
  if (fps === undefined || fps === null) return 0;
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps < 0 || fps > SCENE_FPS_MAX)
    throw Error(`${game.id ?? 'game'}: "sceneFps" must be a number from 0 to ${SCENE_FPS_MAX}, not ${JSON.stringify(fps)}`);
  return fps;
}
