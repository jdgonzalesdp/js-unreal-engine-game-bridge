// The focus fixup rule (Runtime/src/focusFixup.ts): a field that leaves the page while it has focus gives focus back
// to the body, as in a browser, so a page that stands its shortcuts down while document.activeElement is a field (PrepViz's
// viewportKeysBlocked) gets its keys back. The packets are the ones the overlay sends when a colour chip in a menu was
// focused and the person then clicked the 3D view: the menu closes on the pointerdown, before the chip's focusout arrives.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bootPage, stubHost} from './browser-page.mjs';

const g = globalThis;

async function page() {
  const {host} = stubHost({origin: 'http://localhost:5180'});
  host.ui = {publish() {}};
  const runtime = await bootPage(host);
  return p => runtime.uiInput(JSON.stringify(p));
}

/** The guard PrepViz's fly and tool keys run (scene/viewportKeyGuard.ts), reduced to the field test. */
const blocked = () => /^(INPUT|TEXTAREA|SELECT)$/.test(g.document.activeElement?.tagName ?? '');

test('a focused field removed with its menu leaves focus on the body, so viewport keys work again', async () => {
  const send = await page();
  const doc = g.document;
  doc.body.innerHTML = '<div data-jsgb="m" id="menu"><input data-jsgb="chip" type="color" class="env-color-chip"></div><canvas data-jsgb="view"></canvas>';
  // The menu closes on a press outside it, as React menus do.
  doc.querySelector('canvas').addEventListener('pointerdown', () => doc.getElementById('menu').remove());
  const chip = doc.querySelector('.env-color-chip'), seen = [];
  chip.addEventListener('blur', () => seen.push('blur'));
  doc.addEventListener('keydown', e => seen.push(`${e.key}:${e.target.tagName}:${blocked() ? 'blocked' : 'live'}`));

  send({type: 'focusin', id: 'chip'});
  assert.equal(doc.activeElement, chip);
  assert.equal(blocked(), true, 'a focused field holds the keys, as in a browser');

  send({type: 'pointerdown', id: 'view', button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse'});
  send({type: 'mousedown', id: 'view', button: 0, buttons: 1});
  // The overlay's blur names the chip, which the page no longer has.
  send({type: 'focusout', id: 'chip'});
  assert.equal(chip.isConnected, false);
  assert.equal(doc.activeElement, doc.body, 'focus went back to the body');
  send({type: 'keydown', key: 'w', code: 'KeyW'});
  assert.deepEqual(seen, ['w:BODY:live'], 'no blur fires on removal, and W reaches the page with nothing blocking it');

  // Put back later, it does not take focus again: focus was lost when it left.
  doc.body.append(chip);
  assert.equal(doc.activeElement, doc.body);
});

test('a field the page focuses and keeps still has focus', async () => {
  await page();
  const doc = g.document;
  doc.body.innerHTML = '<input id="name">';
  const name = doc.getElementById('name');
  name.focus();
  assert.equal(doc.activeElement, name);
  name.blur();
  assert.equal(doc.activeElement, doc.body);
});
