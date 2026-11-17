// The smoke test's network for netFetch.ts (host.httpStart / host.httpTake), on node:http and node:https. Node's own
// fetch can't be used: the harness hides Buffer from the game, and Node's fetch reads the global Buffer when it loads.
// JSGB_SMOKE_NET=0 turns it off, so a game's network requests fail as offline, as they did before.
import http from 'node:http';
import https from 'node:https';
import {Buffer} from 'node:buffer';
import {randomBytes} from 'node:crypto';

const pack = (status, headers, body) => {
  const json = Buffer.from(JSON.stringify(headers), 'utf8');
  const out = Buffer.alloc(8 + ((json.length + 3) & ~3) + body.length);
  out.writeInt32LE(status, 0); out.writeInt32LE(json.length, 4);
  json.copy(out, 8); body.copy(out, 8 + ((json.length + 3) & ~3));
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
};

function request(method, url, headers, body, redirects, done) {
  let target;
  try { target = new URL(url); } catch { done(pack(0, {}, Buffer.alloc(0))); return; }
  const lib = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
  if (!lib) { done(pack(0, {}, Buffer.alloc(0))); return; }
  const req = lib.request(target, {method, headers: {'accept-encoding': 'identity', ...headers}}, res => {
    const location = res.headers.location;
    if (location && [301, 302, 303, 307, 308].includes(res.statusCode) && redirects < 5) {
      res.resume();
      const keep = res.statusCode === 307 || res.statusCode === 308;
      request(keep ? method : 'GET', new URL(location, target).href, headers, keep ? body : null, redirects + 1, done);
      return;
    }
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      const out = {};
      for (const [k, v] of Object.entries(res.headers)) out[k] = Array.isArray(v) ? v.join(', ') : String(v);
      done(pack(res.statusCode ?? 0, out, Buffer.concat(chunks)));
    });
    res.on('error', () => done(pack(0, {}, Buffer.alloc(0))));
  });
  req.setTimeout(30000, () => req.destroy());
  req.on('error', () => done(pack(0, {}, Buffer.alloc(0))));
  if (body) req.write(Buffer.from(body));
  req.end();
}

/** Adds httpStart/httpTake to the smoke host and counts requests into stats.net ({url: status}). */
export function installSmokeNet(host, stats) {
  if (process.env.JSGB_SMOKE_NET === '0') return;
  let next = 1;
  const done = new Map();
  stats.net = {};
  host.httpStart = (method, url, headersJson, body) => {
    const id = next++;
    request(method, url, JSON.parse(headersJson || '{}'), body, 0, reply => {
      stats.net[`${method} ${url}`] = new DataView(reply).getInt32(0, true);
      done.set(id, reply);
    });
    return id;
  };
  host.httpTake = id => { const reply = done.get(id); if (reply) done.delete(id); return reply ?? null; };
}

/** The smoke host's platform name and secure random bytes, as the Unreal host gives them (JsgbNet.cpp). */
export function installSmokePlatform(host) {
  host.platform = process.platform === 'darwin' ? 'MacIntel' : process.platform === 'win32' ? 'Win32' : 'Linux x86_64';
  host.randomBytes = n => { const b = randomBytes(n); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
}
