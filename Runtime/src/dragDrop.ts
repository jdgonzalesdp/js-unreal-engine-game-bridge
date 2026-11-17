/** HTML drag and drop, as the overlay reports it (JavaScript/jsgb-ui-client.js): the page dragging one of its own
 *  elements, and files dragged in from the Finder. The overlay accepts every drag so its web view never navigates to a
 *  dropped file; the drag's data lives here, in one DataTransfer for the whole drag, written in dragstart and read in
 *  drop. Until the drop, a listener sees only the kinds and types of what is dragged, as in a browser. A drop of files
 *  reads them from the host, which noted them as they landed on the window (JsgbFileDialogs.mm), and they read lazily
 *  like picked files (fileApi.ts). */
import {DataTransfer, hostFile, hostFiles, parseEntries} from './fileApi';
import {FileSystemEntry} from './fileHandles';
import {deliver} from './input';

const g = globalThis as Record<string, any>;
type El = Record<string, any>;
type Shown = {kind: 'file' | 'string'; type: string}[];

const DRAG = /^(dragstart|drag|dragend|dragenter|dragover|dragleave|drop)$/;
export const isDragPacket = (type: unknown) => typeof type === 'string' && DRAG.test(type);

function dragEventClass() {
  if (g.DragEvent) return g.DragEvent;
  const Base = g.MouseEvent ?? g.Event;
  g.DragEvent = class DragEvent extends Base {
    dataTransfer: unknown;
    constructor(type: string, init: Record<string, any> = {}) { super(type, init); this.dataTransfer = init.dataTransfer ?? null; }
  };
  return g.DragEvent;
}
if (g.Event) dragEventClass();

/** The drag in progress: its data, and whether it came from outside the page. */
let session: {dt: InstanceType<typeof DataTransfer>; external: boolean; filled: boolean} | null = null;
/** The drag in progress, and ending it without telling the page (pageDrag.ts applies the page's answers to it). */
export const dragSession = () => session ? {dt: session.dt, external: session.external} : null;
export function dropSession() { session = null; }

/** What the overlay saw of an outside drag: kinds and types ({items: [{kind, type}], types}). */
function shownFrom(info: El): Shown {
  const items = Array.isArray(info.items) ? info.items as {kind?: string; type?: string}[] : [];
  if (items.length) return items.map(i => ({kind: i.kind === 'file' ? 'file' : 'string', type: String(i.type ?? '')}));
  const types = Array.isArray(info.types) ? info.types as string[] : [];
  return types.map(t => t === 'Files' ? {kind: 'file', type: ''} : {kind: 'string', type: t});
}

/** At the drop: the files the host saw land, and any text the drag carried. */
const carriesFiles = (info: El) => Number(info.files) > 0 || (Array.isArray(info.types) && info.types.includes('Files'));

function fillDrop(dt: InstanceType<typeof DataTransfer>, info: El) {
  const files = carriesFiles(info);
  const entries = files ? parseEntries(hostFiles()?.dropped?.() ?? '[]') : [];
  for (const e of entries) dt.addFile(hostFile(e), () => new FileSystemEntry(e, '/' + e.name));
  if (files && !entries.length) g.__jsgbHost?.log?.('warn', 'drop: the overlay reported files, but the host saw none land');
  for (const [type, value] of Object.entries((info.data ?? {}) as Record<string, string>)) if (type !== 'Files') dt.setData(type, String(value));
}

/** Delivers one drag event from the overlay to its element; false when a listener cancelled it. */
export function deliverDrag(target: El, p: El, init: El): boolean {
  const info = (p.drag ?? {}) as El;
  // Files coming in while a page drag of no files seems open: that drag ended without a dragend, and this one is new.
  if (session && !session.external && p.type === 'dragenter' && carriesFiles(info) && !session.dt.kinds().some(k => k.kind === 'file')) session = null;
  if (p.type === 'dragstart') session = {dt: new DataTransfer(), external: false, filled: true};
  else if (!session && /^(dragenter|dragover|drop)$/.test(p.type)) session = {dt: new DataTransfer(), external: true, filled: false};
  const s = session ?? {dt: new DataTransfer(), external: true, filled: true};
  const dt = s.dt;
  if (p.type === 'drop') {
    dt.protect(null);
    if (!s.filled) { s.filled = true; fillDrop(dt, info); }
  } else if (p.type !== 'dragstart') {
    dt.protect(s.external ? shownFrom(info) : dt.kinds());
  }
  if (typeof info.effectAllowed === 'string' && s.external) dt.effectAllowed = info.effectAllowed;
  if (p.type === 'dragenter' || p.type === 'dragover') dt.dropEffect = s.external ? 'copy' : 'move';
  const Drag = dragEventClass();
  const allowed = deliver(target, new Drag(p.type, {...init, dataTransfer: dt}));
  // The drag is over at its drop or its end, or when an outside drag leaves the window.
  if (p.type === 'drop' || p.type === 'dragend' || (p.type === 'dragleave' && s.external && !p.relatedId)) session = null;
  return allowed;
}
