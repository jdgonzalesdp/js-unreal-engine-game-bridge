// Pointer capture in the runtime's page (Runtime/src/pointerCapture.ts), driven by the packets the overlay sends: a drag
// that captures the pointer keeps its moves and release when the pointer leaves the element, as in a browser.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bootPage, stubHost} from './browser-page.mjs';

const g = globalThis;
const TYPES = ['pointerdown', 'pointermove', 'pointerup', 'pointerover', 'pointerout', 'mousemove', 'mouseup', 'click', 'gotpointercapture', 'lostpointercapture'];

/** A fresh page with two boxes laid out by a host-layout packet; log lists each event as type@id (with the offset of
 *  pointer moves). a captures the pointer on pointerdown. */
async function boxes(html = '<div id="a" data-jsgb="a"></div><div id="b" data-jsgb="b"></div>') {
  const {host} = stubHost({});
  const runtime = await bootPage(host);
  const send = p => runtime.uiInput(JSON.stringify({pointerId: 1, pointerType: 'mouse', ...p}));
  const doc = g.document;
  doc.body.innerHTML = html;
  send({type: 'host-layout', rects: {a: {x: 100, y: 50, width: 200, height: 20}, b: {x: 0, y: 300, width: 800, height: 100}}});
  const log = [];
  for (const el of doc.querySelectorAll('[id]')) for (const type of TYPES) el.addEventListener(type, e => {
    if (e.target === el) log.push(`${type}@${el.id}` + (type === 'pointermove' ? ` ${e.offsetX},${e.offsetY}` : ''));
  });
  const a = doc.getElementById('a');
  a.addEventListener('pointerdown', e => a.setPointerCapture(e.pointerId));
  return {send, log, doc, a, b: doc.getElementById('b')};
}

test('a captured drag keeps its moves, its release and its click when the pointer leaves the element', async () => {
  const {send, log, a} = await boxes();
  send({type: 'pointerdown', id: 'a', button: 0, buttons: 1, clientX: 150, clientY: 60});
  assert.equal(a.hasPointerCapture(1), true);
  // Boundary events of other elements don't fire while a capture holds.
  send({type: 'pointerout', id: 'a', buttons: 1, relatedId: 'b'});
  send({type: 'pointerover', id: 'b', buttons: 1, relatedId: 'a'});
  send({type: 'pointermove', id: 'b', buttons: 1, clientX: 400, clientY: 320});
  send({type: 'mousemove', id: 'b', buttons: 1, clientX: 400, clientY: 320});
  send({type: 'pointerup', id: 'b', button: 0, buttons: 0, clientX: 400, clientY: 320});
  send({type: 'mouseup', id: 'b', button: 0, buttons: 0, clientX: 400, clientY: 320});
  send({type: 'click', id: 'b', button: 0, clientX: 400, clientY: 320});
  assert.equal(a.hasPointerCapture(1), false);
  send({type: 'pointermove', id: 'b', buttons: 0, clientX: 410, clientY: 320});
  assert.deepEqual(log, ['pointerdown@a', 'gotpointercapture@a', 'pointermove@a 300,270', 'mousemove@a', 'pointerup@a', 'lostpointercapture@a',
    'mouseup@a', 'click@a', 'pointermove@b 0,0']);
});

test('a release inside the capturing element keeps the click on the element clicked', async () => {
  const {send, log} = await boxes('<div id="a" data-jsgb="a"><button id="go" data-jsgb="go"></button></div><div id="b" data-jsgb="b"></div>');
  send({type: 'pointerdown', id: 'go', button: 0, buttons: 1});
  send({type: 'pointerup', id: 'go', button: 0, buttons: 0});
  send({type: 'click', id: 'go', button: 0});
  assert.deepEqual(log, ['pointerdown@go', 'gotpointercapture@a', 'pointerup@a', 'lostpointercapture@a', 'click@go']);
});

test('a capture asked for with no button down is ignored', async () => {
  const {send, b} = await boxes();
  send({type: 'pointermove', id: 'b', buttons: 0});
  b.setPointerCapture(1);
  assert.equal(b.hasPointerCapture(1), false);
});

test('a move with no button held ends a capture whose release the overlay never saw', async () => {
  const {send, log} = await boxes();
  send({type: 'pointerdown', id: 'a', button: 0, buttons: 1});
  send({type: 'pointermove', id: 'b', buttons: 1, clientX: 10, clientY: 310});
  send({type: 'pointermove', id: 'b', buttons: 0, clientX: 10, clientY: 310});
  assert.deepEqual(log, ['pointerdown@a', 'gotpointercapture@a', 'pointermove@a -90,260', 'lostpointercapture@a', 'pointermove@b 0,0']);
});

test('releasePointerCapture takes effect at the next event, and a removed element hands its lost event to the document', async () => {
  const {send, log, doc, a} = await boxes();
  send({type: 'pointerdown', id: 'a', button: 0, buttons: 1});
  a.releasePointerCapture(1);
  send({type: 'pointermove', id: 'b', buttons: 1});
  assert.deepEqual(log, ['pointerdown@a', 'pointermove@b 0,0']);
  const lost = [];
  doc.addEventListener('lostpointercapture', e => lost.push(e.target === doc ? 'document' : e.target.id));
  send({type: 'pointerdown', id: 'a', button: 0, buttons: 1});
  send({type: 'pointermove', id: 'b', buttons: 1});
  a.remove();
  send({type: 'pointermove', id: 'b', buttons: 1});
  assert.deepEqual(lost, ['document']);
  assert.equal(log.at(-1), 'pointermove@b 0,0');
});
