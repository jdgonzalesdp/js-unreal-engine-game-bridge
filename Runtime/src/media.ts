/** The host's media services: pictures of the scene, image files, saved files and video encoding. JavaScript/jsgb-main.js
 *  installs them as __jsgbHost.media; Source/JsGameBridge/Private/JsgbCapture.cpp, JsgbMedia.cpp and the Mac files
 *  answer them. Read through globalThis so Web Workers (which have no media host) can load this file too. */
export interface MediaHost {
  /** Applies one scene frame (sceneExport.ts layout) completely, draws it from its camera into a width x height
   *  picture now, and returns [width int32, height int32] then RGBA rows from the top: sRGB bytes, or linear float32
   *  when float is set. Null when nothing could be drawn. */
  captureView?(floats: ArrayBuffer, count: number, inst: ArrayBuffer, instCount: number, width: number, height: number, float: boolean): ArrayBuffer | null;
  /** RGBA8 rows from the top as a JPEG or PNG file ("jpeg" or "png"); quality 0..1 for JPEG. */
  encodeImage?(rgba: ArrayBuffer, width: number, height: number, type: string, quality: number): ArrayBuffer | null;
  /** A save dialog with this suggested name: an id to poll. take answers "" while it is open, then "cancel" or
   *  "ok:<file name>". write puts bytes in the chosen file (append adds to what an earlier write put there). */
  savePick?(name: string, typesJson: string): number;
  saveTake?(id: number): string;
  saveWrite?(id: number, bytes: ArrayBuffer, append: boolean): boolean;
  /** Writes a download into the Downloads folder under a free name; returns that name, or "" when it failed. */
  download?(name: string, bytes: ArrayBuffer): string;
  /** H.264 video encoding: open returns a session id (0 when this host can't encode the config). encode takes RGBA8
   *  rows from the top. take returns the chunks out so far: per chunk [key int32, size int32, timestamp float64,
   *  duration float64, bytes padded to 8], after a first block [descriptionSize int32, 0 int32, description padded to 8]. */
  videoSupported?(json: string): boolean;
  videoOpen?(json: string): number;
  videoEncode?(id: number, rgba: ArrayBuffer, width: number, height: number, timestampUs: number, durationUs: number, key: boolean): boolean;
  videoTake?(id: number): ArrayBuffer | null;
  videoFlush?(id: number): boolean;
  videoClose?(id: number): void;
}

export const media = (): MediaHost | undefined => (globalThis as {__jsgbHost?: {media?: MediaHost}}).__jsgbHost?.media;

/** A decoded picture, rows from the top. */
export type Pixels = {width: number; height: number; data: Uint8ClampedArray};
