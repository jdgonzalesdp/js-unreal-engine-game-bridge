// ResizeObserver driven by the overlay's layout reports (Runtime/src/resizeObserver.ts): a report when a target starts
// being watched, then one whenever a layout report changes its size, and none when nothing changed.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from './load-runtime.mjs';

globalThis.DOMRect ??= class { constructor(x, y, width, height) { Object.assign(this, {x, y, width, height}); } };
const tick = () => new Promise(r => setTimeout(r, 5));

test('reports the start, every size change from a layout report, and nothing else', async () => {
  const ro = await loadRuntime('resizeObserver.ts');
  const boxes = new Map();
  ro.setLayoutSource(el => boxes.get(el));
  const target = {isConnected: true, getBoundingClientRect: () => ({width: 0, height: 0})};
  const seen = [];
  const observer = new ro.JsgbResizeObserver(entries => { for (const e of entries) seen.push([e.contentRect.width, e.contentRect.height, e.borderBoxSize[0].blockSize]); });

  boxes.set(target, {width: 1316, height: 900});
  observer.observe(target);
  await tick();
  assert.deepEqual(seen, [[1316, 900, 900]], 'the first report comes once the target is watched');

  ro.notifyResizes(true);
  assert.equal(seen.length, 1, 'no report when the layout did not change it');

  boxes.set(target, {width: 1316, height: 860, cw: 1300, ch: 844});
  ro.notifyResizes(true);
  assert.deepEqual(seen.at(-1), [1300, 844, 860], 'a change reports the content box and the border box');

  observer.unobserve(target);
  boxes.set(target, {width: 10, height: 10});
  ro.notifyResizes(true);
  assert.equal(seen.length, 2, 'an unobserved target is not reported');
});

test('before any layout report, an element of unknown size reports the viewport', async () => {
  const ro = await loadRuntime('resizeObserver.ts');
  globalThis.innerWidth = 800; globalThis.innerHeight = 600;
  const seen = [];
  new ro.JsgbResizeObserver(entries => seen.push(entries[0].contentRect.width)).observe({isConnected: true, getBoundingClientRect: () => ({width: 0, height: 0})});
  await tick();
  assert.deepEqual(seen, [800]);
});
