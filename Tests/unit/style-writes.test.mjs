// Inline style writes are attribute mutations, as in a browser (Runtime/src/styleWrites.ts), so the overlay gets them.
// linkedom wrote an existing style attribute's value directly, so no MutationObserver heard el.style.transform = ...,
// and ui.ts, which publishes only after a mutation, kept the old style in the overlay. PrepViz's cue strip slides its
// film of cues by the film's inline transform alone; in Unreal the film stayed put until something else changed.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bootPage, stubHost, tick} from './browser-page.mjs';

const g = globalThis;

async function page() {
  const {host} = stubHost({origin: 'http://localhost:5180'});
  const published = [];
  host.ui = {publish: html => published.push(html)};
  // Each boot is a new page: an earlier boot's MutationObserver can't hear this one's document.
  delete g.MutationObserver;
  const runtime = await bootPage(host);
  g.document.body.innerHTML = '<div id="film" style="grid-template-columns: auto 1fr"></div>';
  // Mutation records arrive a microtask late, and the first publish stamps ids (more records): settle both, so the
  // next publish is the write's alone.
  for (let i = 0; i < 2; i++) { await tick(); runtime.publishUI(0); }
  /** The overlay's copy after the next publish: the film's style attribute, or null when nothing went. */
  const next = async () => {
    await tick();
    const before = published.length;
    runtime.publishUI(0);
    if (published.length === before) return null;
    return /id="film" style="([^"]*)"/.exec(published.at(-1))?.[1] ?? '';
  };
  return {film: g.document.getElementById('film'), next};
}

test('a style property write goes to the overlay', async () => {
  const {film, next} = await page();
  film.style.transform = 'translate3d(-8.50px, 0, 0)';
  assert.equal(await next(), 'grid-template-columns:auto 1fr;transform:translate3d(-8.50px, 0, 0)');
  film.style.transform = 'translate3d(-35.25px, 0, 0)';
  assert.match(await next() ?? 'nothing published', /translate3d\(-35\.25px/, 'and so does every later one');
});

test('setProperty and removeProperty go too, and the page\'s own observers hear them', async () => {
  const {film, next} = await page();
  const heard = [];
  new g.MutationObserver(records => { for (const r of records) heard.push(r.attributeName); }).observe(film, {attributes: true});
  film.style.setProperty('--kf-track-h', '24px');
  assert.match(await next() ?? 'nothing published', /--kf-track-h:24px/);
  film.style.removeProperty('--kf-track-h');
  assert.equal(await next(), 'grid-template-columns:auto 1fr');
  assert.ok(heard.includes('style'), 'an attribute record for style');
});

test('writing the value it already has changes nothing, so nothing is published', async () => {
  const {film, next} = await page();
  film.style.transform = 'none';
  await next();
  film.style.transform = 'none';
  assert.equal(await next(), null);
  assert.equal(film.style, film.style, 'one style object per element, as in a browser');
  assert.equal(film.style.transform, 'none');
  assert.equal(film.style.length, 2);
});
