#!/usr/bin/env node
// Lighting goldens + probes (lighting-decisions.md stage 5). One command against a running host:
//
//   node Tools/lighting-golden.mjs [--record] [--scene magic-hour] [--port-file <path>]
//
// Without --record it verifies: status/stream health, the perf gate (median fps over 10 s after a
// settle), the shadow probe (the biggest wall's computed shadow centre must read darker than the
// lit ground beside it), and a golden diff (sampled grid vs Tests/golden/<scene>-<tier>.png).
// With --record it (re)writes that golden from the current frame. Goldens compare against the
// previous approved Unreal capture — never the browser: Unreal renders the same scene better,
// so difference from the browser is the point, regression from itself is the bug.
//
// Requires macOS `sips` for PNG->BMP conversion. The harness drives only the bridge's HTTP API.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const record = args.includes('--record');
const scene = args.includes('--scene') ? args[args.indexOf('--scene') + 1] : 'magic-hour';
const portFile = args.includes('--port-file')
  ? args[args.indexOf('--port-file') + 1]
  : '/Users/joshuagonzales/google-sheets-proxy/GitRepos/prepviz-unreal-host/Saved/Scripts/ue.port';
const port = fs.readFileSync(portFile, 'utf8').trim();
const base = `http://127.0.0.1:${port}`;
const goldenDir = path.join(root, 'Tests/golden');
fs.mkdirSync(goldenDir, {recursive: true});

const fail = [];
const note = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fail.push(label);
};
const get = async (route) => (await fetch(base + route)).json();
const post = async (route, body) => {
  const r = await fetch(base + route, {method: 'POST', body});
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// BMP sampling (sips writes 32bpp BMPs for our captures).
function sampler(bmpPath) {
  const d = fs.readFileSync(bmpPath);
  const off = d.readUInt32LE(10), w = d.readInt32LE(18), rawH = d.readInt32LE(22);
  const h = Math.abs(rawH), bpp = d.readUInt16LE(28), topDown = rawH < 0;
  const stride = Math.floor((w * bpp + 31) / 32) * 4;
  return (fx, fy) => {
    const x = Math.min(w - 1, Math.max(0, Math.round(fx * w))), y = Math.min(h - 1, Math.max(0, Math.round(fy * h)));
    const row = topDown ? y : h - 1 - y;
    const i = off + row * stride + x * (bpp / 8);
    return [d[i + 2], d[i + 1], d[i]];
  };
}
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// 0. Let the tier governor settle at the chosen tier (it demotes under interaction load and
// promotes back after good windows), so the golden is recorded at a known tier.
for (let i = 0; i < 15; i++) {
  const s = await get('/bridge/status');
  if (!s.lightingTierChosen || s.lightingTier === s.lightingTierChosen) break;
  await sleep(2000);
}

// 1. Status / stream health.
const status = await get('/bridge/status');
note(status.ready === true, 'host ready');
note(!!status.sceneQuality, 'scene quality streamed', status.sceneQuality ? `tier=${status.sceneQuality.tier} tod=${status.sceneQuality.timeOfDay}` : 'missing');
note(typeof status.lightingTier === 'string', 'lighting tier mapped', `effective=${status.lightingTier} chosen=${status.lightingTierChosen}`);

// 2. Capture this frame.
const capturePng = `/tmp/lighting-golden-${process.pid}.png`;
await post('/bridge/capture', capturePng);
await sleep(2500);
const captureBmp = capturePng.replace(/\.png$/, '.bmp');
execFileSync('sips', ['-s', 'format', 'bmp', capturePng, '--out', captureBmp], {stdio: 'ignore'});
const px = sampler(captureBmp);

// 3. Shadow probe: biggest caster's shadow polygon centre vs lit ground 30 m to the side.
const probeCode = `(() => {
  const s = __jsgb.lastFrame.scene, cam = __jsgb.lastFrame.camera;
  let light = null; s.traverse(o => { if (o.isDirectionalLight) light = o; });
  if (!light) return JSON.stringify({error: 'no sun'});
  const V = cam.position.constructor;
  const lp = new V(), lt = new V();
  light.getWorldPosition(lp); light.target.getWorldPosition(lt);
  const dir = lt.clone().sub(lp).normalize();
  if (dir.y > -0.02) return JSON.stringify({skip: 'sun too flat for a ground shadow probe'});
  let Box3 = null; s.traverse(o => { if (!Box3 && o.geometry && o.geometry.boundingBox) Box3 = o.geometry.boundingBox.constructor; });
  const box = new Box3(); const casters = [];
  s.traverse(o => { if (o.isMesh && o.castShadow && o.geometry) { box.setFromObject(o);
    // Walls are thin: score by vertical face area (longest horizontal extent x height), not footprint.
    const a = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * (box.max.y - box.min.y);
    if (a > 2 && box.max.y > 1.2) casters.push({a, min: box.min.clone(), max: box.max.clone()}); } });
  casters.sort((p, q) => q.a - p.a);
  // Ground shadow of the wall's top edge, sampled at its centre, vs lit ground 30 m to either
  // side. The biggest caster whose shadow centre is actually in frame wins.
  const ground = (x, y, z) => { const t = (0 - y) / dir.y; return new V(x + dir.x * t, 0, z + dir.z * t); };
  const pr = (p) => { const q = p.clone().project(cam); return [Math.round(((q.x + 1) / 2) * 1000) / 1000, Math.round(((1 - q.y) / 2) * 1000) / 1000, q.z]; };
  const inFrame = (p) => p[2] < 1 && p[0] > 0 && p[0] < 1 && p[1] > 0 && p[1] < 1;
  for (const best of casters) {
    const cs = [[best.min.x, best.min.z], [best.max.x, best.min.z], [best.min.x, best.max.z], [best.max.x, best.max.z]]
      .map(([x, z]) => ground(x, best.max.y, z));
    const cx = cs.reduce((a, p) => a + p.x, 0) / 4, cz = cs.reduce((a, p) => a + p.z, 0) / 4;
    const perp = new V(-dir.z, 0, dir.x).normalize();
    const inside = new V(cx, 0, cz);
    const pi = pr(inside);
    if (!inFrame(pi)) continue;
    const litA = inside.clone().add(perp.clone().multiplyScalar(30));
    const litB = inside.clone().add(perp.clone().multiplyScalar(-30));
    return JSON.stringify({shadow: pi, litA: pr(litA), litB: pr(litB)});
  }
  return JSON.stringify({skip: 'no caster shadow in frame (frame a wall and its shadow, sun up)'});
})()`;
const evalRes = await post('/bridge/eval', probeCode);
let probe = null;
try { probe = JSON.parse(evalRes.result); } catch { /* handled below */ }
if (!probe || probe.error) {
  note(false, 'shadow probe', probe?.error ?? 'no answer from page');
} else if (probe.skip) {
  console.log(`SKIP  shadow probe — ${probe.skip} (frame this scene's biggest wall, sun up)`);
} else {
  const inL = lum(px(probe.shadow[0], probe.shadow[1]));
  const litL = Math.max(lum(px(probe.litA[0], probe.litA[1])), lum(px(probe.litB[0], probe.litB[1])));
  note(inL + 25 < litL, 'wall shadow lands (no sun through walls)', `shadow lum ${inL.toFixed(0)} vs lit ${litL.toFixed(0)} (need 25+ darker)`);
}

// 4. Golden record / diff.
const tier = status.lightingTier || 'unknown';
const goldenPng = path.join(goldenDir, `${scene}-${tier}.png`);
if (record) {
  fs.copyFileSync(capturePng, goldenPng);
  console.log(`REC   golden ${path.relative(root, goldenPng)} written`);
} else if (fs.existsSync(goldenPng)) {
  const goldenBmp = goldenPng.replace(/\.png$/, '.bmp');
  execFileSync('sips', ['-s', 'format', 'bmp', goldenPng, '--out', goldenBmp], {stdio: 'ignore'});
  const gp = sampler(goldenBmp);
  let sum = 0, n = 0, worst = 0;
  for (let fx = 0.08; fx < 1; fx += 0.08) for (let fy = 0.08; fy < 1; fy += 0.08) {
    const d = Math.abs(lum(px(fx, fy)) - lum(gp(fx, fy)));
    sum += d; n++; worst = Math.max(worst, d);
  }
  note(sum / n <= 6, 'golden diff', `mean |dL| ${(sum / n).toFixed(1)} (<=6), worst ${worst.toFixed(0)}`);
} else {
  console.log(`SKIP  golden diff — no ${path.relative(root, goldenPng)} yet (run with --record)`);
}

// 5. Perf gate: median fps over 10 s, at the effective tier.
const samples = [];
for (let i = 0; i < 10; i++) { const s = await get('/bridge/status'); samples.push(s.fps); await sleep(1000); }
samples.sort((a, b) => a - b);
const median = samples[Math.floor(samples.length / 2)];
note(median >= 55, 'perf gate', `median fps ${median.toFixed(0)} at tier ${tier} (chosen ${status.lightingTierChosen})`);

fs.rmSync(capturePng, {force: true});
fs.rmSync(captureBmp, {force: true});
console.log(fail.length ? `\n${fail.length} FAILED: ${fail.join('; ')}` : '\nall probes passed');
process.exit(fail.length ? 1 : 0);
