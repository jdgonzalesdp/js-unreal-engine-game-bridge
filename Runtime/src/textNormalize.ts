/** String.prototype.normalize for Latin text, which Puerts' V8 (no ICU) returns unchanged. Pages strip accents with
 *  s.normalize('NFD') and then remove the combining marks (U+0300 to U+036F) to make search words and slugs; unchanged, "Caf\u00e9" became "caf"
 *  instead of "cafe". NFD and NFKD split the Latin letters (latinData.ts) into a base letter and combining marks,
 *  NFC and NFKC put them back together; NFKD and NFKC also open the Latin ligatures and a few signs. Text outside
 *  those letters is left as it is. */
import {CANONICAL, COMPAT} from './latinData';

const table = (data: string) => new Map(data.split('|').filter(Boolean).map(e => { const ch = String.fromCodePoint(e.codePointAt(0)!); return [ch, e.slice(ch.length)] as [string, string]; }));
const canonical = table(CANONICAL), compat = table(COMPAT);
// Composition: the longest decomposed sequence that maps back to one letter wins.
const compose = new Map<string, string>([...canonical].map(([ch, d]) => [d, ch]));
const longest = Math.max(1, ...[...compose.keys()].map(k => k.length));
const isMark = (c: number) => c >= 0x300 && c <= 0x36f;

export function decompose(s: string, compatible: boolean): string {
  let out = '';
  for (const ch of s) out += (compatible ? compat.get(ch) : undefined) ?? canonical.get(ch) ?? ch;
  return out;
}
export function composeText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length;) {
    let hit = '', len = 0;
    if (i + 1 < s.length && isMark(s.charCodeAt(i + 1))) {
      for (let n = Math.min(longest, s.length - i); n >= 2; n--) { const c = compose.get(s.slice(i, i + n)); if (c) { hit = c; len = n; break; } }
    }
    if (hit) { out += hit; i += len; continue; }
    out += s[i++];
  }
  // A composed letter can take one more mark (a with a circumflex, then an acute): compose again until nothing changes.
  return out !== s && /[\u0300-\u036f]/.test(out) ? composeText(out) : out;
}

/** normalize(form) as the standard has it, for the letters this runtime knows. */
export function normalizeText(s: string, form = 'NFC'): string {
  switch (form) {
    case 'NFD': return decompose(s, false);
    case 'NFKD': return decompose(decompose(s, true), false);
    case 'NFC': return composeText(decompose(s, false));
    case 'NFKC': return composeText(decompose(decompose(s, true), false));
    default: throw new RangeError(`The normalization form should be one of NFC, NFD, NFKC, NFKD.`);
  }
}

let installed = false;
export function installNormalize() {
  if (installed) return;
  installed = true;
  // V8 with ICU decomposes e-acute into two code units; without it, normalize does nothing.
  if ('\u00e9'.normalize('NFD').length === 2) return;
  Object.defineProperty(String.prototype, 'normalize', {configurable: true, writable: true,
    value(this: string, form?: string) { return normalizeText(String(this), form === undefined ? 'NFC' : String(form)); }});
}
installNormalize();
