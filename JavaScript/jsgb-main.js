// Puerts entry for JsGameBridge (AJsgbHost). Installs __jsgbHost from the native bridge, loads the
// game bundle built by Tools/jsgb.mjs, and binds the host's per-frame and input delegates.
const puerts = require('puerts');
const bridge = puerts.argv.getByName('Bridge');
const EMPTY = new ArrayBuffer(0);
const buf = b => b || EMPTY;

// Blob URLs shared with threaded workers (see polyfills.ts BlobStore).
globalThis.__jsgbBlobs = {
  put: (url, bytes, type) => bridge.BlobPut(url, bytes, type),
  get: url => { const b = bridge.BlobGet(url); return b && b.byteLength > 0 ? {bytes: b, type: bridge.BlobType(url)} : null; },
  revoke: url => bridge.BlobRevoke(url),
};
globalThis.__jsgbHost = {
  search: bridge.Search,
  // The page's address (Runtime/src/location.ts, Source/JsGameBridge/Private/JsgbAddress.cpp).
  origin: bridge.Origin || undefined,
  path: bridge.PagePath || undefined,
  setAddress: bridge.SetAddress ? address => bridge.SetAddress(String(address)) : undefined,
  openExternal: bridge.OpenExternal ? url => !!bridge.OpenExternal(String(url)) : undefined,
  platform: bridge.Platform,
  // Native dialogs, the clipboard, the light or dark look and the time zone (Runtime/src/dialogs.ts, clipboard.ts,
  // appearance.ts, timeZones.ts; Source/JsGameBridge/Private/JsgbSystem.cpp).
  dialog: bridge.ShowDialog ? (kind, message, value) => String(bridge.ShowDialog(String(kind), String(message ?? ''), String(value ?? '')) || '0') : undefined,
  clipboard: bridge.ClipboardWrite ? {types: () => bridge.ClipboardTypes() || '[]', text: type => bridge.ClipboardText(String(type)) || '',
    image: () => { const b = bridge.ClipboardImage(); return b && b.byteLength > 0 ? b : null; }, files: () => bridge.ClipboardFiles() || '[]',
    write: (texts, png) => !!bridge.ClipboardWrite(String(texts), buf(png))} : undefined,
  colorScheme: bridge.ColorScheme ? () => bridge.ColorScheme() || undefined : undefined,
  timeZone: bridge.TimeZoneName ? bridge.TimeZoneName() || undefined : undefined,
  randomBytes: bridge.RandomBytes ? n => bridge.RandomBytes(n) : undefined,
  httpStart: bridge.HttpStart ? (method, url, headers, body) => bridge.HttpStart(method, url, headers, buf(body)) : undefined,
  httpTake: bridge.HttpTake ? id => { const b = bridge.HttpTake(id); return b && b.byteLength > 0 ? b : null; } : undefined,
  // Streamed requests for the page's fetch (Runtime/src/fetchStream.ts, Source/JsGameBridge/Private/JsgbNetStream.cpp).
  httpStream: bridge.HttpStream ? (method, url, headers, body) => bridge.HttpStream(method, url, headers, buf(body)) : undefined,
  httpRead: bridge.HttpRead ? id => { const b = bridge.HttpRead(id); return b && b.byteLength > 0 ? b : null; } : undefined,
  httpCancel: bridge.HttpCancel ? id => bridge.HttpCancel(id) : undefined,
  // Files the person picks in the open panel or drops on the window (Runtime/src/fileApi.ts, Source/JsGameBridge/Private/JsgbFiles.cpp).
  files: bridge.FilePickOpen ? {open: json => bridge.FilePickOpen(json), take: id => bridge.FilePickTake(id) || null, read: (id, at, n) => bridge.PickedFileRead(id, at, n),
    list: id => bridge.PickedFolderList(id), dropped: () => bridge.DroppedFiles()} : undefined,
  registry: bridge.Registry,
  seed: bridge.Seed,
  fixedStepMs: bridge.FixedStepMs,
  trace: bridge.Trace,
  now: () => bridge.NowMs(),
  workerCreate: (source, url, name) => bridge.WorkerCreate(source, url, name),
  workerPost: (id, bytes) => bridge.WorkerPost(id, bytes),
  workerPoll: () => { const b = bridge.WorkerPoll(); return b && b.byteLength > 0 ? b : null; },
  workerTerminate: id => bridge.WorkerTerminate(id),
  captureRead: id => bridge.CaptureRead(id),
  captureTake: id => { const b = bridge.CaptureTake(id); return b && b.byteLength > 0 ? b : null; },
  // Pictures of the scene, image files, saved files and video (Runtime/src/media.ts, Private/JsgbCapture.cpp, JsgbMedia.cpp).
  media: bridge.CaptureView ? {
    captureView: (f, n, i, ni, w, h, float) => { const b = bridge.CaptureView(f, n, buf(i), ni, w, h, !!float); return b && b.byteLength > 0 ? b : null; },
    // Render target passes run when the page reads one back (Runtime/src/passRun.ts, Private/JsgbPassRunner.cpp).
    passScene: bridge.PassScene ? (f, n, i, ni, slot, w, h, format) => !!bridge.PassScene(f, n, buf(i), ni, slot, w, h, format) : undefined,
    passRun: bridge.PassRun ? json => { const b = bridge.PassRun(String(json)); return b && b.byteLength > 0 ? b : null; } : undefined,
    encodeImage: (rgba, w, h, type, q) => { const b = bridge.EncodeImage(rgba, w, h, type, q); return b && b.byteLength > 0 ? b : null; },
    savePick: (name, types) => bridge.SavePick(name, types), saveTake: id => bridge.SaveTake(id), saveWrite: (id, bytes, append) => !!bridge.SaveWrite(id, bytes, !!append),
    download: (name, bytes) => bridge.Download(name, bytes),
    videoSupported: json => !!bridge.VideoSupported(json), videoOpen: json => bridge.VideoOpen(json), videoFlush: id => !!bridge.VideoFlush(id), videoClose: id => bridge.VideoClose(id),
    videoEncode: (id, rgba, w, h, ts, dur, key) => !!bridge.VideoEncode(id, rgba, w, h, ts, dur, !!key),
    videoTake: id => { const b = bridge.VideoTake(id); return b && b.byteLength > 0 ? b : null; },
  } : undefined,
  readFile: path => { const b = bridge.ReadFile(path); return b && b.byteLength > 0 ? b : null; },
  log: (level, text) => bridge.Log(level, String(text)),
  reload: () => bridge.RequestReload(),
  ready: info => bridge.JsReady(String(info ?? '')),
  cache: {get: key => { const b = bridge.CacheGet(key); return b && b.byteLength > 0 ? b : null; }, put: (key, bytes) => bridge.CachePut(key, bytes)},
  text: (font, size, run) => { const b = bridge.Text(font, size, run); return b && b.byteLength > 0 ? b : null; },
  storage: {load: key => bridge.LoadStore(key) || null, save: (key, data) => bridge.SaveStore(key, data),
    remove: bridge.RemoveStore ? key => bridge.RemoveStore(key) : undefined},
  display: {modes: () => bridge.DisplayModes(), get: () => bridge.DisplayGet(), set: json => bridge.DisplaySet(json)},
  graphics: {get: () => bridge.GraphicsGet(), set: json => bridge.GraphicsSet(json)},
  // window.jsgb.setFrameRate (Runtime/src/frameRate.ts): the most frames a second Unreal presents, 0 for no request.
  frameRate: bridge.SetFrameRate ? fps => bridge.SetFrameRate(+fps || 0) : undefined,
  camera: bridge.CameraTake ? {take: () => bridge.CameraTake(), give: (v, json) => bridge.CameraGive(v, json), config: json => bridge.CameraConfig(json), off: () => bridge.CameraOff()} : undefined,
  sink: {
    geometry: (id, pos, nrm, uv, col, colorSize, idx, groups) => bridge.Geometry(id, buf(pos), buf(nrm), buf(uv), buf(col), colorSize, buf(idx), groups),
    releaseGeometry: id => bridge.ReleaseGeometry(id),
    releaseMaterial: id => bridge.ReleaseMaterial && bridge.ReleaseMaterial(id),
    releaseTexture: id => bridge.ReleaseTexture && bridge.ReleaseTexture(id),
    material: (id, json) => bridge.Material(id, json),
    materialUniforms: bridge.MaterialUniforms ? (id, json) => bridge.MaterialUniforms(id, json) : undefined,
    texture: (id, json, bytes) => bridge.Texture(id, json, buf(bytes)),
    frame: (floats, count, inst, instCount) => bridge.Frame(floats, count, inst, instCount),
    events: json => bridge.Events(json),
    shader: (key, json) => bridge.Shader(key, json),
  },
  ui: {publish: html => bridge.PublishUI(html), canvas: (id, w, h, rgba) => bridge.UICanvas(id, w, h, rgba)},
  audio: {voices: json => bridge.AudioVoices(json), pcm: (id, samples, rate) => bridge.AudioPcm(id, samples, rate), preload: path => bridge.AudioPreload(path)},
};

// V8's sampling profiler for this isolate: __jsgbProfile('start'), then __jsgbProfile('stop C:/path/file.cpuprofile').
globalThis.__jsgbProfile = command => bridge.ProfileJs(String(command));

const guard = (name, fn) => (...args) => { try { return fn(...args); } catch (e) { bridge.Log('error', `${name}: ${e && e.stack || e}`); } };
// Bound before the bundle loads, so a bundle that fails still answers eval.
bridge.OnEval.Bind(source => { try { const r = (0, eval)(source); return typeof r === 'string' ? r : JSON.stringify(r) ?? String(r); } catch (e) { return 'ERR ' + (e && e.stack || e); } });
const t0 = Date.now();
try {
  require(bridge.BundlePath);
} catch (error) {
  bridge.Log('error', 'bundle failed: ' + (error && error.stack || error));
}
const jsgb = globalThis.__jsgb;
if (jsgb) {
  bridge.OnFrame.Bind(guard('frame', budget => { jsgb.frame(budget).catch(e => bridge.Log('error', 'frame: ' + (e && e.stack || e))); }));
  bridge.OnUIInput.Bind(guard('ui', json => jsgb.ui(json)));
  bridge.OnKey.Bind(guard('key', (type, code, repeat) => jsgb.input.key(type, code, repeat)));
  bridge.OnMouse.Bind(guard('mouse', (type, x, y, button, buttons, dx, dy) => jsgb.input.mouse(type, x, y, button, buttons, dx, dy)));
  bridge.OnWheel.Bind(guard('wheel', dy => jsgb.input.wheel(dy)));
  bridge.OnViewport.Bind(guard('viewport', (w, h) => jsgb.viewport(w, h)));
  bridge.OnGamepads.Bind(guard('gamepads', json => jsgb.input.gamepads(json)));
  // A sign-in coming back from the system browser: the page restarts at the callback address.
  if (bridge.OnNavigate) bridge.OnNavigate.Bind(guard('navigate', address => { jsgb.navigate(address); }));
  bridge.Log('log', `bundle loaded in ${Date.now() - t0} ms`);
}
