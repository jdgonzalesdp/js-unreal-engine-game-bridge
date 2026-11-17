/** navigator.locks (the Web Locks API) for the one page the host runs: requests for the same name run one after the
 *  other. auth0-spa-js takes a lock around every token refresh, and without this API falls back to a lock kept in
 *  localStorage that polls on timers. Shared mode is treated as exclusive, which only makes readers wait their turn. */
const g = globalThis as Record<string, any>;

type Options = {mode?: string; ifAvailable?: boolean; steal?: boolean; signal?: {aborted?: boolean; reason?: unknown; addEventListener?: (t: string, f: () => void) => void}};
type Callback = (lock: {name: string; mode: string} | null) => unknown;

const abortError = (reason: unknown) => (reason as {name?: string} | undefined)?.name === 'AbortError' ? reason
  : Object.assign(new (g.DOMException ?? Error)('The lock request was aborted.', 'AbortError'), {name: 'AbortError'});

/** Resolves when turn settles, or rejects when signal aborts first. */
function waitTurn(turn: Promise<unknown>, signal: Options['signal']) {
  if (!signal) return turn;
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise<void>((resolve, reject) => {
    turn.then(() => resolve(), () => resolve());
    signal.addEventListener?.('abort', () => reject(abortError(signal.reason)));
  });
}

export function installLocks(nav: Record<string, any>) {
  if (nav.locks?.request) return;
  const tails = new Map<string, Promise<void>>();
  const held = new Map<string, number>();
  nav.locks = {
    async request(name: string, options: Options | Callback, callback?: Callback) {
      const cb = (typeof options === 'function' ? options : callback) as Callback;
      const opts = (typeof options === 'function' ? {} : options ?? {}) as Options;
      const key = String(name), mode = opts.mode === 'shared' ? 'shared' : 'exclusive';
      if (opts.ifAvailable && (held.get(key) ?? 0) > 0) return cb(null);
      const before = tails.get(key) ?? Promise.resolve();
      let release = () => {};
      const mine = new Promise<void>(resolve => { release = resolve; });
      // The next request waits for this one, which waits for the one before it even when it gives up early.
      const tail = before.then(() => mine);
      tails.set(key, tail);
      held.set(key, (held.get(key) ?? 0) + 1);
      try {
        await waitTurn(before, opts.signal);
        return await cb({name: key, mode});
      } finally {
        release();
        held.set(key, (held.get(key) ?? 1) - 1);
        void tail.then(() => { if (tails.get(key) === tail) { tails.delete(key); held.delete(key); } });
      }
    },
    async query() { return {held: [...held.entries()].filter(([, n]) => n > 0).map(([name]) => ({name, mode: 'exclusive'})), pending: []}; },
  };
}

installLocks(g.navigator ??= {});
