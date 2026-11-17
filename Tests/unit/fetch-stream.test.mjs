// fetch() over the host's streamed requests (fetchStream.ts): a stub host speaks JsgbNetStream.cpp's protocol over a
// real local HTTP server, so a server-sent event stream, a reply that arrives in pieces, an abort and the failures
// all go over the wire.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Buffer} from 'node:buffer';
import {stubHost} from './browser-page.mjs';
import {bootPlatform} from './platform-apis-page.mjs';

const g = globalThis;
const wait = ms => new Promise(r => setTimeout(r, ms));

/** What ReadStream returns: [flags, status, headers length, headers JSON padded to 4 (head only), body since last]. */
function pack(flags, status, headers, body) {
  const json = headers ? Buffer.from(JSON.stringify(headers)) : Buffer.alloc(0), padded = (json.length + 3) & ~3;
  const out = Buffer.alloc(12 + padded + body.length);
  out.writeInt32LE(flags, 0); out.writeInt32LE(status, 4); out.writeInt32LE(json.length, 8); json.copy(out, 12); body.copy(out, 12 + padded);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
}

/** A host whose streamed requests go to node:http, keeping what arrives until the page reads it. */
function streamingHost() {
  const {host, seen} = stubHost({origin: 'http://localhost:5180'});
  const live = new Map();
  let next = 1;
  host.httpStream = (method, url, headersJson, body) => {
    const id = next++, s = {status: 0, headers: null, chunks: [], done: false, failed: false, headRead: false};
    seen.requests.push({method, url, headers: JSON.parse(headersJson), body: body ? Buffer.from(body).toString('utf8') : null});
    s.req = http.request(url, {method, headers: JSON.parse(headersJson)}, res => {
      s.status = res.statusCode; s.headers = {};
      for (const [k, v] of Object.entries(res.headers)) s.headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
      res.on('data', c => s.chunks.push(c));
      res.on('end', () => { s.done = true; });
      res.on('error', () => { s.done = s.failed = true; });
    });
    s.req.on('error', () => { s.done = s.failed = true; });
    if (body) s.req.write(Buffer.from(body));
    s.req.end();
    live.set(id, s);
    return id;
  };
  host.httpRead = id => {
    const s = live.get(id);
    if (!s || (!s.headers && !s.done)) return null;
    const head = !s.headRead, body = Buffer.concat(s.chunks.splice(0));
    if (!head && !body.length && !s.done) return null;
    s.headRead = true;
    if (s.done) live.delete(id);
    return pack((head ? 1 : 0) | (s.done ? 2 : 0) | (s.failed ? 4 : 0), s.status, head ? s.headers ?? {} : null, body);
  };
  host.httpCancel = id => { const s = live.get(id); live.delete(id); s?.req.destroy(); seen.cancelled = (seen.cancelled ?? 0) + 1; };
  return {host, seen, live};
}

async function server(handler) {
  const srv = http.createServer(handler);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return {base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); })};
}

test('Server-sent events arrive one by one while the stream stays open, and abort ends the request', async () => {
  let closed = false, send;
  const {base, close} = await server((req, res) => {
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write(':hb\n\n');
    send = text => res.write(text);
    req.on('close', () => { closed = true; });
  });
  const {host, seen} = streamingHost();
  await bootPlatform({host});
  const ctrl = new g.AbortController();
  const res = await g.fetch(`${base}/api/v1/projects/p1/events`, {headers: {accept: 'text/event-stream', authorization: 'Bearer t'}, signal: ctrl.signal});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.equal(seen.requests[0].headers.authorization, 'Bearer t');
  const reader = res.body.getReader(), decoder = new g.TextDecoder();
  const next = async () => decoder.decode((await reader.read()).value, {stream: true});
  assert.equal(await next(), ':hb\n\n');
  // An event split inside a multi-byte character still decodes whole.
  const event = Buffer.from('data: {"note":"café ☕"}\n\n');
  send(event.subarray(0, 18));
  let text = await next();
  send(event.subarray(18));
  while (!text.endsWith('\n\n')) text += await next();
  assert.equal(text, 'data: {"note":"café ☕"}\n\n');
  ctrl.abort();
  await assert.rejects(reader.read(), e => e.name === 'AbortError');
  for (let i = 0; i < 50 && !closed; i++) await wait(10);
  assert.ok(closed, 'the server saw the request end');
  assert.equal(seen.cancelled, 1);
  await close();
});

test('fetch resolves with the head before a slow body ends; text() waits for all of it', async () => {
  let finish;
  const {base, close} = await server((req, res) => { res.writeHead(200, {'content-type': 'application/json'}); res.write('{"a":'); finish = () => res.end('1}'); });
  await bootPlatform({host: streamingHost().host});
  const res = await g.fetch(`${base}/slow`);
  assert.equal(res.ok, true);
  const body = res.json();
  await wait(30);
  finish();
  assert.deepEqual(await body, {a: 1});
  await close();
});

test('Status, POST bodies, null bodies and a refused or failed request look as they do in a browser', async () => {
  const {base, close} = await server((req, res) => {
    if (req.url === '/missing') { res.writeHead(404, {'content-type': 'text/plain'}); res.end('nope'); return; }
    if (req.url === '/empty') { res.writeHead(204); res.end(); return; }
    const parts = []; req.on('data', c => parts.push(c)); req.on('end', () => { res.writeHead(201); res.end(Buffer.concat(parts)); });
  });
  const {host} = streamingHost();
  await bootPlatform({host});
  const missing = await g.fetch(`${base}/missing`);
  assert.deepEqual([missing.status, missing.ok, await missing.text()], [404, false, 'nope']);
  const empty = await g.fetch(`${base}/empty`);
  assert.deepEqual([empty.status, empty.body], [204, null]);
  const posted = await g.fetch(`${base}/echo`, {method: 'POST', body: new g.Blob(['{"x":1}']).stream(), headers: {'content-type': 'application/json'}});
  assert.deepEqual([posted.status, await posted.text()], [201, '{"x":1}']);
  await close();
  await assert.rejects(g.fetch(`${base}/gone`), TypeError);
  host.httpStream = () => 0;
  await assert.rejects(g.fetch('https://not-allowed.example/x'), /does not allow/);
});

test('An abort rejects with an AbortError, a timeout with a TimeoutError, as in a browser', async () => {
  await bootPlatform({host: streamingHost().host});
  const c = new g.AbortController();
  c.abort();
  assert.equal(c.signal.reason.name, 'AbortError');
  await assert.rejects(g.fetch('http://127.0.0.1:9/x', {signal: c.signal}), e => e.name === 'AbortError');
  const own = new g.AbortController();
  own.abort('mine');
  assert.equal(own.signal.reason, 'mine');
  const timed = g.AbortSignal.timeout(5);
  await wait(30);
  assert.equal(timed.reason.name, 'TimeoutError');
  const any = g.AbortSignal.any([new g.AbortController().signal, g.AbortSignal.abort('first')]);
  assert.equal(any.reason, 'first');
});

test('A host without streamed requests (a threaded worker, an older Unreal build) still answers whole', async () => {
  const {host} = stubHost({origin: 'http://localhost:5180', http: () => ({status: 200, body: {ok: true}})});
  await bootPlatform({host});
  const res = await g.fetch('https://api.example.com/v');
  assert.deepEqual(await res.json(), {ok: true});
  assert.equal(typeof res.body.getReader, 'function');
});
