import {host} from './host';
import {pollWorkers} from './worker';
import {frameCount} from './frameCount';

/** Timers and animation frames driven by the host's tick, so the game advances only when Unreal
 *  steps it. `pumpFrame` runs everything that is due, yielding to promise jobs between batches. */
type Timer = {id: number; due: number; fn: (...a: unknown[]) => void; args: unknown[]; every: number; immediate?: boolean; where?: string};
const timers = new Map<number, Timer>();
let nextId = 1;
let frameCallbacks: Array<[number, FrameRequestCallback]> = [];

const g = globalThis as Record<string, unknown>;
const perf = (g.performance ??= {}) as Record<string, unknown>;
perf.now = () => host.now();
perf.timeOrigin ??= Date.now() - host.now();
/** Wall-clock milliseconds, for timing the bridge itself (Date.now may follow the game clock). */
export const wallNow: () => number = Date.now.bind(Date);
/** Time spent in the last pumpFrame: timers, the slowest timer callback, and animation-frame callbacks. */
export const pumpTiming = {workersMs: 0, workerReplies: 0, timersMs: 0, timerCalls: 0, slowestMs: 0, slowest: '', slowestWhere: '', rafMs: 0, rafCalls: 0};

/** Where a timer was scheduled (first caller frames), so a multi-second callback can be named in the
 *  slow-frame log. Anonymous/bound callbacks alone ("slowest 4703 ms in bound ") identified nothing.
 *  Puerts stacks came back empty in the field, so the callback's own source head stands in. */
const scheduledAt = (fn: (...a: unknown[]) => void): string => {
  const stack = new Error().stack?.split('\n').slice(2, 4).join(' <- ').trim();
  return (stack || String(fn).replace(/\s+/g, ' ')).slice(0, 220);
};
// With stepped game time, Date.now follows the same clock, as the browser capture does.
if (host.fixedStepMs) { const origin = perf.timeOrigin as number; Date.now = () => Math.floor(origin + host.now()); }
for (const m of ['mark', 'measure', 'clearMarks', 'clearMeasures']) perf[m] ??= () => undefined;
perf.getEntriesByName ??= () => []; perf.getEntriesByType ??= () => []; perf.getEntries ??= () => [];
perf.memory ??= {usedJSHeapSize: 0, totalJSHeapSize: 0, jsHeapSizeLimit: 4e9};
g.PerformanceObserver ??= class { observe() {} disconnect() {} takeRecords() { return []; } static supportedEntryTypes = []; };
g.setTimeout = (fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]) => {
  const id = nextId++; timers.set(id, {id, due: host.now() + Math.max(0, +ms || 0), fn, args, every: -1, where: scheduledAt(fn)}); return id;
};
g.setInterval = (fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]) => {
  const id = nextId++, every = Math.max(1, +ms || 0); timers.set(id, {id, due: host.now() + every, fn, args, every, where: scheduledAt(fn)}); return id;
};
g.clearTimeout = g.clearInterval = (id: number) => { timers.delete(id); };
// No browser has setImmediate: its callers are Node-style libraries, IndexedDB (fake-indexeddb) above all, whose events
// need the promise jobs they start to finish before its next step (checkpoint below).
g.setImmediate = (fn: (...a: unknown[]) => void, ...args: unknown[]) => {
  const id = nextId++; timers.set(id, {id, due: host.now(), fn, args, every: -1, immediate: true, where: scheduledAt(fn)}); return id;
};
g.clearImmediate = g.clearTimeout;
g.queueMicrotask ??= (fn: () => void) => { void Promise.resolve().then(fn); };
g.requestAnimationFrame = (fn: FrameRequestCallback) => { const id = nextId++; frameCallbacks.push([id, fn]); return id; };
g.cancelAnimationFrame = (id: number) => { frameCallbacks = frameCallbacks.filter(([i]) => i !== id); };
g.requestIdleCallback = (fn: (d: {timeRemaining(): number; didTimeout: boolean}) => void) =>
  (g.setTimeout as (f: () => void, ms: number) => number)(() => fn({timeRemaining: () => 8, didTimeout: false}), 1);
g.cancelIdleCallback = g.clearTimeout;

function report(error: unknown) {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  host.log('error', 'Uncaught ' + text);
}

const yieldJobs = () => new Promise<void>(resolve => resolve());
/** A browser's microtask checkpoint after a task, as near as JavaScript gets: promise chains the callback started run
 *  on (up to 32 hops) before the next timer. IndexedDB keeps a transaction open only while they do. The hops stop
 *  at the pump's deadline: a suspended hop resumes on a later host tick, so an unbounded checkpoint inside a long
 *  run of immediates (an IndexedDB autosave laying down hundreds of steps) held one pump for seconds of wall time
 *  and starved pointer input — the canvas froze mid-pan while the mouse kept moving. */
async function checkpoint(deadline: number) { for (let i = 0; i < 32 && wallNow() < deadline; i++) await yieldJobs(); }

/** Runs due timers, several passes so 0 ms chains progress within one tick, for about `budgetMs`. The budget is
 *  wall time and is checked before every callback, not only between passes: one pass of due immediates, each
 *  with its checkpoint, otherwise overran an 8 ms budget by seconds. What does not run stays due for the next
 *  pump, so a long transaction spreads over frames instead of freezing one. */
export async function runTimers(budgetMs: number): Promise<void> {
  const start = host.now();
  const deadline = wallNow() + budgetMs;
  for (let pass = 0; pass < 200; pass++) {
    const now = host.now();
    const due = [...timers.values()].filter(t => t.due <= now).sort((a, b) => a.due - b.due || a.id - b.id);
    if (!due.length) { await yieldJobs(); if (pass > 0 && ![...timers.values()].some(t => t.due <= host.now())) break; continue; }
    let overBudget = false;
    for (const t of due) {
      if (!timers.has(t.id)) continue;
      if (wallNow() > deadline) { overBudget = true; break; }
      if (t.every >= 0) t.due = now + t.every; else timers.delete(t.id);
      const t0 = wallNow();
      try { t.fn(...t.args); } catch (e) { report(e); }
      // The callback alone is timed: an immediate's checkpoint waits on promise jobs, and counting that
      // wait made every IndexedDB step look like the slowest callback of its frame.
      const took = wallNow() - t0; pumpTiming.timerCalls++;
      if (took > pumpTiming.slowestMs) {
        pumpTiming.slowestMs = took;
        pumpTiming.slowest = (t.fn as {name?: string}).name || '(anonymous)';
        pumpTiming.slowestWhere = t.where ?? '';
      }
      if (t.immediate) await checkpoint(deadline);
    }
    if (overBudget) break;
    await yieldJobs();
    if (host.now() - start > budgetMs) break;
  }
}

/** Runs due timers (runTimers) and then one round of animation-frame callbacks. `budgetMs` bounds the timer passes. */
export async function pumpFrame(budgetMs: number): Promise<void> {
  const pollStart = wallNow();
  pumpTiming.workerReplies = pollWorkers();
  pumpTiming.workersMs = wallNow() - pollStart;
  const wallStart = wallNow();
  pumpTiming.timerCalls = 0; pumpTiming.slowestMs = 0; pumpTiming.slowest = ''; pumpTiming.slowestWhere = '';
  await runTimers(budgetMs);
  const rafStart = wallNow();
  pumpTiming.timersMs = rafStart - wallStart;
  const run = frameCallbacks; frameCallbacks = [];
  frameCount.animation++;
  const ts = host.now();
  for (const [, fn] of run) { try { fn(ts); } catch (e) { report(e); } }
  await yieldJobs();
  pumpTiming.rafMs = wallNow() - rafStart; pumpTiming.rafCalls = run.length;
}

export const pendingTimers = () => timers.size;
/** A setImmediate task is waiting: IndexedDB has a step to run (a leave waits for these, leave.ts). */
export function immediatesPending(): boolean { for (const t of timers.values()) if (t.immediate) return true; return false; }

