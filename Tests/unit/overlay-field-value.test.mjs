// A value the page writes into a text field itself (a composer cleared after Enter sends) goes to the overlay's field
// as a command, even while it has focus; the person's own typing never comes back as one (Runtime/src/selectionMirror.ts).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bootPage, stubHost} from './browser-page.mjs';

const g = globalThis;

async function page() {
  const {host} = stubHost({origin: 'http://localhost:5180'});
  const published = [];
  host.ui = {publish: html => published.push(html)};
  for (const k of ['getSelection', 'Selection', 'Range']) delete g[k];
  const runtime = await bootPage(host);
  const send = p => runtime.uiInput(JSON.stringify(p));
  const commands = () => {
    runtime.publishUI(0);
    const m = /<meta name="jsgb-commands" content="([^"]*)">/.exec(published.at(-1) ?? '');
    if (!m) return [];
    return JSON.parse(m[1].replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')).list;
  };
  return {send, commands};
}

test('the page clearing a focused field reaches the overlay; the overlay\'s own typing does not echo back', async () => {
  const {send, commands} = await page();
  const doc = g.document;
  doc.body.innerHTML = '<textarea id="comp"></textarea>';
  const ta = doc.getElementById('comp');
  commands();
  const id = ta.getAttribute('data-jsgb');
  ta.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ta.value = ''; } });
  send({type: 'focusin', id});
  send({type: 'input', id, value: 'hi', inputType: 'insertText', data: 'i', edit: 4});
  assert.equal(ta.value, 'hi');
  assert.deepEqual(commands().filter(c => c.k === 'fval'), [], 'typing is not sent back');
  send({type: 'keydown', id, key: 'Enter', code: 'Enter', held: 1});
  const after = commands();
  assert.deepEqual(after.filter(c => c.k === 'fval').map(c => [c.id, c.value, c.edit]), [[id, '', 4]]);
  assert.ok(after.findIndex(c => c.k === 'fval') < after.findIndex(c => c.k === 'held'), 'the value goes before the held key\'s answer');
  // Writing the same value again sends nothing.
  ta.value = '';
  assert.equal(commands().filter(c => c.k === 'fval' && c.n > after.at(-1).n).length, 0);
});
