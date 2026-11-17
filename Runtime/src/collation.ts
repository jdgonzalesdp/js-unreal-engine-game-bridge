/** String.prototype.localeCompare and Intl.Collator ordered as a browser orders text, which Puerts' V8 (no ICU) does
 *  by UTF-16 code units: there, every capitalized name sorted before every lower-case one ("Zebra" before "apple"),
 *  an accented letter after "z", and localeCompare ignored its options ({numeric: true} put "Shot 10" before "Shot 2").
 *  This follows the Unicode root collation the way browsers apply it, in three levels:
 *  1. the letters themselves, accents and case set aside (spaces, then punctuation and symbols, then digits, then
 *     letters; with numeric, a run of digits compares as a number);
 *  2. accents (an unaccented letter first);
 *  3. case (lower case first, unless caseFirst is "upper").
 *  sensitivity "base" compares level 1 only, "accent" levels 1 and 2, "case" levels 1 and 3, "variant" all three. */
import {normalizeText} from './textNormalize';

const g = globalThis as Record<string, any>;
type Options = {numeric?: boolean; sensitivity?: string; ignorePunctuation?: boolean; caseFirst?: string; usage?: string};
type El = {group: number; w: number; num?: string; accent: number; upper: number};

// The order of the ASCII spaces, punctuation and symbols in the root collation; others follow by code point.
const PUNCT = '\t\n\v\f\r _-,;:!?.\'"()[]{}@*/\\&#%`^+<=>|~$';
const SPACE = 1, PUNCTUATION = 2, DIGIT = 3, LETTER = 4;
const isMark = (c: number) => c >= 0x300 && c <= 0x36f;
const isDigit = (c: number) => c >= 48 && c <= 57;
function isLetter(ch: string, c: number): boolean {
  if (ch.toLowerCase() !== ch.toUpperCase()) return true;
  if (c < 0x590) return false;
  return !((c >= 0x2000 && c <= 0x2bff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff20) || (c >= 0xfff0));
}

function elements(text: string, o: Options): El[] {
  const s = normalizeText(text, 'NFKD'), out: El[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)!, ch = String.fromCodePoint(c);
    if (c > 0xffff) i++;
    if (isMark(c)) { const prev = out[out.length - 1]; if (prev) prev.accent = prev.accent * 128 + (c - 0x2ff); continue; }
    if (isDigit(c)) {
      if (o.numeric) {
        let j = i; while (j + 1 < s.length && isDigit(s.charCodeAt(j + 1))) j++;
        const run = s.slice(i, j + 1).replace(/^0+(?=\d)/, '');
        out.push({group: DIGIT, w: 0, num: run, accent: 0, upper: 0});
        i = j;
      } else out.push({group: DIGIT, w: c - 48, accent: 0, upper: 0});
      continue;
    }
    if (isLetter(ch, c)) {
      const lower = ch.toLowerCase();
      out.push({group: LETTER, w: lower.codePointAt(0)!, accent: 0, upper: lower !== ch ? 1 : 0});
      continue;
    }
    if (o.ignorePunctuation) continue;
    const at = PUNCT.indexOf(ch);
    out.push({group: at >= 0 && at < 6 || c === 0xa0 || (c >= 0x2000 && c <= 0x200a) ? SPACE : PUNCTUATION, w: at >= 0 ? at : 0x100 + c, accent: 0, upper: 0});
  }
  return out;
}

function comparePrimary(a: El, b: El): number {
  if (a.group !== b.group) return a.group - b.group;
  if (a.num !== undefined && b.num !== undefined) return a.num.length - b.num.length || (a.num < b.num ? -1 : a.num > b.num ? 1 : 0);
  return a.w - b.w;
}

/** Compares two strings as the root collation does with these options: negative, zero or positive. */
export function collate(x: string, y: string, o: Options = {}): number {
  const a = elements(String(x), o), b = elements(String(y), o);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const d = comparePrimary(a[i], b[i]); if (d) return Math.sign(d); }
  if (a.length !== b.length) return Math.sign(a.length - b.length);
  const sensitivity = o.sensitivity ?? 'variant';
  if (sensitivity === 'base') return 0;
  if (sensitivity !== 'case') for (let i = 0; i < n; i++) { const d = a[i].accent - b[i].accent; if (d) return Math.sign(d); }
  if (sensitivity === 'accent') return 0;
  const upperFirst = o.caseFirst === 'upper' ? -1 : 1;
  for (let i = 0; i < n; i++) { const d = a[i].upper - b[i].upper; if (d) return Math.sign(d) * upperFirst; }
  return 0;
}

export class Collator {
  private o: Options;
  constructor(_locales?: unknown, options: Options = {}) {
    const o = {...(options ?? {})};
    this.o = {numeric: !!o.numeric, sensitivity: o.sensitivity ?? 'variant', ignorePunctuation: !!o.ignorePunctuation, caseFirst: o.caseFirst ?? 'false', usage: o.usage ?? 'sort'};
  }
  compare = (a: unknown, b: unknown) => collate(String(a), String(b), this.o);
  resolvedOptions() { return {locale: 'en-US', collation: 'default', ...this.o}; }
  static supportedLocalesOf() { return ['en-US']; }
}

let installed = false;
export function installCollation() {
  if (installed) return;
  installed = true;
  // V8 with ICU puts "a" before "B"; ordering by code units puts it after.
  if ('a'.localeCompare('B') < 0) return;
  Object.defineProperty(String.prototype, 'localeCompare', {configurable: true, writable: true,
    value(this: string, that: unknown, _locales?: unknown, options?: Options) { return collate(String(this), String(that), options ?? {}); }});
  if (g.Intl) g.Intl.Collator = new Proxy(Collator, {apply: (_t, _self, args: [unknown?, Options?]) => new Collator(...args)});
}
installCollation();
