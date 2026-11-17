/** The copy, cut and paste commands a browser runs outside text fields, with their events and clipboardData:
 *  - The keys (Cmd on a Mac, Ctrl elsewhere, with C, X or V). Outside a text field the overlay holds the command back
 *    and sends the key, marked (JavaScript/jsgb-ui-client.js). When the page doesn't cancel the key, the event fires
 *    here at the focused element, as the browser's own command would. A copy nobody cancels copies the text the person
 *    selected in the overlay, which comes with the key; a cancelled copy or cut puts the data its listener set on the
 *    clipboard. A paste's clipboardData holds the clipboard's text and HTML, and its picture as image.png or the files
 *    copied in the Finder (read lazily, like dropped files, fileApi.ts).
 *  - document.execCommand('copy') and ('cut'): the same event, then the page's own selection to the clipboard, as
 *    copy-to-clipboard libraries expect (they select a hidden field's text first).
 *  In a text field the overlay runs the commands itself and reports their events (overlayEdits.ts, pasteEvents.ts). */
import {host} from './host';
import {deliver} from './input';
import {DataTransfer, hostFile, parseEntries} from './fileApi';
import {TEXT_TYPES, clipboardTypes, systemClipboard, writeClipboard} from './clipboard';

const g = globalThis as Record<string, any>;
type El = Record<string, any>;
type Kind = 'copy' | 'cut' | 'paste';
type Data = InstanceType<typeof DataTransfer>;

/** The clipboard's contents, as a paste event's clipboardData. */
export function pasteData(): Data {
  const dt = new DataTransfer(), clip = systemClipboard(), types = clipboardTypes();
  for (const type of TEXT_TYPES) if (types.includes(type)) dt.setData(type, clip.text(type) ?? '');
  if (types.includes('Files')) {
    for (const entry of parseEntries(clip.files?.() ?? '[]')) dt.addFile(hostFile(entry));
  } else if (types.includes('image/png')) {
    const png = clip.image();
    if (png && png.byteLength && g.File) dt.addFile(new g.File([png], 'image.png', {type: 'image/png'}));
  }
  return dt;
}

/** What a cancelled copy or cut's listener set (its strings) goes on the clipboard, as in a browser; nothing when it set
 *  nothing. True when something was written. */
export function commitClipboard(dt: Data): boolean {
  const texts: Record<string, string> = {};
  for (const type of dt.types) if (type !== 'Files') texts[type] = dt.getData(type);
  return Object.keys(texts).length > 0 && writeClipboard(texts);
}

/** Fires copy, cut or paste at target; true when no listener cancelled it. clipboardData is made when a listener first
 *  reads it, so a key the page handles on its own (its shape paste) never reads a large picture off the clipboard. */
function fire(kind: Kind, target: El): boolean {
  const Ctor = g.ClipboardEvent ?? g.Event;
  const event = new Ctor(kind, {bubbles: true, cancelable: true, composed: true, clipboardData: null});
  const made: {dt: Data | null} = {dt: null};
  const data = () => (made.dt ??= kind === 'paste' ? pasteData() : new DataTransfer());
  Object.defineProperty(event, 'clipboardData', {configurable: true, enumerable: true, get: data});
  const allowed = deliver(target, event);
  if (!allowed && kind !== 'paste' && made.dt) commitClipboard(made.dt);
  return allowed;
}

const MAC = /^Mac/.test(String(host.platform ?? ''));
const COMMANDS: Record<string, Kind> = {KeyC: 'copy', KeyX: 'cut', KeyV: 'paste', c: 'copy', x: 'cut', v: 'paste'};
/** The command a key runs: Cmd (Mac) or Ctrl (elsewhere) with C, X or V and no other modifier. */
export function shortcutCommand(p: El): Kind | null {
  const held = MAC ? p.metaKey && !p.ctrlKey : p.ctrlKey && !p.metaKey;
  if (!held || p.altKey || p.shiftKey) return null;
  return COMMANDS[String(p.code ?? '')] ?? COMMANDS[String(p.key ?? '').toLowerCase()] ?? null;
}

/** After a key press the page didn't cancel (ui.ts): the copy, cut or paste the overlay held back (p.clip). */
export function clipboardShortcut(target: El, p: El) {
  const kind = p.clip ? shortcutCommand(p) : null;
  if (!kind) return;
  if (fire(kind, target) && kind === 'copy' && p.selection) writeClipboard({'text/plain': String(p.selection)});
}

/** The page's own selection: the focused field's selected text, else the document's. */
function pageSelection(): {text: string; field: El | null} {
  const active = g.document.activeElement as El | null;
  if (active && /^(INPUT|TEXTAREA)$/.test(String(active.tagName)) && typeof active.selectionStart === 'number') {
    return {text: String(active.value ?? '').slice(active.selectionStart, active.selectionEnd), field: active};
  }
  return {text: String(g.getSelection?.() ?? ''), field: null};
}

/** document.execCommand('copy' | 'cut'): the event, then the selection to the clipboard (a cut also takes it out of
 *  its field). True, as a browser answers once the command ran. */
function execClipboard(kind: 'copy' | 'cut'): boolean {
  const doc = g.document, active = doc.activeElement as El | null;
  if (!fire(kind, active && active !== doc.body ? active : doc.body)) return true;
  const {text, field} = pageSelection();
  if (!text) return true;
  writeClipboard({'text/plain': text});
  if (kind === 'cut' && field && !field.readOnly && !field.disabled && typeof field.setRangeText === 'function') {
    field.setRangeText('', field.selectionStart, field.selectionEnd, 'end');
    const Input = g.InputEvent ?? g.Event;
    deliver(field, new Input('input', {bubbles: true, cancelable: false, inputType: 'deleteByCut'}));
  }
  return true;
}

/** Wraps document.execCommand and the queryCommand answers for copy and cut; other commands keep what they had. */
export function installClipboardCommands() {
  const doc = g.document as El | undefined;
  if (!doc || doc.__jsgbClipboardCommands) return;
  doc.__jsgbClipboardCommands = true;
  const exec = typeof doc.execCommand === 'function' ? doc.execCommand.bind(doc) : null;
  const supported = typeof doc.queryCommandSupported === 'function' ? doc.queryCommandSupported.bind(doc) : null;
  const enabled = typeof doc.queryCommandEnabled === 'function' ? doc.queryCommandEnabled.bind(doc) : null;
  const named = (c: unknown) => String(c ?? '').toLowerCase();
  doc.execCommand = (command: string, ui?: boolean, value?: string) => {
    const c = named(command);
    return c === 'copy' || c === 'cut' ? execClipboard(c) : exec ? exec(command, ui, value) : false;
  };
  doc.queryCommandSupported = (command: string) => /^(copy|cut|paste)$/.test(named(command)) || !!supported?.(command);
  doc.queryCommandEnabled = (command: string) => /^(copy|cut)$/.test(named(command)) || !!enabled?.(command);
}
installClipboardCommands();
