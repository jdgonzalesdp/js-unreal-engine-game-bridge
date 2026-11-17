/** localStorage and sessionStorage as a browser shows them: each stored item is also a property, so
 *  Object.keys(localStorage) lists the stored keys, localStorage.theme reads one and delete localStorage.theme removes
 *  it. auth0-spa-js finds its cached tokens with Object.keys(window.localStorage), and clears them that way on sign-out:
 *  without this the tokens outlived a sign-out. The store itself is dom.ts makeStorage. */
type Store = {readonly length: number; key(i: number): string | null; getItem(k: string): string | null; setItem(k: string, v: string): void;
  removeItem(k: string): void; clear(): void};

export function asWebStorage<T extends Store>(store: T): T {
  const own = (k: string | symbol) => typeof k === 'symbol' || k in store;
  return new Proxy(store, {
    get: (t, k) => own(k) ? Reflect.get(t, k, t) : t.getItem(k as string) ?? undefined,
    set: (t, k, v) => { if (own(k)) return Reflect.set(t, k, v, t); t.setItem(k as string, String(v)); return true; },
    has: (t, k) => own(k) || t.getItem(k as string) !== null,
    deleteProperty: (t, k) => { if (!own(k)) t.removeItem(k as string); return true; },
    ownKeys: t => { const keys: string[] = []; for (let i = 0; i < t.length; i++) keys.push(t.key(i)!); return keys; },
    getOwnPropertyDescriptor: (t, k) => {
      const value = typeof k === 'string' && !own(k) ? t.getItem(k) : null;
      return value === null ? undefined : {value, writable: true, enumerable: true, configurable: true};
    },
  });
}
