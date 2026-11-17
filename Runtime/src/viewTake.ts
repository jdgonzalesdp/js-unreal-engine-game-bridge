/** The game's view and a scene drawn into a render target (renderer.ts). Unreal mirrors the latest perspective scene the
 *  page's main renderer draws, into the screen or into a render target that post-processing then shows. A render target
 *  draw that shows nothing (an export's light meter or a thumbnail drawn between two live frames) took the view all
 *  the same, and the screen then showed the export's camera, linear and without the tone curve, until the page drew
 *  its own view again; a page that draws only on demand may not for a long time. So a render target draw that takes
 *  the view is undone at the end of the host frame unless the main renderer drew to the screen after it: then a pass
 *  chain (or a scene showing the target) did reach the screen, and the view stays. */
import {lastFrame, post} from './renderer';

type View = {scene: unknown; camera: unknown; renderer: unknown; linear: boolean; pointScale: number; post: Record<string, number>};
/** The view before the first render target draw that took it since the screen was last drawn to, if any. */
let before: View | null = null;
/** What the last frame end did, for /bridge/eval. */
export const viewTakes = {taken: 0, undone: 0, kept: 0};
(globalThis as Record<string, unknown>).__jsgbViewTakes = viewTakes;

/** The main renderer is about to make a scene the view (target: the render target it is drawn into, null for the
 *  screen). Called before lastFrame changes. */
export function noteViewTake(target: unknown) {
  if (!target) { before = null; return; }
  viewTakes.taken++;
  before ??= {scene: lastFrame.scene, camera: lastFrame.camera, renderer: lastFrame.renderer, linear: lastFrame.linear, pointScale: lastFrame.pointScale, post: {...post}};
}

/** The main renderer drew to the screen (a scene, a pass, or a group): a view taken before it reached the screen. */
export function noteScreenDraw() {
  if (before) viewTakes.kept++;
  before = null;
}

/** End of the host frame, before the scene goes out (entry.ts): a view no screen draw followed goes back. */
export function endFrameView() {
  const v = before;
  before = null;
  if (!v) return;
  viewTakes.undone++;
  lastFrame.scene = v.scene; lastFrame.camera = v.camera; lastFrame.renderer = v.renderer; lastFrame.linear = v.linear; lastFrame.pointScale = v.pointScale;
  Object.assign(post, v.post);
}
