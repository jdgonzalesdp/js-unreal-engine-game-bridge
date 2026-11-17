import {domPage} from './dom';
import {editingHost, isTextField} from './editHosts';
import {queueCommand, overlayId} from './overlayCommands';

/** document.execCommand and its queries. The editable text lives in the overlay, which edits it natively, so a
 *  command (Bold, a heading, a list, insertText) runs there, in the overlay's focused region and at its selection,
 *  which the page's selection mirrors (selectionMirror.ts). Its result comes back as an ordinary edit (editMirror.ts),
 *  with an input event, as a browser's editor fires one. execCommand answers true for a command it sends, as a browser
 *  does for a command it runs; with no editable focus it answers false, as a browser does. The queries read the page's
 *  selection: whether it sits inside bold, italic and so on, and the block it is in. */
type El = Record<string, any>;
const g = globalThis as Record<string, any>;

const COMMANDS = ['backColor', 'bold', 'contentReadOnly', 'createLink', 'decreaseFontSize', 'defaultParagraphSeparator', 'delete', 'fontName',
  'fontSize', 'foreColor', 'formatBlock', 'forwardDelete', 'heading', 'hiliteColor', 'increaseFontSize', 'indent', 'insertBrOnReturn',
  'insertHorizontalRule', 'insertHTML', 'insertImage', 'insertLineBreak', 'insertOrderedList', 'insertParagraph', 'insertText',
  'insertUnorderedList', 'italic', 'justifyCenter', 'justifyFull', 'justifyLeft', 'justifyRight', 'outdent', 'redo', 'removeFormat',
  'selectAll', 'strikeThrough', 'styleWithCSS', 'subscript', 'superscript', 'underline', 'undo', 'unlink', 'useCSS'];
const byName = new Map(COMMANDS.map(c => [c.toLowerCase(), c]));
// Commands a text field takes; the rest act on rich text only.
const FIELD = new Set(['delete', 'forwardDelete', 'insertText', 'insertLineBreak', 'insertParagraph', 'selectAll', 'undo', 'redo']);

/** The focused element a command acts on: an editable region, or a text field for the plain-text commands. */
function editTarget(command: string): El | null {
  const active = g.document.activeElement as El | null;
  if (!active || active === g.document.body) return null;
  const host = editingHost(active);
  if (host) return host;
  return isTextField(active) && FIELD.has(command) ? active : null;
}

/** The page's selection start as an element, inside the region. */
function selectedElement(): El | null {
  const node = g.getSelection?.()?.anchorNode as El | null | undefined;
  return !node ? null : node.nodeType === 1 ? node : node.parentNode ?? null;
}

const TAGS: Record<string, string[]> = {bold: ['B', 'STRONG'], italic: ['I', 'EM'], underline: ['U'], strikethrough: ['S', 'STRIKE', 'DEL'],
  subscript: ['SUB'], superscript: ['SUP'], insertorderedlist: ['OL'], insertunorderedlist: ['UL']};
const STYLE: Record<string, [string, RegExp]> = {bold: ['fontWeight', /^(bold|[6-9]00)$/], italic: ['fontStyle', /^italic$/]};
const BLOCKS = /^(P|DIV|H[1-6]|PRE|BLOCKQUOTE|LI|ADDRESS)$/;

function state(command: string): boolean {
  const host = editTarget(command), tags = TAGS[command.toLowerCase()];
  if (!host || !tags) return false;
  for (let el = selectedElement(); el && el !== host && el.nodeType === 1; el = el.parentNode) {
    if (tags.includes(el.tagName)) return true;
    const style = STYLE[command.toLowerCase()];
    if (style && style[1].test(String(el.style?.[style[0]] ?? ''))) return true;
  }
  return false;
}

function value(command: string): string {
  const host = editTarget(command);
  if (!host) return '';
  if (command.toLowerCase() === 'formatblock') {
    for (let el = selectedElement(); el && el !== host && el.nodeType === 1; el = el.parentNode) if (BLOCKS.test(el.tagName)) return el.tagName.toLowerCase();
    return '';
  }
  return state(command) ? 'true' : '';
}

let installed = false;
/** Installs the editing commands over whatever execCommand the page had: commands this doesn't run (copy, cut and paste:
 *  clipboardCommands.ts) still go to it. */
export function installEditCommands() {
  if (installed) return;
  installed = true;
  const doc = domPage.document as El;
  const prior = (name: string) => typeof doc[name] === 'function' ? (doc[name] as (...a: unknown[]) => unknown).bind(doc) : null;
  const exec = prior('execCommand'), supported = prior('queryCommandSupported'), enabled = prior('queryCommandEnabled');
  const state0 = prior('queryCommandState'), value0 = prior('queryCommandValue');
  const known = (name: unknown) => byName.get(String(name).toLowerCase());
  doc.execCommand = function (name: unknown, ui?: unknown, arg?: unknown) {
    const command = known(name);
    if (!command) return exec ? exec(name, ui, arg) : false;
    const host = editTarget(command);
    if (!host) return false;
    queueCommand(() => { const id = overlayId(host); return id ? {k: 'exec', id, cmd: command, value: arg == null ? null : String(arg)} : null; }, true);
    return true;
  };
  doc.queryCommandSupported = (name: unknown) => !!known(name) || !!supported?.(name);
  doc.queryCommandEnabled = (name: unknown) => { const c = known(name); return c ? !!editTarget(c) : !!enabled?.(name); };
  doc.queryCommandState = (name: unknown) => { const c = known(name); return c ? state(c) : !!state0?.(name); };
  doc.queryCommandIndeterm = () => false;
  doc.queryCommandValue = (name: unknown) => { const c = known(name); return c ? value(c) : String(value0?.(name) ?? ''); };
}
installEditCommands();
