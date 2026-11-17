/** <input type=file>, input.showPicker(), showOpenFilePicker and showDirectoryPicker over the system's open panel
 *  (Source/JsGameBridge/Private/JsgbFileDialogs.mm). As in a browser, a click on a file input that the page doesn't
 *  cancel opens the panel: the input's own click() from the game's code, or a click the person makes on it in the
 *  overlay (a label's click reaches it there too). The chosen files fill input.files, then input and change fire;
 *  closing the panel fires cancel. Their bytes stay on disk until the page reads them (fileApi.ts). */
import {FileList, hostFile, hostFiles, parseEntries, MIME_BY_EXT, type HostEntry} from './fileApi';
import {FileSystemDirectoryHandle, FileSystemFileHandle} from './fileHandles';
import {deliver} from './input';

const g = globalThis as Record<string, any>;
type El = Record<string, any>;

/** accept ("image/*,.glb,model/gltf-binary") as the extensions the open panel lets the person pick; [] for any file.
 *  A MIME type with no known extension is left out; when nothing is left, any file may be picked. */
export function acceptExtensions(accept: string): string[] {
  const out = new Set<string>();
  for (const raw of String(accept ?? '').split(',')) {
    const t = raw.trim().toLowerCase();
    if (t.startsWith('.') && t.length > 1) { out.add(t.slice(1)); continue; }
    const [major, minor] = t.split('/');
    if (!major || !minor) continue;
    for (const [ext, mime] of Object.entries(MIME_BY_EXT)) if (minor === '*' ? mime.startsWith(major + '/') : mime === t) out.add(ext);
  }
  return [...out];
}

export type PickOptions = {multiple: boolean; directory: boolean; extensions: string[]; expand?: boolean};
let panelOpen = false, warned = false;

/** Shows the open panel. Resolves with the chosen entries, or null when the person closed it (or the host has none). */
export function pickFiles(opts: PickOptions): Promise<HostEntry[] | null> {
  const files = hostFiles();
  const request = files ? files.open(JSON.stringify(opts)) : 0;
  if (!request) {
    if (!warned) { warned = true; g.__jsgbHost?.log?.('warn', 'file picker: this host has no open panel, so the pick was cancelled'); }
    return Promise.resolve(null);
  }
  panelOpen = true;
  return new Promise(resolve => {
    const poll = () => {
      const answer = files!.take(request);
      if (answer === null || answer === undefined || answer === '') { setTimeout(poll, 50); return; }
      panelOpen = false;
      let cancelled = true;
      try { cancelled = !!JSON.parse(answer).cancel; } catch { /* unreadable: a cancel */ }
      resolve(cancelled ? null : parseEntries(answer));
    };
    setTimeout(poll, 50);
  });
}
export const pickerOpen = () => panelOpen;

const isFileInput = (el: El) => String(el.getAttribute?.('type') ?? '').toLowerCase() === 'file';
const fileLists = new WeakMap<object, InstanceType<typeof FileList>>();
const fileKey = (f: El) => `${f.name}\n${f.size}\n${f.lastModified}\n${f.webkitRelativePath ?? ''}`;

/** The open panel for one file input, then its events: input and change for a new choice, cancel for a closed panel. */
async function chooseFor(input: El) {
  if (panelOpen) return;
  const directory = input.hasAttribute('webkitdirectory') || input.hasAttribute('directory');
  const entries = await pickFiles({multiple: input.hasAttribute('multiple'), directory, expand: directory,
    extensions: directory ? [] : acceptExtensions(input.getAttribute('accept') ?? '')});
  if (!entries) { deliver(input, new g.Event('cancel', {bubbles: true})); return; }
  const files = entries.filter(e => !e.dir).map(hostFile);
  const before = [...(fileLists.get(input) ?? [])] as El[];
  if (before.length === files.length && before.every((f, i) => fileKey(f) === fileKey(files[i]))) return;
  fileLists.set(input, new FileList(files));
  deliver(input, new g.Event('input', {bubbles: true, composed: true}));
  deliver(input, new g.Event('change', {bubbles: true}));
}

const reflect = (proto: El, prop: string, attr: string, bool: boolean) => {
  if (Object.getOwnPropertyDescriptor(proto, prop)) return;
  Object.defineProperty(proto, prop, {configurable: true,
    get() { return bool ? this.hasAttribute(attr) : this.getAttribute(attr) ?? ''; },
    set(v: unknown) { if (bool) this.toggleAttribute(attr, !!v); else this.setAttribute(attr, String(v)); }});
};
const ownOrInherited = (proto: El, prop: string): PropertyDescriptor | undefined => {
  for (let p = proto; p; p = Object.getPrototypeOf(p)) { const d = Object.getOwnPropertyDescriptor(p, prop); if (d) return d; }
  return undefined;
};

/** Installs file inputs on the page's input elements, and the File System Access pickers on the window. */
export function installFilePicker(page: El) {
  const IP = page.HTMLInputElement?.prototype as El | undefined;
  if (!IP || IP.__jsgbFilePicker) return;
  IP.__jsgbFilePicker = true;
  reflect(IP, 'accept', 'accept', false);
  reflect(IP, 'multiple', 'multiple', true);
  reflect(IP, 'webkitdirectory', 'webkitdirectory', true);
  Object.defineProperty(IP, 'files', {configurable: true,
    get() { if (!isFileInput(this)) return null; let list = fileLists.get(this); if (!list) fileLists.set(this, list = new FileList()); return list; },
    set(v: El) { if (isFileInput(this) && v && typeof v.length === 'number') fileLists.set(this, new FileList(Array.from(v as ArrayLike<unknown>))); }});
  Object.defineProperty(IP, 'webkitEntries', {configurable: true, get() { return []; }});
  // A file input's value is "C:\fakepath\<first file>", as in every browser; setting it to "" clears the choice.
  const value = ownOrInherited(IP, 'value');
  Object.defineProperty(IP, 'value', {configurable: true, enumerable: value?.enumerable,
    get() { if (!isFileInput(this)) return value?.get ? value.get.call(this) : this.getAttribute('value') ?? ''; const f = this.files?.[0] as El | undefined; return f ? 'C:\\fakepath\\' + f.name : ''; },
    set(v: unknown) { if (!isFileInput(this)) { if (value?.set) value.set.call(this, v); else this.setAttribute('value', String(v)); return; } if (v === '' || v === null) fileLists.set(this, new FileList()); }});
  // The panel opens as the click's default action, once every listener has had the chance to cancel it.
  const dispatch = IP.dispatchEvent as (e: El) => boolean;
  IP.dispatchEvent = function (this: El, e: El) {
    const allowed = dispatch.call(this, e);
    if (e?.type === 'click' && isFileInput(this) && !this.hasAttribute('disabled')) void Promise.resolve().then(() => { if (!e.defaultPrevented) void chooseFor(this); });
    return allowed;
  };
  IP.showPicker = function (this: El) {
    if (isFileInput(this)) void chooseFor(this);
  };
  installFileSystemPickers();
}

/** window.showOpenFilePicker and showDirectoryPicker. A closed panel rejects with AbortError, as in Chrome. */
function installFileSystemPickers() {
  const abort = () => new (g.DOMException ?? Error)('The user aborted a request.', 'AbortError');
  const busy = () => new (g.DOMException ?? Error)('File picker already active.', 'NotAllowedError');
  g.showOpenFilePicker ??= async (o: {multiple?: boolean; types?: {accept?: Record<string, string | string[]>}[]} = {}) => {
    if (panelOpen) throw busy();
    const accept = (o.types ?? []).flatMap(t => Object.entries(t.accept ?? {}).flatMap(([mime, exts]) => {
      const list = ([] as string[]).concat(exts ?? []);
      return list.length ? list : [mime];
    })).join(',');
    const entries = await pickFiles({multiple: !!o.multiple, directory: false, extensions: acceptExtensions(accept)});
    if (!entries) throw abort();
    return entries.filter(e => !e.dir).map(e => new FileSystemFileHandle(e));
  };
  g.showDirectoryPicker ??= async () => {
    if (panelOpen) throw busy();
    const entries = await pickFiles({multiple: false, directory: true, extensions: [], expand: false});
    const dir = entries?.find(e => e.dir);
    if (!dir) throw abort();
    return new FileSystemDirectoryHandle(dir);
  };
}
