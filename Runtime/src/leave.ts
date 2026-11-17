/** Leaving the page, as a browser does it before it unloads one: a restart the page asks for (location.ts), and the
 *  host's quit, end of play and hot reload (entry.ts __jsgb.leave, JsgbHost.cpp LeavePage).
 *
 *  A local-first web app keeps its unsaved work in its leave handlers: beforeunload, pagehide and visibilitychange
 *  to hidden. What those handlers start (IndexedDB requests, promise steps) runs on later timer turns, so the page
 *  gets a short time to finish it: at least LEAVE_MIN_MS, then for as long as anything says it is still busy, at most
 *  LEAVE_MAX_MS. Then its storage is written out and the page stops. The events fire once per page. */
import {host} from './host';

const g = globalThis as Record<string, any>;
export const LEAVE_MIN_MS = 50, LEAVE_MAX_MS = 2000;
/** Wall-clock time, taken before timers.ts can make Date.now follow a stepped game clock that stands still while the
 *  host waits for the page at a quit. */
const wallNow = Date.now.bind(Date);

/** When the leave handlers returned: Infinity until then, so nothing settles while they run. */
let fired = false, firedAt = Infinity;
let left = false;
const busyChecks: Array<() => boolean> = [];

/** Something that can still be writing the page's work: IndexedDB (indexedDb.ts) and its timer tasks (entry.ts). */
export function onLeaveBusy(check: () => boolean) { busyChecks.push(check); }
export function leaveBusy(): boolean {
  for (const check of busyChecks) { try { if (check()) return true; } catch { /* a broken check never holds the page */ } }
  return false;
}

/** beforeunload, pagehide, then visibilitychange with the document hidden: once per page. */
export function fireLeave() {
  if (fired) return;
  fired = true;
  const fire = (target: Record<string, any> | undefined, type: string) => {
    try { target?.dispatchEvent?.(new g.Event(type, {cancelable: type === 'beforeunload'})); } catch (e) { host.log('error', `${type}: ${e instanceof Error ? e.stack : e}`); }
  };
  fire(g, 'beforeunload');
  fire(g, 'pagehide');
  try {
    Object.defineProperty(g.document, 'visibilityState', {get: () => 'hidden', configurable: true});
    Object.defineProperty(g.document, 'hidden', {get: () => true, configurable: true});
  } catch { /* a read-only document */ }
  fire(g.document, 'visibilitychange');
  // The wait counts from here: what the handlers started (promise steps, IndexedDB requests) has not run yet, and a
  // handler that took longer than LEAVE_MIN_MS must not use up the page's time to finish it.
  firedAt = wallNow();
}

function settled(): boolean {
  const t = wallNow() - firedAt;
  return t >= LEAVE_MAX_MS || (t >= LEAVE_MIN_MS && !leaveBusy());
}

/** Leaves the page from inside it: the events fire, the page's own timers run what they started, and `done` (save
 *  storage, restart) is called once that has settled. */
export function leaveThen(done: () => void) {
  fireLeave();
  const check = () => {
    if (!left && !settled()) { g.setTimeout(check, 4); return; }
    left = true;
    done();
  };
  check();
}

/** One step of a leave the host drives: the first fires the events, each runs the page's due timers (whose promise
 *  jobs run as the host's call returns). True once the page has settled and storage is written out; the host calls
 *  it until then, or until its own limit, and then once with `force` to write out whatever there is. */
export function leaveStep(flush: () => void, runTimers: () => void, force = false): boolean {
  if (!left && !force) {
    fireLeave();
    if (!settled()) { runTimers(); return false; }
  }
  left = true;
  flush();
  return true;
}
