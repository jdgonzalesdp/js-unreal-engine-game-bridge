/** The native host the bundle runs inside. The Puerts bootstrap (Unreal) and the Node smoke harness
 *  both install `globalThis.__jsgbHost` before the bundle loads. Game code never calls this. */
export interface SceneSink {
  geometry(id: number, positions: ArrayBuffer, normals: ArrayBuffer | null, uvs: ArrayBuffer | null, colors: ArrayBuffer | null, colorSize: number, indices: ArrayBuffer | null, groups: string): void;
  releaseGeometry(id: number): void;
  /** A material or texture the game disposed of, or no longer holds: the host frees its Unreal copy. */
  releaseMaterial?(id: number): void;
  releaseTexture?(id: number): void;
  material(id: number, json: string): void;
  /** Colour, map and uniform values of a material described before, when nothing else about it changed. */
  materialUniforms?(id: number, json: string): void;
  texture(id: number, json: string, bytes: ArrayBuffer | null): void;
  frame(floats: ArrayBuffer, count: number, instanceData: ArrayBuffer, instanceFloats: number): void;
  /** A custom shader translated to an Unreal material body, sent once per shader key. */
  shader?(key: string, json: string): void;
  /** One-shot and keyed events this frame (effects, sounds, camera shakes) as a JSON array. */
  events?(json: string): void;
}

export type BackgroundWorker = {onmessage: ((event: {data: any}) => void) | null; onerror: ((event: any) => void) | null; postMessage(data: unknown): void; terminate(): void};
export interface JsgbHost {
  /** Internal packaging/translator workers may compile synchronously; a live game never does. */
  shaderPreparation?: boolean;
  /** A real worker only: null when this host cannot start a background thread. */
  backgroundWorker?(url: string, name: string): BackgroundWorker | null;
  /** Reads a file below the web build's site root ("/models/x.glb"); null when missing. */
  readFile(path: string): ArrayBuffer | null;
  /** Web Workers on their own threads: create returns 0 when the host runs workers on the game thread. */
  workerCreate?(source: string, url: string, name: string): number;
  workerPost?(id: number, bytes: ArrayBuffer): void;
  /** Replies since the last poll: [id, kind (0 message, 1 error), length, bytes padded to 4] repeated. */
  workerPoll?(): ArrayBuffer | null;
  workerTerminate?(id: number): void;
  /** readRenderTargetPixelsAsync: ask for a capture target's pixels, then poll; take returns [width, height] int32s
   *  and RGBA float32 rows from the top, or null while not ready. */
  captureRead?(textureId: number): void;
  captureTake?(textureId: number): ArrayBuffer | null;
  /** Network requests (netFetch.ts). start returns an id, or 0 when the host refuses the URL (an origin it doesn't
   *  allow); take returns null while the request is in flight, then [status int32 (0 for a network error), headers
   *  JSON byte length int32, headers JSON padded to 4, body]. */
  httpStart?(method: string, url: string, headersJson: string, body: ArrayBuffer | null): number;
  httpTake?(id: number): ArrayBuffer | null;
  /** navigator.platform: "MacIntel" on a Mac, "Win32" on Windows. */
  platform?: string;
  /** What a browser takes from the system (Source/JsGameBridge/Private/JsgbSystem.h): alert, confirm and prompt as a native
   *  dialog the call waits for (dialogs.ts), the clipboard (clipboard.ts), the light or dark look, read again now and
   *  then (appearance.ts, mediaQueries.ts), and the time zone's IANA name (timeZones.ts). */
  dialog?(kind: 'alert' | 'confirm' | 'prompt', message: string, value: string): string;
  clipboard?: {types(): string; text(type: string): string; image(): ArrayBuffer | null; files?(): string; write(textsJson: string, png: ArrayBuffer | null): boolean};
  colorScheme?: string | (() => string | undefined);
  timeZone?: string;
  /** `n` bytes from a secure random generator, for crypto.getRandomValues. */
  randomBytes?(n: number): ArrayBuffer | null;
  /** Monotonic milliseconds. */
  now(): number;
  log(level: 'log' | 'warn' | 'error', text: string): void;
  /** location.search the web build would have (e.g. "?play"). */
  search: string;
  /** The page's origin ("http://localhost:5180") and location.pathname at this start (location.ts). */
  origin?: string;
  path?: string;
  /** The path and query the page starts at next time ("/scene/4?x=1"), kept across restarts. */
  setAddress?(pathAndQuery: string): void;
  /** Opens an http or https URL in the system browser; false when the host refuses it. */
  openExternal?(url: string): boolean;
  /** Log each drawn object's identity the first time it is drawn (-JsgbTraceMirror). */
  trace?: boolean;
  /** Restart the whole game (location.reload). */
  reload(): void;
  /** The game's entry module finished evaluating. */
  ready?(info: string): void;
  /** The display: modes and current settings as JSON, and a change as JSON (see display.ts). */
  display?: {modes(): string; get(): string; set(json: string): void};
  /** Unreal graphics: the current state as JSON {lumen, available}, and a change as JSON (see graphics.ts). */
  graphics?: {get(): string; set(json: string): void};
  /** The most frames a second the game asks Unreal to present, 0 for no request (see frameRate.ts). */
  frameRate?(fps: number): void;
  /** Persistent key/value store for localStorage, sessionStorage and IndexedDB. remove deletes an entry's file (a host
   *  without it gets an empty entry saved instead). */
  storage?: {load(key: string): string | null; save(key: string, data: string): void | boolean; remove?(key: string): void};
  /** The host-driven camera rig (cameraRig.ts). */
  camera?: {take(): string; give(version: number, json: string): void; config(json: string): void; off(): void};
  /** Bytes that outlive a hot reload (the JS environment restarts, the host keeps them). */
  cache?: {get(key: string): ArrayBuffer | null; put(key: string, bytes: ArrayBuffer): void};
  sink?: SceneSink;
  /** The game's DOM UI, serialized for the CEF overlay. */
  ui?: {publish(html: string): void; canvas?(id: string, width: number, height: number, rgba: ArrayBuffer): void};
  /** WebAudio voices as a JSON array of start/update/stop operations. */
  audio?: {voices(json: string): void; pcm?(id: number, samples: ArrayBuffer, sampleRate: number): void; preload?(path: string): void};
  /** Canvas text: alpha mask and metrics for a run (see JsgbBridge::Text). */
  text?(fontPath: string, sizePx: number, run: string): ArrayBuffer | null;
  /** Seed for Math.random (deterministic captures); 0 or absent keeps it random. */
  seed?: number;
  /** Milliseconds per frame when game time is stepped (deterministic captures); 0 or absent for real time. */
  fixedStepMs?: number;
  /** Asset registry JSON ({assets: {key: {mesh, material, niagara, sound}}}); empty when none. */
  registry?: string;
}

const g = globalThis as unknown as {__jsgbHost?: JsgbHost};
export const host: JsgbHost = g.__jsgbHost as JsgbHost;
if (!host) throw Error('JsGameBridge: __jsgbHost is missing. Load the bundle through the Unreal host or Tools/jsgb.mjs smoke.');

export type RegistryEntry = {mesh?: string; material?: string; materialKey?: string; niagara?: string; sound?: string; loop?: boolean; spatial?: boolean; bus?: string};
let registry: Record<string, RegistryEntry> | null = null;
export function assetRegistry(): Record<string, RegistryEntry> {
  if (!registry) {
    try { registry = (JSON.parse(host.registry || '{}').assets ?? {}) as Record<string, RegistryEntry>; }
    catch (error) { host.log('warn', 'asset registry unreadable: ' + error); registry = {}; }
  }
  return registry;
}

let swaps: {assets: boolean; effects: boolean} | null = null;
/** Which registry swaps the game turned on (registry.json "swaps", from Games/<game>.json). */
export function registrySwaps(): {assets: boolean; effects: boolean} {
  if (!swaps) {
    try { const j = JSON.parse(host.registry || '{}').swaps ?? {}; swaps = {assets: !!j.assets, effects: !!j.effects}; }
    catch { swaps = {assets: false, effects: false}; }
  }
  return swaps;
}
