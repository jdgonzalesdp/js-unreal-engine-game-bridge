/** Reads of render targets that full-screen passes wrote, answered by running those passes in Unreal (readback.ts,
 *  renderer.ts). The draws behind the target (passGraph.ts) run in the page's order: each scene they start from is
 *  drawn by Unreal into a float target of its own (linear light, exposure 1, as three draws a scene into a render
 *  target), then each pass draws into its target as a material, with the uniform values it had when the page drew it
 *  and the targets it read bound as textures, and the target the page reads comes back as floats (JsgbPassRunner.cpp).
 *  A step the bridge can't run (one that reads depth, ambient occlusion) is stood in by Unreal's picture of the scene
 *  behind it when it is that picture's size; anything else leaves the read as it was, with a line in the log. */
import {DataUtils} from 'three-real';
import {host} from './host';
import {media} from './media';
import {frameCount} from './frameCount';
import {sceneFrame} from './sceneFrame';
import {drawOf, type Draw, type PassDraw, type SceneDraw} from './passGraph';
import {shaderOf, passParameters, failures, type HostPass, type HostTexture} from './passProgram';
import type {PassShader} from './passHlsl';

type Obj = Record<string, any>;
/** The host's side (JsgbPassRunner.cpp). format: 0 bytes, 1 half float, 2 float, plus 16 for nearest sampling. */
type Runner = {passScene?(f: ArrayBuffer, n: number, i: ArrayBuffer, ni: number, slot: number, width: number, height: number, format: number): boolean; passRun?(json: string): ArrayBuffer | null};
const runner = () => { const m = media() as Runner | undefined; return m?.passScene && m.passRun ? m as Required<Runner> : undefined; };

/** What the runner did, for /bridge/eval. */
export const passRuns = {runs: 0, passes: 0, declined: 0, last: ''};
(globalThis as Record<string, unknown>).__jsgbPassRuns = passRuns;
const logged = new Set<string>();
function warnOnce(text: string) {
  passRuns.declined++; passRuns.last = text;
  if (logged.has(text)) return;
  logged.add(text); host.log('warn', 'render target read: ' + text);
}

const formatOf = (d: Draw) => (d.type === 1015 ? 2 : d.type === 1009 ? 0 : 1) | (d.nearest ? 16 : 0);
const sentShaders = new Set<string>();
const label = (d: PassDraw) => d.material.name || d.material.type || 'a pass';

/** Results Unreal keeps after a run, by the page's target: a target whose latest draw ran keeps that result, so a later
 *  read that needs it (a meter easing from its last reading after the scene behind it moved on) binds it instead of
 *  running it again. Only results up to KEEP_PIXELS are kept (what passes compute is small; pictures are not), and a
 *  target the page disposes of or lets go frees its result on the next run. */
const KEEP_PIXELS = 512 * 512;
const kept = new WeakMap<Obj, {id: number; draw: Draw | null}>();
let nextKept = 0;
const released: number[] = [];
const gone = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry<number>(id => { released.push(id); }) : null;
function keepFor(target: Obj) {
  let k = kept.get(target);
  if (k) return k;
  const id = nextKept++;
  k = {id, draw: null};
  kept.set(target, k); gone?.register(target, id);
  target.addEventListener?.('dispose', () => { if (kept.get(target)?.id === id) { kept.delete(target); released.push(id); } });
  return k;
}
/** Host slots: 0 and up this run's targets, -1 zeros (a target never drawn), -2 and down a kept result. */
const keptSlot = (id: number) => -2 - id;

/** The draws behind root in an order that runs each after the ones it reads, each with a host slot (draws of the
 *  same scene from the same camera at the same size share one), or why they can't run. */
function plan(root: PassDraw): {order: Draw[]; slots: Map<Draw, number>; why: string} {
  const order: Draw[] = [], slots = new Map<Draw, number>(), pictures: {s: SceneDraw; w: number; h: number; slot: number}[] = [];
  let why = '';
  const visit = (d: Draw) => {
    if (slots.has(d) || why) return;
    const k = kept.get(d.target);
    if (k?.draw === d) { slots.set(d, keptSlot(k.id)); return; }
    if (d.kind === 'pass') { for (const key in d.inputs) { const i = d.inputs[key]; if (i) visit(i); } if (!why) { slots.set(d, order.length); order.push(d); } return; }
    const s = d.kind === 'scene' ? d : d.src;
    if (d.kind === 'gap' && (!s || s.width !== d.width || s.height !== d.height)) { why = d.why; return; }
    if (frameCount.animation - s!.frame > 1) { why = 'the scene it starts from was drawn in an earlier frame'; return; }
    const same = pictures.find(p => p.s.scene === s!.scene && p.s.camera === s!.camera && p.w === d.width && p.h === d.height);
    if (same) { slots.set(d, same.slot); return; }
    slots.set(d, order.length); pictures.push({s: s!, w: d.width, h: d.height, slot: order.length}); order.push(d);
  };
  visit(root);
  return {order, slots, why};
}

/** Each run's target whose draw is still the page's latest for it stays on the host after the run. */
function keeps(order: Draw[], slots: Map<Draw, number>) {
  const out: [number, number][] = [], done: [Obj, Draw][] = [], used = new Set<number>();
  for (const d of order) {
    const slot = slots.get(d)!;
    if (drawOf(d.target) !== d || used.has(slot) || d.width * d.height > KEEP_PIXELS) continue;
    used.add(slot);
    out.push([slot, keepFor(d.target).id]); done.push([d.target, d]);
  }
  return {out, done};
}

type Result = {width: number; height: number; floats: Float32Array};
/** Runs the draws behind root and returns the rectangle read (rows from the bottom), or why it could not. */
function run(root: PassDraw, x: number, y: number, w: number, h: number): Result | string {
  const r = runner();
  if (!r) return 'this host runs no render target passes';
  const {order, slots, why} = plan(root);
  if (why) return `${label(root)} can't run in Unreal: ${why}`;
  // Every shader first: a translation still under way stops the read before Unreal draws anything.
  const shaders = new Map<PassDraw, PassShader>();
  for (const d of order) {
    if (d.kind !== 'pass') continue;
    const s = shaderOf(d.material);
    if (s === undefined) return `${label(d)} is still being translated; read it again shortly`;
    if (!s) return `${label(d)} can't run in Unreal: ${failures.get(d.material) ?? 'it could not be translated'}`;
    shaders.set(d, s);
  }
  const keep = keeps(order, slots);
  const program = {release: released.splice(0), shaders: [] as object[], textures: [] as HostTexture[], slots: [] as object[], passes: [] as HostPass[], keep: keep.out,
    read: {slot: slots.get(root)!, x, y, width: w, height: h}};
  for (const d of order) {
    const slot = slots.get(d)!;
    if (d.kind === 'pass') {
      const s = shaders.get(d)!;
      if (!sentShaders.has(s.key) && !program.shaders.some(p => (p as {key: string}).key === s.key)) program.shaders.push({key: s.key, name: label(d), hlsl: s.hlsl, inputs: s.inputs});
      program.slots.push({slot, width: d.width, height: d.height, format: formatOf(d)});
      program.passes.push(passParameters(d, s, slot, i => slots.get(i) ?? -1, program.textures, text => warnOnce(`${label(d)}: ${text}`)));
      continue;
    }
    const s = (d.kind === 'scene' ? d : d.src)!;
    const f = sceneFrame(s.scene, s.camera, true);
    if (!f) return 'the scene behind it could not be exported';
    if (!r.passScene(f[0], f[1], f[2], f[3], slot, d.width, d.height, formatOf(d))) return 'Unreal could not draw the scene behind it';
  }
  const out = r.passRun(JSON.stringify(program));
  for (const s of program.shaders) sentShaders.add((s as {key: string}).key);
  if (!out || out.byteLength < 8) return `Unreal could not run the passes behind ${label(root)} (see the Unreal log)`;
  for (const [target, d] of keep.done) { const k = kept.get(target); if (k) k.draw = d; }
  const [width, height] = new Int32Array(out, 0, 2);
  passRuns.runs++; passRuns.passes += program.passes.length;
  return {width, height, floats: new Float32Array(out, 8, Math.min(width * height * 4, (out.byteLength - 8) >> 2))};
}

function copyOut(res: Result, w: number, h: number, out: ArrayLike<number>) {
  const dst = out as unknown as number[], half = out instanceof Uint16Array, bytes = out instanceof Uint8Array || out instanceof Uint8ClampedArray;
  for (let row = 0; row < Math.min(h, res.height); row++) {
    for (let col = 0; col < Math.min(w, res.width); col++) {
      const s = (row * res.width + col) * 4, o = (row * w + col) * 4;
      for (let c = 0; c < 4; c++) {
        const v = res.floats[s + c];
        dst[o + c] = half ? DataUtils.toHalfFloat(v) : bytes ? Math.max(0, Math.min(255, Math.round(v * 255))) : v;
      }
    }
  }
}

function readPasses(d: PassDraw, x: number, y: number, w: number, h: number, out: ArrayLike<number>): boolean {
  const res = run(d, x, y, w, h);
  if (typeof res === 'string') { warnOnce(res); return false; }
  copyOut(res, w, h, out);
  return true;
}

/** readRenderTargetPixels: true when Unreal ran the passes behind the target into the buffer; false when it could
 *  not; undefined for a read this runner leaves to the picture of the scene (readback.ts): a target a scene was
 *  drawn into last, and a large read of a pass chain that starts from a scene (an export frame). */
export function runPassRead(target: Obj, x: number, y: number, w: number, h: number, out: ArrayLike<number>, small: boolean): boolean | undefined {
  const d = drawOf(target);
  if (d?.kind !== 'pass' || (!small && d.src)) return undefined;
  return readPasses(d, x, y, w, h, out);
}

/** readRenderTargetPixelsAsync: a promise of the buffer when Unreal ran the passes behind the target; undefined to
 *  leave the read to the capture read (renderer.ts). */
export function passReadAsync(target: Obj, x: number, y: number, w: number, h: number, buffer?: ArrayLike<number>): Promise<unknown> | undefined {
  const d = drawOf(target);
  if (d?.kind !== 'pass') return undefined;
  const out = buffer && buffer.length >= w * h * 4 ? buffer : new Float32Array(w * h * 4);
  return readPasses(d, x, y, w, h, out) ? Promise.resolve(out) : undefined;
}
