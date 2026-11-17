/** navigator.clipboard, ClipboardItem and ClipboardEvent as a browser has them, over the system clipboard
 *  (__jsgbHost.clipboard: the general pasteboard on a Mac, Source/JsGameBridge/Private/JsgbClipboardMac.mm). Text, HTML
 *  and PNG pictures go both ways, as in Chrome. The stand-in this replaces answered every write and wrote nothing, so a
 *  page said "Copied" with nothing on the clipboard. A host without a clipboard (the Node smoke test) gets one kept in
 *  memory, so a page's copy and paste still round-trip. Copy, cut and paste events are clipboardEvents.ts. */
import {host} from './host';

const g = globalThis as Record<string, any>;
/** The host's clipboard (JavaScript/jsgb-main.js). types is a JSON array of web types ("Files" for copied files);
 *  text and image read one type; files describes copied files as the page reads them (fileApi.ts); write replaces the
 *  clipboard with {type: text} and an optional PNG as one item. */
export type HostClipboard = {
  types(): string;
  text(type: string): string;
  image(): ArrayBuffer | null;
  files?(): string;
  write(textsJson: string, png: ArrayBuffer | null): boolean;
};

/** The text types the clipboard carries both ways; with image/png, what ClipboardItem.supports answers yes to. */
export const TEXT_TYPES = ['text/plain', 'text/html', 'text/uri-list'];
const SUPPORTED = new Set([...TEXT_TYPES, 'image/png']);

let memory: HostClipboard | null = null;
function memoryClipboard(): HostClipboard {
  let texts: Record<string, string> = {}, png: ArrayBuffer | null = null;
  return {
    types: () => JSON.stringify([...Object.keys(texts), ...(png ? ['image/png'] : [])]),
    text: type => texts[type] ?? '',
    image: () => png,
    files: () => '[]',
    write(json, bytes) { texts = JSON.parse(json) as Record<string, string>; png = bytes && bytes.byteLength ? bytes : null; return true; },
  };
}
/** The system clipboard, or the in-memory one. */
export const systemClipboard = (): HostClipboard => (host as {clipboard?: HostClipboard}).clipboard ?? (memory ??= memoryClipboard());

/** The web types on the clipboard now. */
export function clipboardTypes(): string[] {
  try { const v = JSON.parse(systemClipboard().types() || '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

/** Puts texts by web type and an optional PNG on the clipboard, together; false when the host wrote nothing. */
export function writeClipboard(texts: Record<string, string>, png: ArrayBuffer | null = null): boolean {
  try { return !!systemClipboard().write(JSON.stringify(texts), png); }
  catch (error) { host.log('warn', 'clipboard write: ' + error); return false; }
}

const domError = (message: string, name: string) => g.DOMException ? new g.DOMException(message, name) : Object.assign(new Error(message), {name});

/** One clipboard item: its data by type, each a Blob, a string, or a promise of either (as a page builds it). */
export class ClipboardItem {
  private readonly entries: Map<string, unknown>;
  readonly presentationStyle: string;
  constructor(items: Record<string, unknown>, options: {presentationStyle?: string} = {}) {
    const types = Object.keys(items ?? {});
    if (!types.length) throw new TypeError("Failed to construct 'ClipboardItem': At least one entry required.");
    this.entries = new Map(types.map(t => [t, items[t]]));
    this.presentationStyle = options.presentationStyle ?? 'unspecified';
  }
  get types(): readonly string[] { return Object.freeze([...this.entries.keys()]); }
  async getType(type: string): Promise<unknown> {
    if (!this.entries.has(type)) throw domError(`Failed to execute 'getType' on 'ClipboardItem': The type was not found`, 'NotFoundError');
    const value = await this.entries.get(type);
    return g.Blob && value instanceof g.Blob ? value : new g.Blob([String(value)], {type});
  }
  static supports(type: string) { return SUPPORTED.has(String(type)); }
}

/** navigator.clipboard. Reads and writes need no permission prompt here: the page is the app. */
export class Clipboard {
  async readText(): Promise<string> { return systemClipboard().text('text/plain') ?? ''; }
  async writeText(data: unknown): Promise<void> {
    if (!writeClipboard({'text/plain': String(data)})) throw domError('Failed to write to the clipboard.', 'NotAllowedError');
  }
  async read(): Promise<ClipboardItem[]> {
    const clip = systemClipboard(), items: Record<string, unknown> = {};
    for (const type of clipboardTypes()) {
      if (type === 'image/png') { const png = clip.image(); if (png && png.byteLength) items[type] = new g.Blob([png], {type}); }
      else if (TEXT_TYPES.includes(type)) items[type] = new g.Blob([clip.text(type) ?? ''], {type});
    }
    return Object.keys(items).length ? [new ClipboardItem(items)] : [];
  }
  async write(data: ClipboardItem[]): Promise<void> {
    const list = [...(data ?? [])];
    if (list.length > 1) throw domError('Support for multiple ClipboardItems is not implemented.', 'NotAllowedError');
    if (!list.length) return;
    const item = list[0], texts: Record<string, string> = {};
    let png: ArrayBuffer | null = null;
    for (const type of item.types) {
      if (!SUPPORTED.has(type)) throw domError(`Type ${type} not supported on write.`, 'NotAllowedError');
      const blob = await item.getType(type) as {text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer>};
      if (type === 'image/png') png = await blob.arrayBuffer(); else texts[type] = await blob.text();
    }
    if (!writeClipboard(texts, png)) throw domError('Failed to write to the clipboard.', 'NotAllowedError');
  }
  // navigator.clipboard is an EventTarget in a browser; nothing fires on it.
  addEventListener() {} removeEventListener() {} dispatchEvent() { return true; }
}

/** Installs navigator.clipboard, Clipboard, ClipboardItem and ClipboardEvent. */
export function installClipboard() {
  const nav = (g.navigator ??= {}) as Record<string, any>;
  const clipboard = new Clipboard();
  try { Object.defineProperty(nav, 'clipboard', {value: clipboard, configurable: true, writable: true, enumerable: true}); } catch { nav.clipboard = clipboard; }
  g.Clipboard ??= Clipboard;
  g.ClipboardItem ??= ClipboardItem;
  if (!g.ClipboardEvent && g.Event) {
    g.ClipboardEvent = class ClipboardEvent extends g.Event {
      clipboardData: unknown;
      constructor(type: string, init: Record<string, any> = {}) { super(type, init); this.clipboardData = init.clipboardData ?? null; }
    };
  }
}
installClipboard();
