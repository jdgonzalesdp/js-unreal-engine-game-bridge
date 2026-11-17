/** One scene, drawn from one camera, exported as a complete frame of its own for the host to draw now (readback.ts,
 *  passRun.ts): the game's view swaps to that scene for the export and comes straight back. A fixed step turns off
 *  the exporter's new-geometry budget, so every object of the picture goes out at once. */
import {lastFrame} from './renderer';
import {exportFrame} from './sceneExport';

type Obj = Record<string, any>;
export type SceneFrame = [ArrayBuffer, number, ArrayBuffer, number];

let exporting = false;
/** Whether a scene frame is being exported now (draws seen meanwhile belong to that export, not the page). */
export const exportingFrame = () => exporting;

export function sceneFrame(scene: Obj, camera: Obj, linear: boolean): SceneFrame | null {
  const host = (globalThis as {__jsgbHost?: Obj}).__jsgbHost, sink = host?.sink;
  if (!sink || exporting) return null;
  const saved = {scene: lastFrame.scene, camera: lastFrame.camera, linear: lastFrame.linear, pointScale: lastFrame.pointScale};
  const send = sink.frame, step = host!.fixedStepMs;
  let frame: SceneFrame | null = null;
  exporting = true;
  try {
    lastFrame.scene = scene; lastFrame.camera = camera; lastFrame.linear = linear; lastFrame.pointScale = 1;
    sink.frame = (f: ArrayBuffer, n: number, i: ArrayBuffer, ni: number) => { frame = [f, n, i, ni]; };
    host!.fixedStepMs = step || 1;
    exportFrame();
  } finally {
    sink.frame = send; host!.fixedStepMs = step;
    lastFrame.scene = saved.scene; lastFrame.camera = saved.camera; lastFrame.linear = saved.linear; lastFrame.pointScale = saved.pointScale;
    exporting = false;
  }
  return frame;
}
