/** File, FileList and DataTransfer as a browser has them, which Puerts' V8 lacks, and Files whose bytes stay on disk
 *  until the page reads them: the files a person picks in the system's open panel or drops on the window
 *  (filePicker.ts, dragDrop.ts). The host only ever reads the files the person chose (JsgbFiles.cpp). */
const g = globalThis as Record<string, any>;

/** A picked or dropped file as the host describes it. path is the folder-relative path ("Set/props/chair.glb") for a
 *  file inside a chosen folder; top is the index of the dropped item it came with; dir marks a folder. */
export type HostEntry = {id: number; name: string; size: number; modified: number; path?: string; dir?: boolean; top?: number};
/** The host's file service (__jsgbHost.files, JavaScript/jsgb-main.js). open returns a request id, or 0 when the host
 *  has no open panel; take is null while the panel is up, then {"files": [...]} or {"cancel": true}. */
export type HostFiles = {
  open(optionsJson: string): number;
  take(request: number): string | null;
  read(id: number, offset: number, length: number): ArrayBuffer | null;
  list?(id: number): string;
  dropped?(): string;
};
export const hostFiles = (): HostFiles | undefined => g.__jsgbHost?.files;

/** The entries in a host answer: a bare array or {files: [...]}. */
export function parseEntries(json: string | null | undefined): HostEntry[] {
  try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : Array.isArray(v?.files) ? v.files : []; } catch { return []; }
}

/** The MIME type a browser gives a file by its extension; empty when it has none, as for an .obj or .fbx. */
export const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', ico: 'image/x-icon', hdr: 'image/vnd.radiance', exr: 'image/x-exr',
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/x-m4a', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', aif: 'audio/aiff', aiff: 'audio/aiff',
  json: 'application/json', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', html: 'text/html', htm: 'text/html', xml: 'text/xml',
  pdf: 'application/pdf', zip: 'application/zip', fdx: 'application/xml', fountain: 'text/plain',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', usdz: 'model/vnd.usdz+zip', stl: 'model/stl', ply: 'application/octet-stream',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
};
export const extensionOf = (name: string) => { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''; };
export const mimeFor = (name: string) => MIME_BY_EXT[extensionOf(name)] ?? '';

/** File: a Blob with a name and a modification time. */
export function installFile() {
  if (g.File || !g.Blob) return;
  g.File = class File extends g.Blob {
    name: string; lastModified: number; webkitRelativePath = '';
    constructor(parts: unknown[], name: string, opts: {type?: string; lastModified?: number} = {}) {
      super(parts, opts);
      this.name = String(name);
      this.lastModified = Number.isFinite(opts.lastModified) ? Number(opts.lastModified) : Date.now();
    }
    get [Symbol.toStringTag]() { return 'File'; }
  };
  // Blob.stream(): the whole file as one chunk, the stream fetch's Response body is (fetchCore.ts).
  const BP = g.Blob.prototype as Record<string, any>;
  if (!BP.stream) BP.stream = function (this: unknown) { return new g.Response(this).body; };
}
installFile();

/** Reads part of a granted file; throws NotReadableError when the host can't. */
function readRange(id: number, offset: number, length: number): Uint8Array {
  if (length <= 0) return new Uint8Array(0);
  const b = hostFiles()?.read(id, offset, length);
  if (!b || b.byteLength !== length) throw new (g.DOMException ?? Error)('The file could not be read: it may have moved or changed.', 'NotReadableError');
  return new Uint8Array(b);
}
const PART = 8 << 20;
const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));

/** A File whose bytes stay on disk. arrayBuffer() and text() read a fresh copy a part per timer turn, so a large file
 *  never holds the page for long and is not kept twice; a slice reads only its own range. The bytes the runtime itself
 *  needs at once (a blob: URL, new Blob([file]), fetch's Response) are read whole and kept. */
export function hostFile(e: HostEntry): Record<string, any> {
  return rangeBlob(e.id, 0, e.dir ? 0 : Math.max(0, Number(e.size) || 0), e.dir ? '' : mimeFor(e.name), {name: e.name, lastModified: e.modified || 0, path: e.path ?? ''});
}
function rangeBlob(id: number, start: number, size: number, type: string, file?: {name: string; lastModified: number; path: string}): Record<string, any> {
  const blob = Object.create((file ? g.File : g.Blob).prototype) as Record<string, any>;
  let bytes: Uint8Array | null = null;
  const readAll = async (): Promise<Uint8Array> => {
    if (bytes) return bytes.slice();
    const out = new Uint8Array(size);
    for (let at = 0; at < size; at += PART) { if (at) await nextTurn(); out.set(readRange(id, start + at, Math.min(PART, size - at)), at); }
    return out;
  };
  const own = (k: string, value: unknown) => Object.defineProperty(blob, k, {value, writable: true, configurable: true});
  Object.defineProperty(blob, 'bytes', {get: () => bytes ??= readRange(id, start, size), enumerable: true, configurable: true});
  own('size', size); own('type', type);
  own('arrayBuffer', async () => (await readAll()).buffer);
  own('text', async () => new g.TextDecoder().decode(await readAll()));
  own('slice', (a?: number, b?: number, t?: string) => {
    const clamp = (v: number | undefined, d: number) => v === undefined ? d : v < 0 ? Math.max(size + v, 0) : Math.min(v, size);
    const from = clamp(a, 0), to = Math.max(from, clamp(b, size));
    return bytes ? new g.Blob([bytes.subarray(from, to)], {type: t ?? ''}) : rangeBlob(id, start + from, to - from, t ?? '');
  });
  if (file) { own('name', file.name); own('lastModified', file.lastModified); own('webkitRelativePath', file.path); }
  return blob;
}

/** FileList: what input.files and dataTransfer.files hold. */
export class FileList {
  [index: number]: unknown;
  readonly length: number;
  constructor(files: unknown[] = []) { files.forEach((f, i) => { this[i] = f; }); this.length = files.length; }
  item(i: number) { return this[i] ?? null; }
  *[Symbol.iterator]() { for (let i = 0; i < this.length; i++) yield this[i]; }
  get [Symbol.toStringTag]() { return 'FileList'; }
}
g.FileList ??= FileList;

/** One entry of dataTransfer.items: a file or a string of some type. */
export class DataTransferItem {
  constructor(readonly kind: 'file' | 'string', readonly type: string, readonly data: unknown, private entry?: () => unknown) {}
  getAsFile() { return this.kind === 'file' ? this.data ?? null : null; }
  getAsString(cb?: (s: string) => void) { if (this.kind === 'string' && cb) setTimeout(() => cb(String(this.data)), 0); }
  webkitGetAsEntry() { return this.entry?.() ?? null; }
}

const dataType = (type: string) => { const t = String(type ?? '').toLowerCase(); return t === 'text' ? 'text/plain' : t === 'url' ? 'text/uri-list' : t; };

/** DataTransfer: a drag's data and files, and what a page sets input.files from (new DataTransfer(), items.add). */
export class DataTransfer {
  dropEffect = 'none'; effectAllowed = 'all';
  private list: DataTransferItem[] = [];
  /** A drag from outside the page shows only its kinds and types until the drop (the browser's protected mode). */
  private shown: {kind: 'file' | 'string'; type: string}[] | null = null;
  /** Shows only kinds and types (dragenter and dragover from outside), or everything again (null). */
  protect(shown: {kind: 'file' | 'string'; type: string}[] | null) { this.shown = shown; }
  /** Adds a file with its file system entry (webkitGetAsEntry). */
  addFile(file: unknown, entry?: () => unknown) { this.list.push(new DataTransferItem('file', (file as {type?: string})?.type ?? '', file, entry)); }
  /** Kinds and types of everything it holds, whatever is shown. */
  kinds(): {kind: 'file' | 'string'; type: string}[] { return this.list.map(i => ({kind: i.kind, type: i.type})); }
  private visible(): DataTransferItem[] { return this.shown ? this.shown.map(s => new DataTransferItem(s.kind, s.type, null)) : this.list; }
  get items() {
    const list = this.list, v = this.visible(), self = this;
    const view: Record<string | number | symbol, unknown> = {
      length: v.length,
      add(data: unknown, type?: string) {
        if (self.shown) return null;
        const item = typeof data === 'string' ? new DataTransferItem('string', dataType(type ?? ''), data) : new DataTransferItem('file', (data as {type?: string})?.type ?? '', data);
        if (item.kind === 'string') self.clearData(item.type);
        list.push(item); return item;
      },
      remove(i: number) { if (!self.shown) list.splice(i, 1); },
      clear() { if (!self.shown) list.length = 0; },
      [Symbol.iterator]: () => v[Symbol.iterator](),
    };
    v.forEach((it, i) => { view[i] = it; });
    return view;
  }
  get files() { return new FileList(this.shown ? [] : this.list.filter(i => i.kind === 'file').map(i => i.getAsFile())); }
  get types() { return [...new Set(this.visible().map(i => i.kind === 'file' ? 'Files' : i.type))]; }
  getData(type: string) { return this.shown ? '' : String(this.list.find(i => i.kind === 'string' && i.type === dataType(type))?.data ?? ''); }
  setData(type: string, value: string) { if (!this.shown) (this.items as {add(d: unknown, t: string): unknown}).add(String(value), type); }
  clearData(type?: string) {
    if (this.shown) return;
    const keep = this.list.filter(i => i.kind === 'file' || (type !== undefined && i.type !== dataType(type)));
    this.list.length = 0; this.list.push(...keep);
  }
  setDragImage() {}
}
g.DataTransfer ??= DataTransfer;
g.DataTransferItem ??= DataTransferItem;
