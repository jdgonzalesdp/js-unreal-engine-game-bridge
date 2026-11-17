/** offsetLeft, offsetTop, offsetWidth, offsetHeight and offsetParent, as the overlay laid the element out.
 *  A browser measures these in layout space: from the offset parent's padding edge, before any transform, in whole
 *  pixels. getBoundingClientRect is the other thing: from the viewport, after transforms. They differ wherever an
 *  ancestor is positioned or moved, and a page that slides content with a transform reads offsetLeft precisely because
 *  the slide doesn't show in it. PrepViz's cue strip is one: it slides a film of cues under a still playhead and steers
 *  by each cue's offsetLeft. Answering with the box folded the film's own slide back into where it thought the cues
 *  were, and the cues drifted away from the playhead.
 *  The overlay reports each element's offsets with its box (JavaScript/jsgb-ui-client.js): ol and ot always, ow and oh
 *  when a transform makes them differ from the box, op as the offset parent's id. Before an element's first report,
 *  or from an overlay that sends boxes only, the answers come from the box as they did before. */

type Box = {x: number; y: number; width: number; height: number; ol?: number; ot?: number; ow?: number; oh?: number; op?: string};
type El = Record<string, any>;

export function installLayoutOffsets(proto: El, boxOf: (el: El) => Box | undefined, byId: (id: string) => El | null) {
  const prop = (name: string, get: (el: El) => unknown) =>
    Object.defineProperty(proto, name, {configurable: true, get() { return get(this); }});
  /** The layout report with offsets in it, or nothing. */
  const laid = (el: El) => { const b = boxOf(el); return b && b.ol !== undefined ? b : undefined; };
  const rect = (el: El) => el.getBoundingClientRect() as {x: number; y: number; width: number; height: number};
  prop('offsetLeft', el => laid(el)?.ol ?? rect(el).x);
  prop('offsetTop', el => laid(el)?.ot ?? rect(el).y);
  prop('offsetWidth', el => { const b = laid(el); return b ? b.ow ?? Math.round(b.width) : rect(el).width; });
  prop('offsetHeight', el => { const b = laid(el); return b ? b.oh ?? Math.round(b.height) : rect(el).height; });
  prop('offsetParent', el => { const id = boxOf(el)?.op; return id ? byId(id) : null; });
}
