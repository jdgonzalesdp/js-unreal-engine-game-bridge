// Runs in the UI overlay after jsgb-ui-edit.js (the host appends every JavaScript/jsgb-ui-*.js, in name order, to
// jsgb-ui-client.js). Scrolling and pens, for the game's page (Runtime/src/scrollMirror.ts, Runtime/src/penEvents.ts):
// - The overlay's panels scroll natively. Each scroll goes to the page with the element's new position, and the layout
//   is measured again (at most every 100 ms), since everything inside the element moved. Layout reports carry each scrolling element's scroll
//   and client sizes. The page's own scrolling (scrollTop =, scrollTo, scrollIntoView) comes as a command.
// - Pointer events carry a pen's pressure, tilt and twist, and a move carries the samples gathered since the last one.
(function () {
  const ATTR = 'data-jsgb';
  const send = packet => { try { if (window.ue && window.ue.jsgb) window.ue.jsgb.sendinput(JSON.stringify(packet)); } catch (e) { console.error(e); } };
  const id = node => node && node.nodeType === 1 ? node.getAttribute(ATTR) : null;
  const edit = window.JsgbEdit;
  if (!edit) return;

  edit.measure = (node, rect) => {
    const sw = node.scrollWidth, sh = node.scrollHeight, cw = node.clientWidth, ch = node.clientHeight;
    if (sh > ch + 1 || sw > cw + 1 || node.scrollTop || node.scrollLeft) Object.assign(rect, {sw, sh, clw: cw, clh: ch});
  };

  edit.scroll = (el, c) => {
    const into = c.into;
    if (into && into.ifNeeded) { if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(into.center); else el.scrollIntoView({block: 'nearest'}); }
    else if (into) el.scrollIntoView({block: into.block, inline: into.inline, behavior: into.behavior});
    const to = {};
    if (typeof c.top === 'number') to.top = c.top;
    if (typeof c.left === 'number') to.left = c.left;
    if (c.behavior) to.behavior = c.behavior;
    if ('top' in to || 'left' in to) el.scrollTo(to);
    // The overlay page itself stays put under Unreal's view, whatever scrollIntoView moved.
    for (const root of [document.documentElement, document.body]) if (root.scrollTop || root.scrollLeft) root.scrollTop = root.scrollLeft = 0;
  };

  // A layout report measures the whole page, so while a panel scrolls it goes at most every 100 ms, and once more after.
  let lastLayout = 0, trailing = 0;
  function relayout() {
    const layout = window.JsGameUI && window.JsGameUI.layout, wait = 100 - (performance.now() - lastLayout);
    if (!layout || trailing) return;
    if (wait <= 0) { lastLayout = performance.now(); layout(); }
    trailing = setTimeout(() => { trailing = 0; lastLayout = performance.now(); layout(); }, Math.max(wait, 100));
  }
  for (const type of ['scroll', 'scrollend']) document.addEventListener(type, event => {
    const el = event.target;
    if (!el || el.nodeType !== 1 || !id(el)) return;
    send({type, id: id(el), top: el.scrollTop, left: el.scrollLeft});
    if (type === 'scroll') relayout();
  }, true);

  const PEN = ['pressure', 'tangentialPressure', 'tiltX', 'tiltY', 'twist', 'width', 'height', 'altitudeAngle', 'azimuthAngle', 'isPrimary'];
  edit.pen = (p, event) => {
    for (const k of PEN) if (event[k] !== undefined) p[k] = event[k];
    if (event.type !== 'pointermove') return;
    const sample = c => ({clientX: c.clientX, clientY: c.clientY, screenX: c.screenX, screenY: c.screenY, pressure: c.pressure, tiltX: c.tiltX, tiltY: c.tiltY,
      twist: c.twist, width: c.width, height: c.height, altitudeAngle: c.altitudeAngle, azimuthAngle: c.azimuthAngle, buttons: c.buttons, dt: c.timeStamp - event.timeStamp});
    const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    if (coalesced.length > 1) p.coalesced = coalesced.map(sample);
    const predicted = typeof event.getPredictedEvents === 'function' ? event.getPredictedEvents() : [];
    if (predicted.length) p.predicted = predicted.map(sample);
  };
})();
