/** prefers-color-scheme follows the system while the page runs, as in a browser. The host answers with the system's
 *  look (__jsgbHost.colorScheme(): "dark" or "light" from the Mac's appearance, JsgbSystemMac.mm), which
 *  mediaQueries.ts reads for every query. Here the answer is looked at once a second, and when the person switches
 *  between Light and Dark each query a page listens to whose answer changed fires "change" (recheckMedia). */
import {recheckMedia} from './mediaQueries';

const g = globalThis as Record<string, any>;

function scheme(): unknown {
  const s = g.__jsgbHost?.colorScheme;
  try { return typeof s === 'function' ? s() : s; } catch { return null; }
}

let last = scheme();
/** Fires the media query changes when the system's look changed since the last look; true when it changed. */
export function checkAppearance(): boolean {
  const now = scheme();
  if (now === last) return false;
  last = now;
  recheckMedia();
  return true;
}

// Only a host that can tell a change (a function, not a fixed answer) is asked again. The look never keeps a Node test
// process alive (unref); the runtime's own timers have no unref.
if (typeof g.__jsgbHost?.colorScheme === 'function' && typeof g.setInterval === 'function') g.setInterval(checkAppearance, 1000)?.unref?.();
