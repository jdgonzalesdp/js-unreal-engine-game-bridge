/** Saving files, as a browser saves them: window.showSaveFilePicker opens the system save dialog and its writable
 *  writes the chosen file, and a click on a download link (<a download>) writes its blob: or data: URL into the
 *  Downloads folder. The host does the writing (JsgbMedia.cpp, JsgbSavePanelMac.mm); the page names no paths. */
import {media} from './media';
import {base64Bytes} from './base64';
import {blobStore} from './polyfills';
import {domPage} from './dom';
import {onDownloadLink} from './location';

const g = globalThis as Record<string, any>;
const domError = (message: string, name: string) => new (g.DOMException ?? Error)(message, name);

/** Bytes of anything FileSystemWritableFileStream.write takes. */
async function bytesOf(data: any): Promise<Uint8Array> {
  if (data == null) return new Uint8Array(0);
  if (typeof data === 'string') return new g.TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data.bytes instanceof Uint8Array) return data.bytes;
  if (typeof data.arrayBuffer === 'function') return new Uint8Array(await data.arrayBuffer());
  if (typeof data === 'object' && 'data' in data) return bytesOf(data.data);
  return new g.TextEncoder().encode(String(data));
}
const own = (b: Uint8Array) => b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer as ArrayBuffer : b.slice().buffer as ArrayBuffer;

/** The file a save dialog chose: everything written goes to the host when the writable closes, as one file. */
class SaveHandle {
  readonly kind = 'file';
  constructor(private readonly id: number, readonly name: string) {}
  async createWritable() {
    const parts: Uint8Array[] = []; let open = true;
    const id = this.id;
    return {
      async write(data: any) {
        if (!open) throw domError('The stream is closed', 'InvalidStateError');
        if (data && typeof data === 'object' && data.type === 'truncate') { parts.length = 0; return; }
        parts.push(await bytesOf(data));
      },
      async close() {
        if (!open) return; open = false;
        const total = parts.reduce((n, p) => n + p.length, 0), all = new Uint8Array(total);
        let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
        if (!media()?.saveWrite?.(id, own(all), false)) throw domError('The file could not be written.', 'NotAllowedError');
      },
      async abort() { open = false; parts.length = 0; },
    };
  }
  async getFile() { return new g.Blob([], {}); }
  async isSameEntry(other: unknown) { return other === this; }
  async queryPermission() { return 'granted'; }
  async requestPermission() { return 'granted'; }
}

async function showSaveFilePicker(options: {suggestedName?: string; types?: unknown[]} = {}) {
  const m = media();
  if (!m?.savePick || !m.saveTake) throw domError('Saving files is not available.', 'NotAllowedError');
  const name = String(options.suggestedName ?? 'Untitled');
  const id = m.savePick(name, JSON.stringify(options.types ?? []));
  if (!id) throw domError('The save dialog could not open.', 'NotAllowedError');
  for (;;) {
    const answer = m.saveTake(id);
    if (answer === 'cancel') throw domError('The user aborted a request.', 'AbortError');
    if (answer.startsWith('ok:')) return new SaveHandle(id, answer.slice(3) || name);
    await new Promise<void>(r => setTimeout(r, 50));
  }
}

/** Bytes of a link's URL: a blob: URL from URL.createObjectURL, or a data: URL. */
async function linkBytes(href: string): Promise<Uint8Array | null> {
  if (href.startsWith('blob:')) { const b = blobStore.get(href); return b ? bytesOf(b) : null; }
  if (href.startsWith('data:')) {
    const comma = href.indexOf(','), meta = href.slice(5, comma), body = href.slice(comma + 1);
    return meta.endsWith(';base64') ? base64Bytes(body) : new g.TextEncoder().encode(decodeURIComponent(body));
  }
  return null;
}

/** A download link's default action: its file goes into the Downloads folder. */
export function downloadLink(link: Record<string, any>) {
  const href = String(link.href ?? link.getAttribute?.('href') ?? '');
  const fallback = href.split(/[?#]/)[0].split('/').pop() || 'download';
  const name = String(link.getAttribute?.('download') || link.download || fallback);
  void linkBytes(href).then(bytes => {
    const m = media();
    if (!bytes) { g.console?.warn?.(`download ${name}: only blob: and data: links download here`); return; }
    const saved = m?.download?.(name, own(bytes));
    if (saved) g.console?.log?.(`downloaded ${saved}`); else g.console?.error?.(`download ${name} failed`);
  }, error => g.console?.error?.(`download ${name}: ${error}`));
}

/** a.click() on a download link downloads after the click event, unless a listener cancelled it. */
function installLinkClick() {
  const P = (domPage.HTMLAnchorElement ?? g.HTMLAnchorElement)?.prototype as Record<string, any> | undefined;
  if (!P) return;
  const click = P.click as ((this: unknown) => void) | undefined;
  P.click = function (this: Record<string, any>) {
    if (!this.hasAttribute?.('download')) return click?.call(this);
    const ok = this.dispatchEvent(new g.MouseEvent('click', {bubbles: true, cancelable: true}));
    if (ok) downloadLink(this);
  };
}

export function installDownloads() {
  if (!media()?.savePick && !media()?.download) return;
  if (media()?.savePick && typeof g.showSaveFilePicker !== 'function') g.showSaveFilePicker = showSaveFilePicker;
  installLinkClick();
  onDownloadLink(downloadLink);
}
installDownloads();
