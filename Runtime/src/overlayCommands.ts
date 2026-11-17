import {host} from './host';

/** Things the page asks of the overlay (JavaScript/jsgb-ui-edit.js) that are not part of its DOM: show this selection,
 *  scroll this panel, run this editing command, go ahead with the key the page let through. They ride with the next UI
 *  publish, in one <meta name="jsgb-commands"> in the published head, numbered, and the overlay runs each number once,
 *  after it has shown the DOM of that publish.
 *  A command is built when the HTML is: elements are named by their data-jsgb id, which an element made this frame only
 *  has once publishUI has stamped the page. Each command then stays in the head for a moment, so a publish the overlay
 *  never applied (its document was reloading) still carries it in the next one. */
type Built = Record<string, unknown>;
type Queued = {n: number; at: number; build: () => Built | null; built?: Built | null; urgent: boolean};
const KEEP_MS = 1500;
// A new page (a restart) numbers from 1 again: the epoch tells the overlay to forget the numbers it ran. (Not
// Math.random, which a seeded run must not draw from.)
const epoch = Date.now().toString(36);
let next = 0, queue: Queued[] = [];

/** Queues a command and gives its number. build runs when the HTML is built and gives the command, or null to drop it.
 *  The overlay reports the last number it ran (seen), so a packet can be told apart as sent before or after. An urgent
 *  command (the answer to a held key, an editing command) goes with the next frame's publish, not the next interval's:
 *  the person is typing. */
export function queueCommand(build: () => Built | null, urgent = false) { queue.push({n: ++next, at: host.now(), build, urgent}); return next; }

/** True when an urgent command waits: publishUI then publishes this frame. */
export const commandsUrgent = () => queue.some(q => q.urgent && q.built === undefined);

/** A connected element's id in the overlay, or null. */
export const overlayId = (el: Record<string, any> | null | undefined): string | null =>
  el && el.nodeType === 1 && el.isConnected ? el.getAttribute('data-jsgb') ?? null : null;

/** True when the next publish has commands to add or drop. */
export function commandsPending() {
  const now = host.now();
  return queue.some(q => q.built === undefined || now - q.at >= KEEP_MS);
}

const attr = (s: string) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** The <meta> publishUI puts in the head, after it has stamped the page; '' when there is nothing to say. */
export function commandMarkup(): string {
  const now = host.now();
  queue = queue.filter(q => now - q.at < KEEP_MS);
  const list: Built[] = [];
  for (const q of queue) {
    if (q.built === undefined) {
      try { q.built = q.build(); } catch (e) { q.built = null; host.log('warn', 'overlay command: ' + (e instanceof Error ? e.message : e)); }
    }
    if (q.built) list.push({...q.built, n: q.n});
  }
  return list.length ? `<meta name="jsgb-commands" content="${attr(JSON.stringify({epoch, list}))}">` : '';
}
