import {deliver} from './input';
import {setFieldState} from './formValue';
import {editingHost} from './editHosts';
import {commandMarkup, commandsPending, commandsUrgent, queueCommand} from './overlayCommands';
import {applyRegionEdit, refreshRegions, regionStart} from './editMirror';
import './editCommands';
import {fromOverlay, noteOverlayEdit, takeOverlaySelection} from './selectionMirror';
import {takeOverlayScroll} from './scrollMirror';
import './penEvents';
import {deliverClipboard, deliverComposition} from './pasteEvents';
import {withRelated} from './focusEvents';
import {focusFromOverlay} from './focusMirror';

/** The overlay's text editing, selection and scrolling, as uiInput hands them over (JavaScript/jsgb-ui-edit.js sends
 *  them). Packets that carry a selection (sel, fsel) set the page's first, so a key handler reads the caret the person
 *  sees. Some packets come "held": the overlay kept back the browser's default (a key that edits rich text, a paste, a
 *  toolbar button pressed while a field is focused) because the page may cancel it. Such an event is delivered here,
 *  and the page's answer goes back as a command: the overlay then does the default, or doesn't, as a browser would. */
const g = globalThis as Record<string, any>;
type El = Record<string, any>;
export {regionStart, commandMarkup, commandsUrgent};

/** publishUI asks before it builds the HTML: true when the overlay needs a publish for the editing state alone (a
 *  region's revision went up, a command is waiting). */
export function beforePublish(): boolean { return refreshRegions() || commandsPending(); }

const answer = (held: unknown, ok: boolean) => { if (typeof held === 'number') queueCommand(() => ({k: 'held', held, ok}), true); };

function deliverInput(target: El, p: El) {
  const Ctor = (g.InputEvent ?? g.Event) as new (type: string, init?: El) => El;
  const init = {bubbles: true, cancelable: false, composed: true, inputType: String(p.inputType ?? ''), data: p.data ?? null, isComposing: !!p.isComposing};
  const e = new Ctor('input', init);
  for (const k of ['inputType', 'data', 'isComposing'] as const) if (e[k] === undefined) e[k] = init[k];
  deliver(target, e);
}

/** An edit in the overlay: a field's new value, or an editable region's new HTML. */
function input(p: El, target: El | null) {
  noteOverlayEdit(p.edit);
  if (!target || target.disabled) return;
  const host = typeof p.html === 'string' ? editingHost(target) : null;
  if (host) {
    // An edit made on content the page has changed since is dropped; the overlay then shows the page's.
    if (!applyRegionEdit(host, p.html, p.rev)) return;
    takeOverlaySelection(p, host);
    deliverInput(host, p);
    return;
  }
  // The person's own edit: it goes back to the overlay as nothing (selectionMirror.ts).
  if (p.value !== undefined && 'value' in target) fromOverlay(() => setFieldState(target, 'value', p.value));
  if (p.checked !== undefined) setFieldState(target, 'checked', p.checked);
  takeOverlaySelection(p, target);
  deliverInput(target, p);
}

/** A key the overlay held back: the page's keydown listeners decide, and the overlay types it or not. */
function heldKey(p: El, target: El | null) {
  const doc = g.document, active = doc.activeElement;
  const to = target ?? (active && active !== doc.body && active.isConnected ? active : doc.body);
  answer(p.held, deliver(to, new g.KeyboardEvent('keydown', {...p, bubbles: true, cancelable: true})));
}

/** A press the overlay held back so a focused field kept its focus and selection (a toolbar button). Its default, if
 *  no listener cancels it, is the browser's: the focused element lets go of focus, before any click. */
function heldPress(p: El, target: El | null) {
  const allowed = target && !target.disabled ? deliver(target, new g.MouseEvent('mousedown', {...p, bubbles: true, cancelable: true})) : true;
  const active = g.document.activeElement;
  if (allowed && active && active !== g.document.body && !(target && (active === target || active.contains?.(target)))) active.blur?.();
}

const byId = (id: unknown) => typeof id === 'string' && id ? g.document.querySelector(`[data-jsgb="${id}"]`) : null;

/** Handles a packet uiInput passes on; true when it was this module's to deliver. */
export function overlayEdit(p: El, target: El | null): boolean {
  switch (p.type) {
    // The person moved focus in the overlay: the page's focus follows, firing its events (focusEvents.ts).
    case 'focusin':
      if (target && !target.disabled) withRelated(byId(p.relatedId), () => focusFromOverlay(target));
      return true;
    case 'focusout':
      if (target && g.document.activeElement === target) withRelated(byId(p.relatedId), () => target.blur?.());
      return true;
    case 'scroll': case 'scrollend':
      if (target) takeOverlayScroll(target, p);
      return true;
    case 'selection':
      takeOverlaySelection(p, target);
      return true;
    case 'input':
      input(p, target);
      return true;
    case 'compositionstart': case 'compositionupdate': case 'compositionend':
      if (target) deliverComposition(target, p);
      return true;
    case 'paste': case 'copy': case 'cut':
      takeOverlaySelection(p, target);
      answer(p.held, target ? deliverClipboard(target, p) : true);
      return true;
    case 'keydown':
      takeOverlaySelection(p, target);
      if (p.held === undefined) return false;
      heldKey(p, target);
      return true;
    case 'mousedown':
      if (!p.held) return false;
      heldPress(p, target);
      return true;
    default:
      if (p.sel || p.fsel) takeOverlaySelection(p, target);
      return false;
  }
}
