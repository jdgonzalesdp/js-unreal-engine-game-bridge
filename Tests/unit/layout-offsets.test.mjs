// offsetLeft, offsetTop, offsetWidth, offsetHeight and offsetParent (Runtime/src/layoutOffsets.ts), read from the
// overlay's layout reports. A browser measures them from the offset parent, in layout space, before any transform.
// PrepViz's cue strip slides a film of cues under a still playhead and reads each cue's offsetLeft to know where the
// cues sit on the film. When offsetLeft was the element's box from the viewport, after transforms, the film's own
// slide and its half-width lead-in were folded back into the cue positions, and the cues drifted off the playhead.
// The numbers below are the ones measured in Unreal on 2026-11-17. The overlay's half (JavaScript/jsgb-ui-client.js)
// needs a real browser and is not run here.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bootPage, stubHost} from './browser-page.mjs';

const g = globalThis;

async function strip() {
  const {host} = stubHost({origin: 'http://localhost:5180'});
  host.ui = {publish() {}};
  const runtime = await bootPage(host);
  g.document.body.id = 'body';
  g.document.body.innerHTML = '<div id="view"><div id="film" style="transform: translate3d(-1323.11px, 0, 0)">'
    + '<div id="track"><button id="a" class="kf-slot"></button><button id="b" class="kf-slot"></button><div id="fresh"></div></div></div></div>';
  runtime.publishUI(0);
  const el = name => g.document.getElementById(name);
  const idOf = name => el(name).getAttribute('data-jsgb');
  const report = rects => runtime.uiInput(JSON.stringify({type: 'host-layout', width: 2437, height: 1403,
    rects: Object.fromEntries(Object.entries(rects).map(([name, b]) => [idOf(name), b]))}));
  return {el, idOf, report};
}

/** The strip as Unreal's overlay laid it out: boxes from the viewport after the film's slide, offsets from layout. */
function laidOut(idOf, slide) {
  const shift = slide + 1323.11;
  return {
    view: {x: 140, y: 1316, width: 2241, height: 49, ol: 140, ot: 1316, op: idOf('body')},
    film: {x: -1183.11 + shift, y: 1316, width: 2314.6, height: 49, ol: 0, ot: 0, op: idOf('view')},
    track: {x: -62.61 + shift, y: 1341, width: 73.6, height: 24, ol: 1120, ot: 25, ow: 74, op: idOf('view')},
    a: {x: -62.61 + shift, y: 1347, width: 12, height: 12, ol: 0, ot: 6, op: idOf('track')},
    b: {x: -11 + shift, y: 1344.5, width: 17, height: 17, ol: 52, ot: 4, op: idOf('track')},
  };
}

test('offsets come from the offset parent in layout space, not from the transformed box', async () => {
  const {el, idOf, report} = await strip();
  report(laidOut(idOf, -1323.11));
  assert.equal(el('a').offsetLeft, 0, 'the first cue sits at the start of the track');
  assert.equal(el('b').offsetLeft, 52);
  assert.equal(el('b').offsetLeft + el('b').offsetWidth / 2, 60.5, 'the cue centre the strip steers by');
  assert.equal(el('b').offsetTop, 4);
  assert.equal(el('track').offsetLeft, 1120, 'the track starts after the lead-in, not where the slide left it');
  assert.equal(el('track').offsetWidth, 74, 'the laid-out width the overlay reported');
  assert.equal(el('a').offsetParent, el('track'));
  assert.equal(el('track').offsetParent, el('view'));
});

test('sliding the film does not move what the cues report', async () => {
  const {el, idOf, report} = await strip();
  report(laidOut(idOf, 0));
  const before = [el('a').offsetLeft, el('b').offsetLeft];
  const slid = laidOut(idOf, -560);
  report(slid);
  assert.deepEqual([el('a').offsetLeft, el('b').offsetLeft], before);
  assert.equal(el('a').getBoundingClientRect().x, slid.a.x, 'the box still follows the slide');
});

test('sizes are the layout sizes: rounded, and the reported ones under a scale', async () => {
  const {el, idOf, report} = await strip();
  report({a: {x: 10, y: 10, width: 24.4, height: 12.6, ol: 3, ot: 4, ow: 12, oh: 6, op: idOf('track')},
    b: {x: 40, y: 10, width: 16.6, height: 17.2, ol: 30, ot: 4}});
  assert.deepEqual([el('a').offsetWidth, el('a').offsetHeight], [12, 6], 'a scaled element reports its unscaled size');
  assert.deepEqual([el('b').offsetWidth, el('b').offsetHeight], [17, 17], 'whole pixels, as a browser gives them');
  assert.equal(el('b').offsetParent, null, 'no offset parent reported: none, as for a fixed element');
});

test('an element not laid out yet, or a report without offsets, keeps the box answers', async () => {
  const {el, report} = await strip();
  report({a: {x: 140.5, y: 20, width: 12.5, height: 12}});
  assert.deepEqual([el('a').offsetLeft, el('a').offsetTop, el('a').offsetWidth], [140.5, 20, 12.5], 'an older overlay that sends boxes only');
  assert.deepEqual([el('fresh').offsetLeft, el('fresh').offsetWidth], [0, 0]);
  assert.equal(el('fresh').offsetParent, null);
});
