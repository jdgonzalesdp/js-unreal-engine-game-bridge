// The Streams standard, the streaming TextDecoder, the coding streams and URL fixes the runtime installs
// (webPlatform.ts), checked against Node's own implementations where Node has them.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {stubHost} from './browser-page.mjs';
import {bootPlatform, Native} from './platform-apis-page.mjs';

const g = globalThis;
const bytes = s => new Uint8Array(Buffer.from(s, 'utf8'));
async function readAll(stream) { const out = []; for await (const c of stream) out.push(c); return out; }

test('TextDecoder continues a character cut between stream calls, as Node does', async () => {
  await bootPlatform();
  assert.notEqual(g.TextDecoder, Native.TextDecoder);
  const d = new g.TextDecoder();
  assert.equal(d.decode(new Uint8Array([0x41, 0xe2, 0x82]), {stream: true}), 'A');
  assert.equal(d.decode(new Uint8Array([0xac, 0x42])), '€B');
  // Random text with 1 to 4 byte characters and some broken bytes, cut at random places: the same text as Node gives.
  let seed = 7; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 200; round++) {
    const parts = [];
    for (let i = 0; i < 40; i++) { const k = rnd(6); parts.push(k === 0 ? 'a' : k === 1 ? 'é' : k === 2 ? '€' : k === 3 ? '😀' : k === 4 ? '\ufeff' : '\x00'); }
    // Starts with a letter: Node's decoder drops every leading byte order mark in stream mode, the standard only one.
    const raw = [...bytes('x' + parts.join(''))];
    if (round % 3 === 0) raw.splice(rnd(raw.length), 0, 0xff, 0xc3);
    const mine = new g.TextDecoder(), node = new Native.TextDecoder();
    let a = '', b = '';
    for (let at = 0; at < raw.length;) { const n = 1 + rnd(5), chunk = new Uint8Array(raw.slice(at, at + n)); at += n; a += mine.decode(chunk, {stream: true}); b += node.decode(chunk, {stream: true}); }
    assert.equal(a + mine.decode(), b + node.decode());
  }
  assert.throws(() => new g.TextDecoder('utf-8', {fatal: true}).decode(new Uint8Array([0xc3])), TypeError);
  assert.equal(new g.TextDecoder().decode(bytes('\ufeffhi')), 'hi');
  assert.equal(new g.TextDecoder().decode(bytes('\ufeff\ufeffhi')), '\ufeffhi');
  assert.equal(new g.TextDecoder('utf-8', {ignoreBOM: true}).decode(bytes('\ufeffhi')), '\ufeffhi');
  assert.equal(new g.TextDecoder('latin1').decode(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x80])), 'café€');
  assert.equal(new g.TextDecoder('utf-16le').decode(new Uint8Array([0x3d, 0xd8, 0x00, 0xde])), '😀');
  assert.throws(() => new g.TextDecoder('nope'), RangeError);
});

test('ReadableStream pulls as the standard orders it, and cancel and errors reach the source', async () => {
  await bootPlatform();
  const log = [];
  let n = 0;
  const s = new g.ReadableStream({
    start() { log.push('start'); },
    pull(c) { log.push('pull'); if (++n <= 3) c.enqueue(n); else c.close(); },
  }, {highWaterMark: 1});
  assert.deepEqual(await readAll(s), [1, 2, 3]);
  assert.equal(log[0], 'start');
  const reasons = [];
  const t = new g.ReadableStream({pull(c) { c.enqueue('x'); }, cancel(r) { reasons.push(r); }});
  const reader = t.getReader();
  assert.deepEqual(await reader.read(), {value: 'x', done: false});
  await reader.cancel('stop');
  assert.deepEqual(reasons, ['stop']);
  assert.deepEqual(await reader.read(), {value: undefined, done: true});
  const broken = new g.ReadableStream({start(c) { c.error(new Error('boom')); }});
  await assert.rejects(broken.getReader().read(), /boom/);
  const [a, b] = new g.ReadableStream({start(c) { c.enqueue(1); c.enqueue(2); c.close(); }}).tee();
  assert.deepEqual([await readAll(a), await readAll(b)], [[1, 2], [1, 2]]);
  assert.deepEqual(await readAll(g.ReadableStream.from(['p', 'q'])), ['p', 'q']);
  const locked = new g.ReadableStream();
  locked.getReader();
  assert.throws(() => locked.getReader(), TypeError);
});

test('pipeThrough a TransformStream and pipeTo a WritableStream deliver every chunk in order', async () => {
  await bootPlatform();
  const source = () => new g.ReadableStream({start(c) { for (const w of ['a', 'b', 'c']) c.enqueue(w); c.close(); }});
  const upper = new g.TransformStream({transform(chunk, c) { c.enqueue(chunk.toUpperCase()); }, flush(c) { c.enqueue('!'); }});
  assert.deepEqual(await readAll(source().pipeThrough(upper)), ['A', 'B', 'C', '!']);
  const seen = [];
  await source().pipeTo(new g.WritableStream({write(c) { return new Promise(r => setTimeout(() => { seen.push(c); r(); }, 1)); }}));
  assert.deepEqual(seen, ['a', 'b', 'c']);
  const failing = new g.WritableStream({write() { throw new Error('disk full'); }});
  await assert.rejects(source().pipeTo(failing), /disk full/);
  const writer = new g.WritableStream({}, new g.CountQueuingStrategy({highWaterMark: 2})).getWriter();
  assert.equal(writer.desiredSize, 2);
  await writer.write('x'); await writer.close();
  await writer.closed;
});

test('TextDecoderStream reads a PLY header the way the Spark splat reader does', async () => {
  await bootPlatform();
  const file = bytes('ply\nformat binary_little_endian 1.0\nelement vertex 2\nend_header\n\u0001\u0002');
  const decoder = new g.ReadableStream({start(c) { c.enqueue(file.slice(0, 65536)); c.close(); }}).pipeThrough(new g.TextDecoderStream()).getReader();
  let header = '';
  for (;;) { const {value, done} = await decoder.read(); if (done) break; header += value; if (header.includes('end_header\n')) break; }
  assert.ok(header.startsWith('ply\nformat binary_little_endian'));
  const encoded = await readAll(g.ReadableStream.from(['\ud83d', '\ude00 ok']).pipeThrough(new g.TextEncoderStream()));
  assert.equal(Buffer.concat(encoded.map(c => Buffer.from(c))).toString('utf8'), '😀 ok');
});

test('CompressionStream gzips a Blob stream that Node gunzips, and DecompressionStream reads Node\'s gzip', async () => {
  await bootPlatform();
  const text = JSON.stringify({scene: 'x'.repeat(5000), n: [1, 2, 3]});
  const stream = new g.Blob([text]).stream().pipeThrough(new g.CompressionStream('gzip'));
  const gz = new Uint8Array(await new g.Response(stream).arrayBuffer());
  assert.ok(gz.length < text.length / 4);
  assert.equal(zlib.gunzipSync(gz).toString('utf8'), text);
  const back = new g.Blob([zlib.gzipSync(Buffer.from(text))]).stream().pipeThrough(new g.DecompressionStream('gzip'));
  assert.equal(await new g.Response(back).text(), text);
  const cut = new g.Blob([zlib.gzipSync(Buffer.from(text)).subarray(0, 20)]).stream().pipeThrough(new g.DecompressionStream('gzip'));
  await assert.rejects(new g.Response(cut).arrayBuffer(), TypeError);
  assert.throws(() => new g.CompressionStream('brotli'), TypeError);
});

test('A Response body is one byte stream, and a file rewrapped in a stream keeps its origin for the audio decoder', async () => {
  const {host} = stubHost({origin: 'http://localhost:5180'});
  host.readFile = path => path === '/sounds/step.ogg' ? new Uint8Array([79, 103, 103, 83, 1, 2, 3]).buffer : null;
  const {bufferOrigin} = await bootPlatform({host});
  const res = await g.fetch('/sounds/step.ogg');
  assert.equal(res.body, res.body);
  // three.js FileLoader: read the body for progress, rewrap it, read the rewrap.
  const reader = res.body.getReader();
  const wrapped = new g.Response(new g.ReadableStream({async start(c) { for (;;) { const {value, done} = await reader.read(); if (done) { c.close(); return; } c.enqueue(value); } }}));
  const buffer = await wrapped.arrayBuffer();
  assert.deepEqual([...new Uint8Array(buffer)], [79, 103, 103, 83, 1, 2, 3]);
  assert.match(bufferOrigin.get(buffer), /\/sounds\/step\.ogg$/);
  assert.equal(new g.Response(null).body, null);
  const streamed = new g.Response(new g.Blob(['abc']).stream(), {headers: new g.Headers({'x-kind': 'test'})});
  assert.equal(streamed.headers.get('x-kind'), 'test');
  assert.equal(streamed.headers.get('content-length'), null);
  const copy = streamed.clone();
  assert.deepEqual([await streamed.text(), await copy.text()], ['abc', 'abc']);
});

test('URL splits userinfo, keeps IPv6 hosts, drops default ports and has canParse and parse', async () => {
  await bootPlatform();
  const u = new g.URL('https://user:pw@Example.com:8080/a?b=1#c');
  assert.deepEqual([u.username, u.password, u.hostname, u.port, u.host, u.origin], ['user', 'pw', 'example.com', '8080', 'example.com:8080', 'https://example.com:8080']);
  assert.equal(u.href, new Native.URL('https://user:pw@Example.com:8080/a?b=1#c').href);
  assert.equal(new g.URL('/x', 'https://u:p@h.com/').href, 'https://u:p@h.com/x');
  const v6 = new g.URL('http://[::1]:5180/p');
  assert.deepEqual([v6.hostname, v6.port], ['[::1]', '5180']);
  assert.equal(new g.URL('https://a.com:443/').host, 'a.com');
  assert.equal(g.URL.canParse('nope'), false);
  assert.equal(g.URL.canParse('/x', 'http://localhost/'), true);
  assert.equal(g.URL.parse('nope'), null);
  assert.equal(g.URL.parse('http://a.com/').hostname, 'a.com');
  const live = new g.URL('http://localhost:5180/scene?app=1&x=2');
  live.searchParams.delete('app');
  assert.equal(live.href, 'http://localhost:5180/scene?x=2');
  const blobUrl = g.URL.createObjectURL(new g.Blob(['hi']));
  assert.match(blobUrl, /^blob:/);
  assert.equal(await (await g.fetch(blobUrl)).text(), 'hi');
});
