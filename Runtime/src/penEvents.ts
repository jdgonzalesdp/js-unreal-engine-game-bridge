/** Pointer events with what a pen and a fast mouse report in a browser: tilt, twist, altitude and azimuth, and the
 *  samples a pointermove gathers between two frames (getCoalescedEvents) with the ones the browser predicts next
 *  (getPredictedEvents). The overlay sends a move's samples with it (JavaScript/jsgb-ui-edit.js); a freehand stroke
 *  then follows the pen at its own rate instead of once a frame. */
type El = Record<string, any>;
const g = globalThis as Record<string, any>;
const PEN: Record<string, unknown> = {tiltX: 0, tiltY: 0, twist: 0, tangentialPressure: 0, altitudeAngle: Math.PI / 2, azimuthAngle: 0};
// What a sample shares with the event it came in.
const SHARED = ['pointerId', 'pointerType', 'isPrimary', 'button', 'buttons', 'ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'bubbles'];
const MOVES = new Set(['pointermove', 'pointerrawupdate']);
const samples = new WeakMap<object, {coalesced?: El[]; predicted?: El[]}>();

function list(event: El, raw: unknown): El[] {
  if (!Array.isArray(raw)) return [];
  const Ctor = event.constructor as new (type: string, init: El) => El;
  return raw.map((s: El) => {
    const init: El = {};
    for (const k of SHARED) init[k] = event[k];
    Object.assign(init, s, {bubbles: false, cancelable: false});
    // Offsets follow the event's own, which uiInput set for the element the event went to.
    init.offsetX = (event.offsetX ?? 0) + num(s.clientX) - (event.clientX ?? 0);
    init.offsetY = (event.offsetY ?? 0) + num(s.clientY) - (event.clientY ?? 0);
    init.pageX = s.clientX; init.pageY = s.clientY;
    const sample = new Ctor(event.type, init);
    try { Object.defineProperty(sample, 'timeStamp', {value: (event.timeStamp ?? 0) + num(s.dt), configurable: true}); } catch { /* read-only */ }
    return sample;
  });
}
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function aimed(event: El, items: El[]) {
  // A sample's target is its event's, as the browser sets it when the event is dispatched.
  for (const s of items) { try { Object.defineProperty(s, 'target', {value: event.target ?? null, configurable: true}); } catch { /* read-only */ } }
  return items;
}

let installed = false;
export function installPenEvents() {
  const Base = g.PointerEvent as (new (type: string, init?: El) => El) | undefined;
  if (installed || !Base || typeof Base.prototype.getCoalescedEvents === 'function') return;
  installed = true;
  class PointerEvent extends Base {
    constructor(type: string, init: El = {}) {
      super(type, init);
      const self = this as El;
      for (const [k, v] of Object.entries(PEN)) self[k] = init[k] ?? v;
      if (init.coalesced || init.predicted) samples.set(this, {coalesced: init.coalesced, predicted: init.predicted});
    }
    getCoalescedEvents(this: El): El[] {
      if (!MOVES.has(this.type)) return [];
      const s = samples.get(this);
      if (!s?.coalesced?.length) return [this];
      if (!(s.coalesced[0] instanceof PointerEvent)) s.coalesced = list(this, s.coalesced);
      return aimed(this, [...s.coalesced]);
    }
    getPredictedEvents(this: El): El[] {
      if (!MOVES.has(this.type)) return [];
      const s = samples.get(this);
      if (!s?.predicted?.length) return [];
      if (!(s.predicted[0] instanceof PointerEvent)) s.predicted = list(this, s.predicted);
      return aimed(this, [...s.predicted]);
    }
  }
  g.PointerEvent = PointerEvent;
}
installPenEvents();
