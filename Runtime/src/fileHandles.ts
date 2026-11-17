/** The handles and entries a browser gives for picked or dropped files and folders: FileSystemFileHandle and
 *  FileSystemDirectoryHandle (showOpenFilePicker, showDirectoryPicker) and the older FileSystemEntry family
 *  (dataTransfer.items[i].webkitGetAsEntry() on a drop). They read; writing is not offered, so a page that feature-tests
 *  createWritable takes its download path. A folder's contents come from the host one level at a time. */
import {hostFile, hostFiles, parseEntries, type HostEntry} from './fileApi';

const g = globalThis as Record<string, any>;
const domError = (message: string, name: string) => new (g.DOMException ?? Error)(message, name);

/** A folder's entries, asked of the host once per folder. */
const listings = new Map<number, HostEntry[]>();
function children(dir: HostEntry): HostEntry[] {
  let list = listings.get(dir.id);
  if (!list) listings.set(dir.id, list = parseEntries(hostFiles()?.list?.(dir.id) ?? '[]'));
  return list;
}

export class FileSystemHandle {
  constructor(readonly kind: 'file' | 'directory', readonly name: string, protected readonly entry: HostEntry) {}
  async isSameEntry(other: unknown) { return other instanceof FileSystemHandle && other.kind === this.kind && other.entry.id === this.entry.id; }
  async queryPermission(o?: {mode?: string}) { return o?.mode === 'readwrite' ? 'denied' : 'granted'; }
  async requestPermission(o?: {mode?: string}) { return this.queryPermission(o); }
}

export class FileSystemFileHandle extends FileSystemHandle {
  constructor(entry: HostEntry) { super('file', entry.name, entry); }
  async getFile() { return hostFile(this.entry); }
}

export class FileSystemDirectoryHandle extends FileSystemHandle {
  constructor(entry: HostEntry) { super('directory', entry.name, entry); }
  private wrap(e: HostEntry): FileSystemHandle { return e.dir ? new FileSystemDirectoryHandle(e) : new FileSystemFileHandle(e); }
  async *entries(): AsyncGenerator<[string, FileSystemHandle]> { for (const e of children(this.entry)) yield [e.name, this.wrap(e)]; }
  async *keys(): AsyncGenerator<string> { for (const e of children(this.entry)) yield e.name; }
  async *values(): AsyncGenerator<FileSystemHandle> { for (const e of children(this.entry)) yield this.wrap(e); }
  [Symbol.asyncIterator]() { return this.entries(); }
  private find(name: string, dir: boolean, create?: boolean) {
    const e = children(this.entry).find(c => c.name === name);
    if (e && !!e.dir === dir) return e;
    if (e) throw domError(`"${name}" is not a ${dir ? 'folder' : 'file'}.`, 'TypeMismatchError');
    throw create ? domError('Writing to this folder is not allowed.', 'NotAllowedError') : domError(`"${name}" was not found.`, 'NotFoundError');
  }
  async getFileHandle(name: string, o?: {create?: boolean}) { return new FileSystemFileHandle(this.find(name, false, o?.create)); }
  async getDirectoryHandle(name: string, o?: {create?: boolean}) { return new FileSystemDirectoryHandle(this.find(name, true, o?.create)); }
  async removeEntry() { throw domError('Writing to this folder is not allowed.', 'NotAllowedError'); }
  async resolve(): Promise<string[] | null> { return null; }
}

g.FileSystemHandle ??= FileSystemHandle;
g.FileSystemFileHandle ??= FileSystemFileHandle;
g.FileSystemDirectoryHandle ??= FileSystemDirectoryHandle;

/** A dropped file or folder as webkitGetAsEntry gives it. */
export class FileSystemEntry {
  readonly isFile: boolean; readonly isDirectory: boolean; readonly name: string;
  readonly filesystem = {name: 'jsgb-drop', root: null as unknown};
  constructor(protected readonly entry: HostEntry, readonly fullPath: string) {
    this.isDirectory = !!entry.dir; this.isFile = !entry.dir; this.name = entry.name;
  }
  /** A file entry's File. */
  file(ok: (f: unknown) => void, fail?: (e: unknown) => void) {
    setTimeout(() => { if (this.isFile) ok(hostFile(this.entry)); else fail?.(domError('Not a file.', 'TypeMismatchError')); }, 0);
  }
  /** A folder entry's reader: the first readEntries gives every entry, the next an empty list, as browsers end. */
  createReader() {
    let done = false;
    return {readEntries: (ok: (list: FileSystemEntry[]) => void, fail?: (e: unknown) => void) => setTimeout(() => {
      if (!this.isDirectory) { fail?.(domError('Not a folder.', 'TypeMismatchError')); return; }
      const list = done ? [] : children(this.entry).map(e => new FileSystemEntry(e, `${this.fullPath}/${e.name}`));
      done = true; ok(list);
    }, 0)};
  }
  getParent(ok: (e: unknown) => void) { setTimeout(() => ok(this), 0); }
}
g.FileSystemEntry ??= FileSystemEntry;
g.FileSystemFileEntry ??= FileSystemEntry;
g.FileSystemDirectoryEntry ??= FileSystemEntry;
