import {host} from './host';
import {layoutBoxes, setViewport, submitForm} from './dom';
import {notifyResizes} from './resizeObserver';
import {deliver} from './input';
import {followLink} from './location';
import {contexts} from './canvas2d';
import {installFieldSupport, setFieldState} from './formValue';
import {focusFromOverlay, installFocusMirror} from './focusMirror';
import {captureTarget, endCapture, installPointerCapture} from './pointerCapture';
import {isDragPacket} from './dragDrop';
import {beforePublish, commandMarkup, commandsUrgent, overlayEdit, regionStart} from './overlayEdits';
import {routeDrag} from './pageDrag';
import {clipboardShortcut} from './clipboardCommands';
// Publishing waits for a mutation, so inline style writes have to be mutations too (styleWrites.ts).
import './styleWrites';

/** Mirrors the game's DOM into the host's CEF overlay. Every element gets a stable data-jsgb id;
 *  the overlay sends back each element's laid-out box and the DOM events the player causes, which
 *  are replayed here on the same elements so the game's own handlers run. */
const g = globalThis as Record<string, any>;
const ATTR = 'data-jsgb';
let serial = 0, dirty = true, last = '', lastPublish = -1e9, lastHoles = '';
installFieldSupport(); installFocusMirror(); installPointerCapture();

function stamp(root: Record<string, any>) {
  if (root.nodeType !== 1) return;
  if (!root.hasAttribute(ATTR)) root.setAttribute(ATTR, String(++serial));
  // Inside an editable region the overlay edits the DOM itself (overlayEdits.ts): no ids there.
  if (!regionStart(root)) for (const child of root.children ?? []) stamp(child);
}

try {
  const observer = new g.MutationObserver(() => { dirty = true; });
  observer.observe(g.document.documentElement, {subtree: true, childList: true, attributes: true, characterData: true});
} catch { /* no observer: publish compares strings every interval */ }

/** Sends the current DOM to the overlay when it changed, at most every `intervalMs`. */
export function publishUI(intervalMs = 100) {
  const out = host.ui; if (!out) return;
  // An answer to a key the overlay held back goes this frame (overlayEdits.ts): the person is typing.
  const now = host.now(); if (now - lastPublish < intervalMs && !commandsUrgent()) return;
  lastPublish = now;
  publishCanvases(out);
  const holes = canvasHoles();
  if (holes !== lastHoles) { lastHoles = holes; dirty = true; }
  if (beforePublish()) dirty = true;
  if (!dirty && last) return;
  dirty = false;
  const body = g.document.body; stamp(body);
  // The <html> element's attributes go too: games set CSS variables there (a HUD zoom, a theme).
  const root = g.document.documentElement as {attributes: {name: string; value: string}[]};
  const attrs = [...root.attributes].map(a => ` ${a.name}="${a.value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`).join('');
  // Styles the game adds to <head> while it runs (UI libraries such as lil-gui inject theirs) go along too.
  const headCss = [...[...(g.document.head?.querySelectorAll('style') ?? [])].map((s: {textContent: string | null}) => s.textContent ?? ''), holes].filter(Boolean).join(String.fromCharCode(10));
  const html = `<html${attrs}><head>${headCss ? `<style data-jsgb-head>${headCss}</style>` : ''}${commandMarkup()}</head>${body.outerHTML}</html>`;
  // The game's own origin is http://localhost/; the overlay loads files from the host's origin, so
  // absolute links to the game origin (new URL(path, document.baseURI)) become root-relative.
  // Blob URLs live in the game's JavaScript; the host serves their shared copies at /bridge/blob/<name>.
  if (html !== last) { last = html; out.publish(html.replaceAll('http://localhost/', '/').replaceAll('"blob:', '"/bridge/blob/')); }
  dirty = false;
}

/** Where the 3D view shows through. Unreal draws it under the overlay, but the page paints its own backgrounds (html,
 *  body, an app root) behind the game's canvas, which in a browser covers them. Every element that holds the canvas
 *  Unreal draws into turns transparent in the overlay; panels beside the canvas keep their backgrounds. */
function canvasHoles() {
  const canvas = g.__jsgbCanvas, doc = g.document, ids: string[] = [];
  if (!canvas?.isConnected) return '';
  for (let el = canvas.parentNode; el && el.nodeType === 1 && el !== doc.documentElement; el = el.parentNode) {
    if (!el.hasAttribute(ATTR)) el.setAttribute(ATTR, String(++serial));
    ids.push(`[${ATTR}="${el.getAttribute(ATTR)}"]`);
  }
  return ids.length ? `${ids.join(',')}{background:transparent!important}` : '';
}

/** The pixels of 2D canvases in the page (a portrait, a minimap): the overlay's copy of the page only has the
 *  element, so each canvas's pixels go to the overlay when they change. */
const sentCanvas = new Map<string, string>(), sentAt = new Map<string, number>();
let canvasPass = 0;
function publishCanvases(out: NonNullable<typeof host.ui>) {
  if (!out.canvas) return;
  for (const ref of contexts) {
    const ctx = ref.deref() as (Record<string, any> & {version: number; bitmap(): {width: number; height: number; data: Uint8ClampedArray}}) | undefined;
    if (!ctx) { contexts.delete(ref); continue; }
    const el = ctx.canvas as Record<string, any>;
    if (!el?.isConnected || el.nodeType !== 1) continue;
    const b = ctx.bitmap();
    if (!b.width || !b.height || b.width * b.height > 1 << 20) continue;
    stamp(el);
    const id = el.getAttribute(ATTR), key = `${ctx.version}:${b.width}x${b.height}`;
    if (sentCanvas.get(id) === key) continue;
    // Pixels go through the overlay as text, so a big canvas (a full-screen layer) updates at most once a second.
    const now = host.now(), big = b.width * b.height > 256 * 256;
    if (big && now - (sentAt.get(id) ?? -1e9) < 1000) continue;
    sentCanvas.set(id, key); sentAt.set(id, now);
    const words = new Uint32Array(b.data.buffer, b.data.byteOffset, b.data.byteLength >> 2);
    let clear = true;
    for (let i = 0; i < words.length; i++) if (words[i] >>> 24) { clear = false; break; }
    out.canvas(id, b.width, b.height, clear ? new ArrayBuffer(0) : b.data.slice().buffer);
  }
  // Forget canvases that left the page now and then.
  if (++canvasPass % 50 === 0) for (const id of sentCanvas.keys()) if (!byId(id)) sentCanvas.delete(id);
}

const byId = (id: string) => g.document.querySelector(`[${ATTR}="${id}"]`);

/** A packet from the overlay: a layout report or a DOM event aimed at a mirrored element. */
export function uiInput(json: string) {
  let p: Record<string, any>;
  try { p = JSON.parse(json); } catch { return; }
  if (p.type === 'host-layout') {
    for (const [id, b] of Object.entries(p.rects ?? {})) layoutBoxes.set(id, b as never);
    if (p.width > 0 && p.height > 0) setViewport(p.width, p.height);
    notifyResizes(true);
    return;
  }
  const doc = g.document, found = p.id ? byId(p.id) : p.selector ? doc.querySelector(p.selector) : null;
  // While an element holds the pointer, moves and the release go to it wherever the pointer is (pointerCapture.ts).
  const target = captureTarget(p, found);
  // Editing, selection, scrolling and clipboard packets (overlayEdits.ts).
  if (overlayEdit(p, target)) return;
  if (p.type === 'keydown' || p.type === 'keyup') {
    // A key with no element: the overlay's focus is on the page itself, so it goes to the body, not a field left behind.
    // No element: the overlay's focus is on the page. A field the game just focused, which the overlay hasn't reached
    // yet, still takes the key while it is in the page; one that left the page or was blurred does not.
    const active = doc.activeElement;
    const keyTarget = target ?? (active && active !== doc.body && active.isConnected ? active : doc.body);
    // A copy, cut or paste key the overlay held back runs its command once the page lets the key through (clipboardCommands.ts).
    if (deliver(keyTarget, new g.KeyboardEvent(p.type, {...p, bubbles: true, cancelable: true})) && p.type === 'keydown') clipboardShortcut(keyTarget, p);
    return;
  }
  if (p.type === 'blur') { g.dispatchEvent(new g.Event('blur')); return; }
  // The overlay's field lost focus, so the page's does too; otherwise later keys and shortcuts still went to it.
  if (p.type === 'focusout' && target && doc.activeElement === target) target.blur?.();
  if (!target || target.disabled) { endCapture(p); return; }
  // Field state comes only with an edit: a hover over a field the game just changed (an undo) must not write back the
  // overlay's older value.
  const edit = p.type === 'input' || p.type === 'change' || p.type === 'click';
  if (edit && p.value !== undefined && 'value' in target) setFieldState(target, 'value', p.value);
  if (edit && p.checked !== undefined) setFieldState(target, 'checked', p.checked);
  if (p.open !== undefined) target.toggleAttribute('open', !!p.open);
  if (p.type === 'focusin') focusFromOverlay(target);
  const init: Record<string, any> = {...p, bubbles: !['pointerenter', 'pointerleave', 'mouseenter', 'mouseleave'].includes(p.type), cancelable: true};
  // The element the pointer came from or went to, so React's enter and leave events fire only where they should.
  if ('relatedId' in p) init.relatedTarget = p.relatedId ? byId(p.relatedId) : null;
  // A captured event's offset is from the capturing element (react-three-fiber aims with offsetX and offsetY).
  if (target !== found) { const r = target.getBoundingClientRect(); init.offsetX = (p.clientX ?? 0) - r.x; init.offsetY = (p.clientY ?? 0) - r.y; }
  // Drags (the page's own, and files from the Finder) carry one DataTransfer from start to drop (dragDrop.ts).
  // The page's own answers (a cancelled dragstart, where a drop may land) apply in pageDrag.ts.
  if (isDragPacket(p.type)) { routeDrag(target, p, init); endCapture(p); return; }
  const Ctor = p.type === 'wheel' ? g.WheelEvent : /^pointer/.test(p.type) ? g.PointerEvent : /^(click|dblclick|contextmenu|mouse)/.test(p.type) ? g.MouseEvent
    : p.type === 'focusin' || p.type === 'focusout' ? g.FocusEvent : g.Event;
  // A click the page didn't cancel on a link follows it, as in a browser (the overlay cancels its own default).
  if (deliver(target, new Ctor(p.type, init)) && p.type === 'click' && !p.button) followLink(target, p);
  endCapture(p);
}

/** The element a script means: a CSS selector, or visible text on a button-like element. */
export function findElement(what: string): Record<string, any> | null {
  const doc = g.document;
  try { const el = doc.querySelector(what); if (el) return el; } catch { /* not a selector */ }
  const hidden = (el: Record<string, any>) => !!el.closest('[hidden]') || (layoutBoxes.get(el.getAttribute(ATTR) ?? '')?.display === 'none');
  const all = [...doc.querySelectorAll('button,a,[role=button],li,div,span,label,option,summary')] as Record<string, any>[];
  return all.find(el => el.textContent.trim() === what && !hidden(el))
    ?? all.filter(el => /^(BUTTON|A)$/.test(el.tagName)).find(el => el.textContent.trim().toUpperCase().includes(String(what).toUpperCase()) && !hidden(el)) ?? null;
}

/** Clicks an element the way the overlay would report a player's click. */
export function clickElement(what: string) {
  const el = findElement(what);
  if (!el) throw Error('click: nothing matches ' + what);
  stamp(g.document.body);
  const id = el.getAttribute(ATTR);
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) uiInput(JSON.stringify({type, id, button: 0, buttons: type.endsWith('down') ? 1 : 0}));
  // The browser's default action for a submit button: submit its form. (The overlay's real browser
  // does this itself and forwards the submit event, so only scripted clicks need it here.)
  const button = el.closest('button,input[type=submit]');
  const form = button?.closest('form');
  if (form && (button.getAttribute('type') ?? 'submit').toLowerCase() === 'submit' && !button.hasAttribute('disabled')) submitForm(form, button);
  return el.tagName + '#' + id + ' ' + String(el.textContent).trim().slice(0, 40);
}
