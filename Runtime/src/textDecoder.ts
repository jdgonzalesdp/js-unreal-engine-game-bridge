/** TextDecoder as browsers have it. The runtime's first one (polyfills.ts) decoded each call on its own and read past the
 *  end of a cut UTF-8 sequence, so decode(chunk, {stream: true}) garbled any character split between two network
 *  chunks (a streamed reply, server-sent events), and it had no fatal mode, no BOM handling and no other encodings.
 *  This one follows the WHATWG decoders: UTF-8 (stream, fatal, ignoreBOM), UTF-16LE/BE and windows-1252 (which the
 *  labels latin1, iso-8859-1 and ascii also name). It is installed only where the engine's own can't stream. */
const g = globalThis as Record<string, any>;

const LABELS: Record<string, string> = {
  'utf-8': 'utf-8', utf8: 'utf-8', 'unicode-1-1-utf-8': 'utf-8', 'unicode11utf8': 'utf-8', 'unicode20utf8': 'utf-8', 'x-unicode20utf8': 'utf-8',
  'utf-16le': 'utf-16le', 'utf-16': 'utf-16le', ucs2: 'utf-16le', 'ucs-2': 'utf-16le', unicode: 'utf-16le', 'csunicode': 'utf-16le',
  'utf-16be': 'utf-16be', 'unicodefffe': 'utf-16be',
  'windows-1252': 'windows-1252', latin1: 'windows-1252', 'iso-8859-1': 'windows-1252', 'iso8859-1': 'windows-1252', 'l1': 'windows-1252',
  ascii: 'windows-1252', 'us-ascii': 'windows-1252', 'cp1252': 'windows-1252', 'x-cp1252': 'windows-1252', 'cp819': 'windows-1252',
};
/** windows-1252 bytes 0x80 to 0x9f; the rest map to the same code point. */
const CP1252 = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];

const invalid = () => new TypeError('The encoded data was not valid.');

/** UTF-16 code units to a string, a slice at a time (fromCharCode.apply has an argument limit). */
function unitsText(out: Uint16Array, n: number): string {
  if (n <= 0x2000) return String.fromCharCode.apply(null, out.subarray(0, n) as unknown as number[]);
  const parts: string[] = [];
  for (let i = 0; i < n; i += 0x2000) parts.push(String.fromCharCode.apply(null, out.subarray(i, Math.min(n, i + 0x2000)) as unknown as number[]));
  return parts.join('');
}

const bytesOf = (input: unknown): Uint8Array => {
  if (input == null) return new Uint8Array(0);
  if (input instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && input instanceof SharedArrayBuffer)) return new Uint8Array(input as ArrayBuffer);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('TextDecoder.decode: the input must be an ArrayBuffer or a view of one');
};

export class StreamingTextDecoder {
  readonly encoding: string; readonly fatal: boolean; readonly ignoreBOM: boolean;
  // UTF-8 state carried between stream calls (the WHATWG decoder's bytes needed, bytes seen, code point and bounds).
  private needed = 0; private seen = 0; private cp = 0; private lower = 0x80; private upper = 0xbf;
  /** A byte held back between calls (UTF-16), and a high surrogate waiting for its pair. */
  private odd = -1; private lead = -1;
  /** Whether this stream has produced output yet: a byte order mark is dropped only at its start. */
  private begun = false;

  constructor(label = 'utf-8', options: {fatal?: boolean; ignoreBOM?: boolean} = {}) {
    const name = LABELS[String(label).trim().toLowerCase()];
    if (!name) throw new RangeError(`The encoding label provided ('${label}') is invalid.`);
    this.encoding = name; this.fatal = !!options?.fatal; this.ignoreBOM = !!options?.ignoreBOM;
  }

  decode(input?: unknown, options: {stream?: boolean} = {}): string {
    const bytes = bytesOf(input), stream = !!options?.stream;
    let text: string;
    try { text = this.encoding === 'utf-8' ? this.utf8(bytes, !stream) : this.encoding === 'windows-1252' ? this.single(bytes) : this.utf16(bytes, !stream); }
    catch (e) { this.reset(); throw e; }
    if (!this.begun && text) {
      this.begun = true;
      if (!this.ignoreBOM && text.charCodeAt(0) === 0xfeff && this.encoding !== 'windows-1252') text = text.slice(1);
    }
    if (!stream) this.reset();
    return text;
  }

  private reset() { this.needed = this.seen = this.cp = 0; this.lower = 0x80; this.upper = 0xbf; this.odd = this.lead = -1; this.begun = false; }

  private utf8(b: Uint8Array, end: boolean): string {
    const out = new Uint16Array(b.length + 4), fatal = this.fatal;
    let n = 0, needed = this.needed, seen = this.seen, cp = this.cp, lower = this.lower, upper = this.upper;
    const len = b.length;
    for (let i = 0; i < len; i++) {
      let byte = b[i];
      if (needed === 0) {
        if (byte < 0x80) {
          // A run of ASCII, the common case, copied in a tight loop.
          out[n++] = byte;
          while (i + 1 < len && (byte = b[i + 1]) < 0x80) { out[n++] = byte; i++; }
          continue;
        }
        if (byte >= 0xc2 && byte <= 0xdf) { needed = 1; cp = byte & 0x1f; }
        else if (byte >= 0xe0 && byte <= 0xef) { if (byte === 0xe0) lower = 0xa0; else if (byte === 0xed) upper = 0x9f; needed = 2; cp = byte & 0xf; }
        else if (byte >= 0xf0 && byte <= 0xf4) { if (byte === 0xf0) lower = 0x90; else if (byte === 0xf4) upper = 0x8f; needed = 3; cp = byte & 7; }
        else { if (fatal) throw invalid(); out[n++] = 0xfffd; }
        continue;
      }
      if (byte < lower || byte > upper) {
        // A cut sequence: one replacement for it, then this byte starts over.
        needed = seen = cp = 0; lower = 0x80; upper = 0xbf;
        if (fatal) throw invalid();
        out[n++] = 0xfffd; i--;
        continue;
      }
      lower = 0x80; upper = 0xbf; cp = (cp << 6) | (byte & 0x3f);
      if (++seen !== needed) continue;
      if (cp >= 0x10000) { cp -= 0x10000; out[n++] = 0xd800 + (cp >> 10); out[n++] = 0xdc00 + (cp & 0x3ff); } else out[n++] = cp;
      needed = seen = cp = 0;
    }
    if (end && needed) { needed = seen = cp = 0; lower = 0x80; upper = 0xbf; if (fatal) throw invalid(); out[n++] = 0xfffd; }
    this.needed = needed; this.seen = seen; this.cp = cp; this.lower = lower; this.upper = upper;
    return unitsText(out, n);
  }

  private single(b: Uint8Array): string {
    const out = new Uint16Array(b.length);
    for (let i = 0; i < b.length; i++) { const c = b[i]; out[i] = c >= 0x80 && c < 0xa0 ? CP1252[c - 0x80] : c; }
    return unitsText(out, b.length);
  }

  private utf16(b: Uint8Array, end: boolean): string {
    const big = this.encoding === 'utf-16be', out = new Uint16Array((b.length >> 1) + 4);
    let n = 0, i = 0, lead = this.lead;
    const unit = (u: number) => {
      if (lead >= 0) {
        if (u >= 0xdc00 && u <= 0xdfff) { out[n++] = lead; out[n++] = u; lead = -1; return; }
        lead = -1; if (this.fatal) throw invalid(); out[n++] = 0xfffd;
      }
      if (u >= 0xd800 && u <= 0xdbff) { lead = u; return; }
      if (u >= 0xdc00 && u <= 0xdfff) { if (this.fatal) throw invalid(); out[n++] = 0xfffd; return; }
      out[n++] = u;
    };
    if (this.odd >= 0 && b.length) { unit(big ? (this.odd << 8) | b[0] : this.odd | (b[0] << 8)); this.odd = -1; i = 1; }
    for (; i + 1 < b.length; i += 2) unit(big ? (b[i] << 8) | b[i + 1] : b[i] | (b[i + 1] << 8));
    if (i < b.length) this.odd = b[i];
    if (end && (lead >= 0 || this.odd >= 0)) { lead = -1; this.odd = -1; if (this.fatal) throw invalid(); out[n++] = 0xfffd; }
    this.lead = lead;
    return unitsText(out, n);
  }
}

/** Installs the decoder when the engine's own can't continue a character across stream calls (Puerts: the polyfill). */
export function installTextDecoder() {
  const Current = g.TextDecoder;
  if (typeof Current === 'function') {
    try {
      const d = new Current('utf-8');
      // A euro sign cut after its second byte: a streaming decoder holds it back and finishes it on the next call.
      if (d.decode(new Uint8Array([0xe2, 0x82]), {stream: true}) === '' && d.decode(new Uint8Array([0xac])) === '€') return;
    } catch { /* not a usable decoder: replace it */ }
  }
  g.TextDecoder = StreamingTextDecoder;
}
