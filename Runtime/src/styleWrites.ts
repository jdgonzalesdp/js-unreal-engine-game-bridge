/** Inline style writes are attribute mutations, as in a browser. linkedom stores a write through el.style (a property,
 *  setProperty or removeProperty) straight into the style attribute's value once the attribute exists, so no
 *  MutationObserver heard it. The overlay is republished only after a mutation (ui.ts), so anything a page moves by its
 *  inline style alone stayed where it was in the overlay until something else on the page changed. PrepViz's cue strip
 *  is one: it slides its film of cues under the playhead by the film's transform, and in Unreal the cues sat off the
 *  playhead after a scrub on an otherwise still page.
 *  Each element's style object is wrapped once. A write that changed the attribute sets the attribute to its own new
 *  value, which is what queues linkedom's mutation record (its oldValue is the new value, not the old one). A write
 *  that changed nothing queues none, as in a browser. */
import {domPage} from './dom';

type El = Record<string, any>;

function installStyleWrites(proto: El) {
  let owner: El | null = proto;
  while (owner && !Object.getOwnPropertyDescriptor(owner, 'style')?.get) owner = Object.getPrototypeOf(owner);
  const own = owner && Object.getOwnPropertyDescriptor(owner, 'style');
  if (!owner || !own?.get) return;
  const read = own.get;
  const wrapped = new WeakMap<object, object>();
  /** Runs a write on el's style and queues a record for it when the attribute changed. */
  const writing = <T>(el: El, write: () => T): T => {
    const before = el.getAttribute('style');
    const result = write();
    const attr = el.getAttributeNode('style');
    if (attr && attr.value !== before) attr.value = attr.value;
    return result;
  };
  Object.defineProperty(owner, 'style', {configurable: true, enumerable: own.enumerable, set: own.set, get(this: El) {
    const style = read.call(this) as object;
    let view = wrapped.get(style);
    if (view) return view;
    const el = this;
    const setProperty = (...a: unknown[]) => writing(el, () => (style as El).setProperty(...a));
    const removeProperty = (...a: unknown[]) => writing(el, () => (style as El).removeProperty(...a));
    view = new Proxy(style, {
      get: (t, k) => k === 'setProperty' ? setProperty : k === 'removeProperty' ? removeProperty : Reflect.get(t, k),
      set: (t, k, v) => writing(el, () => Reflect.set(t, k, v)),
    });
    wrapped.set(style, view);
    return view;
  }});
}

installStyleWrites(domPage.Element.prototype as El);
