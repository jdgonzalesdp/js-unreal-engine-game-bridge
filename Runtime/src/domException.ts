/** DOMException for V8 builds without one (Puerts' V8 9.4 has none). IndexedDB reports its failures as DOMExceptions,
 *  and fake-indexeddb's error classes extend DOMException when their module loads, so this runs before it. */
const g = globalThis as Record<string, any>;

const CODES: Record<string, number> = {IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4, InvalidCharacterError: 5,
  NoModificationAllowedError: 7, NotFoundError: 8, NotSupportedError: 9, InvalidStateError: 11, SyntaxError: 12, InvalidModificationError: 13,
  NamespaceError: 14, InvalidAccessError: 15, TypeMismatchError: 17, SecurityError: 18, NetworkError: 19, AbortError: 20, URLMismatchError: 21,
  QuotaExceededError: 22, TimeoutError: 23, InvalidNodeTypeError: 24, DataCloneError: 25};

if (typeof g.DOMException !== 'function') {
  class DOMException extends Error {
    constructor(message?: unknown, options?: unknown) {
      super(message === undefined ? '' : String(message));
      // The second argument is the name, or (newer browsers) an options object holding it.
      const name = options && typeof options === 'object' ? (options as {name?: unknown}).name : options;
      Object.defineProperty(this, 'name', {value: name === undefined ? 'Error' : String(name), writable: true, configurable: true});
    }
    get code() { return CODES[this.name] ?? 0; }
  }
  g.DOMException = DOMException;
}

export {};
