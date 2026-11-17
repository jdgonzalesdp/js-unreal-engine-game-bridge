/** WebCodecs video encoding (VideoEncoder, VideoFrame, EncodedVideoChunk) on the host's H.264 encoder: VideoToolbox on
 *  a Mac (JsgbVideoEncodeMac.mm). Chunks come out in AVC format with the avcC record as the decoder description, as
 *  Chrome's encoder gives them, so MP4 muxers take them as they are. Only H.264 ("avc1.*") is offered; a page asking
 *  for HEVC or VP9 is told it isn't supported and moves on. Installed only when the host can encode. */
import {media, type Pixels} from './media';

const g = globalThis as Record<string, any>;
type Init = {timestamp?: number; duration?: number; format?: string; codedWidth?: number; codedHeight?: number};

/** RGBA8 rows from the top for anything a VideoFrame can be made from. */
function pixelsOf(source: any, init: Init): Pixels {
  if (source?.__frame) return source.__frame.pixels();
  if (ArrayBuffer.isView(source) || source instanceof ArrayBuffer) {
    const w = init.codedWidth ?? 0, h = init.codedHeight ?? 0;
    const b = source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    const data = new Uint8ClampedArray(w * h * 4);
    if (/^RGB[AX]$/.test(init.format ?? '')) data.set(b.subarray(0, data.length));
    else if (/^BGR[AX]$/.test(init.format ?? '')) for (let i = 0; i < data.length; i += 4) { data[i] = b[i + 2]; data[i + 1] = b[i + 1]; data[i + 2] = b[i]; data[i + 3] = b[i + 3]; }
    else { // I420: BT.601 limited range
      const cw = Math.ceil(w / 2), u0 = w * h, v0 = u0 + cw * Math.ceil(h / 2);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const Y = 1.164 * ((b[y * w + x] ?? 16) - 16), c = (y >> 1) * cw + (x >> 1), U = (b[u0 + c] ?? 128) - 128, V = (b[v0 + c] ?? 128) - 128, o = (y * w + x) * 4;
        data[o] = Y + 1.596 * V; data[o + 1] = Y - 0.392 * U - 0.813 * V; data[o + 2] = Y + 2.017 * U; data[o + 3] = 255;
      }
    }
    return {width: w, height: h, data};
  }
  // ImageBitmap, canvas, image, ImageData: drawn into a 2D canvas and read back.
  const w = source?.width ?? source?.displayWidth ?? 0, h = source?.height ?? source?.displayHeight ?? 0;
  const c = new g.OffscreenCanvas(w, h), ctx = c.getContext('2d');
  if (source?.data && source.width) ctx.putImageData(source, 0, 0); else ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  return {width: w, height: h, data: img.data};
}

export class VideoFrameImpl {
  readonly timestamp: number; readonly duration: number | null; readonly codedWidth: number; readonly codedHeight: number; readonly format = 'RGBA';
  private cached: Pixels | null = null; private closed = false;
  readonly __frame: {pixels: () => Pixels};
  constructor(source: any, init: Init = {}) {
    const from = source?.__frame ? source as VideoFrameImpl : null;
    this.timestamp = init.timestamp ?? from?.timestamp ?? 0;
    this.duration = init.duration ?? from?.duration ?? null;
    this.codedWidth = init.codedWidth ?? from?.codedWidth ?? source?.width ?? 0;
    this.codedHeight = init.codedHeight ?? from?.codedHeight ?? source?.height ?? 0;
    // Pixels are taken now: the page may change or close the source right after.
    this.cached = pixelsOf(source, init);
    this.codedWidth = this.cached.width; this.codedHeight = this.cached.height;
    this.__frame = {pixels: () => { if (this.closed || !this.cached) throw new (g.DOMException ?? Error)('VideoFrame is closed', 'InvalidStateError'); return this.cached; }};
  }
  get displayWidth() { return this.codedWidth; } get displayHeight() { return this.codedHeight; }
  get visibleRect() { return {x: 0, y: 0, width: this.codedWidth, height: this.codedHeight}; }
  clone() { return new VideoFrameImpl(this); }
  close() { this.closed = true; this.cached = null; }
}

export class EncodedVideoChunkImpl {
  readonly type: string; readonly timestamp: number; readonly duration: number | null; private readonly data: Uint8Array;
  constructor(init: {type: string; timestamp: number; duration?: number; data: ArrayBuffer | ArrayBufferView}) {
    this.type = init.type; this.timestamp = init.timestamp; this.duration = init.duration ?? null;
    const d = init.data;
    this.data = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
  }
  get byteLength() { return this.data.length; }
  copyTo(dest: ArrayBuffer | ArrayBufferView) {
    const out = dest instanceof ArrayBuffer ? new Uint8Array(dest) : new Uint8Array(dest.buffer, dest.byteOffset, dest.byteLength);
    out.set(this.data);
  }
}

type Config = {codec: string; width: number; height: number; bitrate?: number; framerate?: number};
const h264 = (c: Partial<Config> | undefined) => !!c && /^avc[13]\./.test(String(c.codec)) && (c.width ?? 0) > 0 && (c.height ?? 0) > 0;
const hostJson = (c: Config) => JSON.stringify({width: c.width, height: c.height, bitrate: c.bitrate ?? 0, framerate: c.framerate ?? 30, codec: c.codec});

export class VideoEncoderImpl {
  state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
  encodeQueueSize = 0;
  ondequeue: (() => void) | null = null;
  private id = 0; private config: Config | null = null; private sentConfig = false; private polling = false;
  private listeners = new Set<() => void>();
  constructor(private readonly init: {output: (chunk: EncodedVideoChunkImpl, meta?: unknown) => void; error: (e: unknown) => void}) {}
  static async isConfigSupported(config: Config) {
    const m = media();
    return {supported: h264(config) && !!m?.videoSupported?.(hostJson(config)), config};
  }
  addEventListener(type: string, cb: () => void) { if (type === 'dequeue') this.listeners.add(cb); }
  removeEventListener(type: string, cb: () => void) { if (type === 'dequeue') this.listeners.delete(cb); }
  configure(config: Config) {
    if (this.state === 'closed') throw new (g.DOMException ?? Error)('VideoEncoder is closed', 'InvalidStateError');
    if (this.id) media()?.videoClose?.(this.id);
    this.config = config; this.sentConfig = false;
    this.id = h264(config) ? media()?.videoOpen?.(hostJson(config)) ?? 0 : 0;
    this.state = 'configured';
    if (!this.id) this.fail(new (g.DOMException ?? Error)(`Unsupported codec ${config.codec}`, 'NotSupportedError'));
  }
  encode(frame: VideoFrameImpl, options?: {keyFrame?: boolean}) {
    if (this.state !== 'configured' || !this.id) throw new (g.DOMException ?? Error)('VideoEncoder is not configured', 'InvalidStateError');
    const p = frame.__frame.pixels(), copy = new Uint8Array(p.data.length); copy.set(p.data);
    const duration = frame.duration ?? Math.round(1e6 / (this.config?.framerate || 30));
    if (!media()?.videoEncode?.(this.id, copy.buffer, p.width, p.height, frame.timestamp, duration, !!options?.keyFrame)) { this.fail(new Error('the video encoder refused a frame')); return; }
    this.encodeQueueSize++;
    this.poll();
  }
  async flush() {
    if (this.state !== 'configured' || !this.id) throw new (g.DOMException ?? Error)('VideoEncoder is not configured', 'InvalidStateError');
    if (!media()?.videoFlush?.(this.id)) { this.fail(new Error('the video encoder failed')); throw new Error('the video encoder failed'); }
    this.take();
    this.encodeQueueSize = 0;
  }
  reset() { if (this.id) media()?.videoClose?.(this.id); this.id = 0; this.state = 'unconfigured'; this.encodeQueueSize = 0; }
  close() { if (this.id) media()?.videoClose?.(this.id); this.id = 0; this.state = 'closed'; this.encodeQueueSize = 0; }
  private fail(error: unknown) { this.close(); setTimeout(() => this.init.error(error), 0); }
  /** Hands out the chunks the host finished: each one leaves the queue and fires dequeue. */
  private take() {
    const buf = this.id ? media()?.videoTake?.(this.id) : null;
    if (!buf || buf.byteLength < 8) return;
    const dv = new DataView(buf); let o = 0;
    const descSize = dv.getInt32(0, true); o = 8;
    const description = new Uint8Array(buf.slice(o, o + descSize)); o += (descSize + 7) & ~7;
    while (o + 24 <= buf.byteLength) {
      const key = dv.getInt32(o, true), size = dv.getInt32(o + 4, true), ts = dv.getFloat64(o + 8, true), dur = dv.getFloat64(o + 16, true);
      const data = new Uint8Array(buf, o + 24, size); o += 24 + ((size + 7) & ~7);
      const chunk = new EncodedVideoChunkImpl({type: key ? 'key' : 'delta', timestamp: ts, duration: dur, data});
      let meta: unknown;
      if (!this.sentConfig && key && descSize > 0 && this.config) {
        meta = {decoderConfig: {codec: this.config.codec, codedWidth: this.config.width, codedHeight: this.config.height, description}};
        this.sentConfig = true;
      }
      this.encodeQueueSize = Math.max(0, this.encodeQueueSize - 1);
      try { this.init.output(chunk, meta); } catch (e) { g.console?.error?.('VideoEncoder output: ' + e); }
      this.ondequeue?.(); for (const cb of [...this.listeners]) cb();
    }
  }
  private poll() {
    if (this.polling) return;
    this.polling = true;
    // An encoder that holds frames back for 2 s while the page waits for room in the queue is made to finish them.
    let waited = 0, queued = this.encodeQueueSize;
    const step = () => {
      this.take();
      if (this.state !== 'configured' || this.encodeQueueSize <= 0) { this.polling = false; return; }
      waited = this.encodeQueueSize < queued ? 0 : waited + 1; queued = this.encodeQueueSize;
      if (waited > 200 && this.id) { waited = 0; media()?.videoFlush?.(this.id); }
      setTimeout(step, 10);
    };
    setTimeout(step, 1);
  }
}

/** Installs the classes when the host encodes video and the engine has none of its own. */
export function installWebCodecs() {
  if (!media()?.videoOpen || typeof g.VideoEncoder === 'function') return;
  g.VideoEncoder = VideoEncoderImpl; g.VideoFrame = VideoFrameImpl; g.EncodedVideoChunk = EncodedVideoChunkImpl;
}
installWebCodecs();
