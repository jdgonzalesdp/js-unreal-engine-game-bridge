/** Why an abort happened, as browsers report it. The runtime's AbortController (polyfills.ts, used where V8 has none)
 *  aborted with a plain Error whose message was "AbortError", so code that tells a cancelled request from a failed one
 *  by `error.name === 'AbortError'` (PrepViz does in 43 places: superseded map fetches, cancelled saves) took every
 *  abort for a failure. Here abort() without a reason gives a DOMException named AbortError, AbortSignal.timeout one
 *  named TimeoutError, AbortSignal.any passes the first signal's reason on, and AbortSignal.abort(reason) exists.
 *  An engine with a native AbortController keeps it. */
const g = globalThis as Record<string, any>;

const domError = (message: string, name: string) => {
  if (typeof g.DOMException === 'function') return new g.DOMException(message, name);
  return Object.assign(new Error(message), {name});
};

export function installAbortReasons() {
  const Controller = g.AbortController, Signal = g.AbortSignal;
  if (typeof Controller !== 'function' || /\[native code\]/.test(Function.prototype.toString.call(Controller)) || Controller.prototype.__jsgbReasons) return;
  const abort = Controller.prototype.abort as (this: unknown, reason?: unknown) => void;
  Controller.prototype.abort = function (this: unknown, reason?: unknown) { abort.call(this, reason === undefined ? domError('signal is aborted without reason', 'AbortError') : reason); };
  Controller.prototype.__jsgbReasons = true;
  if (!Signal) return;
  type S = {aborted: boolean; reason: unknown; addEventListener(t: string, f: () => void): void};
  Signal.timeout = (ms: number) => { const c = new Controller(); g.setTimeout(() => c.abort(domError('signal timed out', 'TimeoutError')), ms); return c.signal; };
  Signal.any = (signals: Iterable<S>) => {
    const c = new Controller();
    for (const s of signals) {
      if (s.aborted) { c.abort(s.reason); break; }
      s.addEventListener('abort', () => { if (!c.signal.aborted) c.abort(s.reason); });
    }
    return c.signal;
  };
  if (typeof Signal.abort !== 'function') Signal.abort = (reason?: unknown) => { const c = new Controller(); c.abort(reason); return c.signal; };
}
