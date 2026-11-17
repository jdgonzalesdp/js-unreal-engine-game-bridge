/** IANA time zones for Intl.DateTimeFormat and Date's toLocale*String, which Puerts' V8 has no zone database for.
 *  intl.ts formats in the machine's own zone (or UTC) whatever timeZone was asked for, and formatToParts gave one
 *  literal part. A page that turns a wall-clock time at a place into an instant (a sun position at a location's local
 *  time) read the parts back as NaN. This wraps the runtime's DateTimeFormat:
 *  - a named zone ("America/New_York") or offset ("+05:30") formats that zone's wall clock, daylight saving included
 *    (tzData.ts: every zone's changes from 2000 through 2040; a date outside that takes the rules of the same date 28
 *    years nearer, when the calendar repeats);
 *  - an unknown zone throws RangeError, as browsers do, so a page can test a zone name;
 *  - formatToParts gives typed parts (year, month, day, hour, minute, second, weekday, dayPeriod, literal);
 *  - resolvedOptions().timeZone names the machine's zone (the host's __jsgbHost.timeZone, or the zone whose rules match
 *    the machine's clock) instead of "UTC". */
import {TZ_RULES, TZ_ZONES, TZ_FIRST_YEAR, TZ_LAST_YEAR} from './tzData';

const g = globalThis as Record<string, any>;
type O = Record<string, any>;
const START = Date.UTC(TZ_FIRST_YEAR, 0, 1) / 60000, END = Date.UTC(TZ_LAST_YEAR + 1, 0, 1) / 60000;
const CYCLE = (28 * 365 + 7) * 1440;

let zoneTable: Map<string, {name: string; rule: number}> | null = null;
function zones() {
  if (zoneTable) return zoneTable;
  zoneTable = new Map();
  for (const entry of TZ_ZONES.split(' ')) {
    const at = entry.lastIndexOf('=');
    if (at > 0) zoneTable.set(entry.slice(0, at).toLowerCase(), {name: entry.slice(0, at), rule: parseInt(entry.slice(at + 1), 36)});
  }
  return zoneTable;
}
const rules = new Map<number, {base: number; at: number[]; off: number[]}>();
function rule(i: number) {
  let r = rules.get(i);
  if (r) return r;
  const [head, ...changes] = TZ_RULES[i].split(','), at: number[] = [], off: number[] = [];
  let t = START;
  for (const c of changes) { const [d, o] = c.split(':'); t += parseInt(d, 36); at.push(t); off.push(parseInt(o, 36)); }
  rules.set(i, r = {base: parseInt(head, 36), at, off});
  return r;
}

const OFFSET_ZONE = /^([+-])(\d{2}):?(\d{2})?$/;
/** The zone's canonical name ("UTC", "America/New_York", "+05:30"), or null when it is not a zone. */
export function canonicalZone(tz: unknown): string | null {
  const s = String(tz).trim();
  if (/^(utc|gmt|etc\/(utc|gmt|universal|zulu|greenwich)|universal|zulu|greenwich|z)$/i.test(s)) return 'UTC';
  const m = OFFSET_ZONE.exec(s);
  if (m) return Number(m[2]) <= 23 && Number(m[3] ?? 0) <= 59 ? `${m[1]}${m[2]}:${m[3] ?? '00'}` : null;
  return zones().get(s.toLowerCase())?.name ?? null;
}

/** The zone's offset from UTC, in minutes, at instant `ms` (a canonical name from canonicalZone). */
export function zoneOffset(zone: string, ms: number): number {
  if (zone === 'UTC') return 0;
  const m = OFFSET_ZONE.exec(zone);
  if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  const z = zones().get(zone.toLowerCase());
  if (!z || !Number.isFinite(ms)) return 0;
  const r = rule(z.rule);
  let t = Math.floor(ms / 60000);
  while (t < START) t += CYCLE;
  while (t >= END) t -= CYCLE;
  let lo = 0, hi = r.at.length - 1, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (r.at[mid] <= t) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  return found < 0 ? r.base : r.off[found];
}

const PREFERRED = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage',
  'Pacific/Honolulu', 'America/Halifax', 'America/St_Johns', 'America/Toronto', 'America/Vancouver', 'America/Mexico_City', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Dublin', 'Europe/Lisbon', 'Europe/Paris', 'Europe/Berlin', 'Europe/Athens', 'Europe/Moscow', 'Africa/Johannesburg',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore', 'Australia/Perth', 'Australia/Adelaide',
  'Australia/Brisbane', 'Australia/Sydney', 'Pacific/Auckland'];
let localName: string | null = null;
/** The machine's zone: the host's name for it when it gives one, else the first zone whose offsets match the
 *  machine's clock every week of this year and last (zones with the same rules give the same times). */
export function localZone(): string {
  if (localName) return localName;
  const fromHost = g.__jsgbHost?.timeZone, named = typeof fromHost === 'string' ? canonicalZone(fromHost) : null;
  if (named) return localName = named;
  const year = new Date().getFullYear(), samples: number[] = [];
  for (let t = Date.UTC(year - 1, 0, 1); t < Date.UTC(year + 1, 0, 1); t += 7 * 864e5) samples.push(t);
  const fits = (z: string) => samples.every(t => zoneOffset(z, t) === -new Date(t).getTimezoneOffset());
  const all = [...zones().values()].map(z => z.name).filter(n => /^[A-Z][a-z]+\/[A-Za-z_]/.test(n) && !/^(US|Canada|Brazil|Chile|Mexico|Australia\/(ACT|NSW|North|South|West|LHI))/.test(n));
  localName = PREFERRED.find(fits) ?? all.find(fits) ?? 'UTC';
  if (localName === 'UTC' && samples.some(t => new Date(t).getTimezoneOffset())) {
    const o = -new Date().getTimezoneOffset(), a = Math.abs(o);
    localName = `${o < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
  }
  return localName;
}

const offsetLabel = (zone: string, ms: number) => {
  if (zone === 'UTC') return 'UTC';
  const o = zoneOffset(zone, ms), a = Math.abs(o);
  return o === 0 ? 'GMT' : `GMT${o < 0 ? '-' : '+'}${Math.floor(a / 60)}${a % 60 ? ':' + String(a % 60).padStart(2, '0') : ''}`;
};
const instant = (d: unknown) => d === undefined ? Date.now() : d instanceof Date ? d.getTime() : Number(d);
/** The instant moved so its UTC fields read the zone's wall clock. */
const shifted = (zone: string | null, ms: number) => new Date(ms + (zone ? zoneOffset(zone, ms) : -new Date(ms).getTimezoneOffset()) * 60000);

const MONTHS = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/, DAYS = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)/;
/** The fields a format shows, as intl.ts fills in a format's defaults. */
function fields(o: O): Set<string> {
  const f = new Set(['weekday', 'year', 'month', 'day', 'hour', 'minute', 'second'].filter(k => o[k] !== undefined));
  if (o.dateStyle) { f.add('year'); f.add('month'); f.add('day'); if (o.dateStyle === 'full') f.add('weekday'); }
  if (o.timeStyle) { f.add('hour'); f.add('minute'); if (o.timeStyle !== 'short') f.add('second'); }
  if (!f.size) { f.add('year'); f.add('month'); f.add('day'); }
  return f;
}
/** Typed parts of an en-US date string, read in the order intl.ts writes the fields. */
export function partsOf(text: string, o: O, zoneName?: string): {type: string; value: string}[] {
  const f = fields(o), textMonth = !!o.month && !/^(numeric|2-digit)$/.test(o.month) || (o.dateStyle && o.dateStyle !== 'short');
  const queue = [...(textMonth ? ['day', 'year'] : ['month', 'day', 'year']), 'hour', 'minute', 'second', 'fractionalSecond']
    .filter(k => k === 'fractionalSecond' ? !!o.fractionalSecondDigits : f.has(k));
  let tail = '';
  if (zoneName && text.endsWith(' ' + zoneName)) { text = text.slice(0, -zoneName.length - 1); tail = zoneName; }
  const out: {type: string; value: string}[] = [];
  const push = (type: string, value: string) => { const last = out[out.length - 1]; if (type === 'literal' && last?.type === 'literal') last.value += value; else out.push({type, value}); };
  for (const tok of text.match(/\d+|[A-Za-z]+|[^\dA-Za-z]+/g) ?? []) {
    if (/^\d/.test(tok)) push(queue.shift() ?? 'literal', tok);
    else if (tok === 'AM' || tok === 'PM') push('dayPeriod', tok);
    else if (MONTHS.test(tok) && f.has('month')) push('month', tok);
    else if (DAYS.test(tok) && f.has('weekday')) push('weekday', tok);
    else push('literal', tok);
  }
  if (tail) { push('literal', ' '); push('timeZoneName', tail); }
  return out;
}

/** The runtime's DateTimeFormat with time zones (see the top of this file). */
export function zonedDateTimeFormat(Base: new (l?: unknown, o?: O) => O) {
  class DateTimeFormat {
    private inner: O; private zone: string | null; private name: string; private o: O;
    constructor(locales?: unknown, options?: O) {
      const o = {...(options ?? {})};
      let zone: string | null = null;
      if (o.timeZone !== undefined) { zone = canonicalZone(o.timeZone); if (!zone) throw new RangeError(`Invalid time zone specified: ${o.timeZone}`); }
      this.zone = zone; this.name = zone ?? localZone(); this.o = o;
      const {timeZoneName, ...rest} = o;
      this.inner = new Base(locales, {...rest, timeZone: 'UTC'});
      void timeZoneName;
    }
    private label(ms: number) { return this.o.timeZoneName ? offsetLabel(this.zone ?? this.name, ms) : ''; }
    format = (d?: unknown) => {
      const ms = instant(d), text = this.inner.format(shifted(this.zone, ms)), label = this.label(ms);
      return label && text !== 'Invalid Date' ? `${text} ${label}` : text;
    };
    formatToParts(d?: unknown) { const ms = instant(d); return partsOf(this.format(ms), this.o, this.label(ms) || undefined); }
    formatRange(a: unknown, b: unknown) { return `${this.format(a)} – ${this.format(b)}`; }
    formatRangeToParts(a: unknown, b: unknown) { return [...this.formatToParts(a), {type: 'literal', value: ' – '}, ...this.formatToParts(b)]; }
    resolvedOptions() { return {...this.inner.resolvedOptions(), ...this.o, timeZone: this.name}; }
    static supportedLocalesOf(...a: unknown[]) { return (Base as unknown as O).supportedLocalesOf?.(...a) ?? ['en-US']; }
  }
  return new Proxy(DateTimeFormat, {apply: (_t, _self, args: [unknown?, O?]) => new DateTimeFormat(...args)});
}

/** True when this engine already formats named zones (V8 with ICU): nothing is installed then. */
function nativeZones(): boolean {
  try {
    const f = new g.Intl.DateTimeFormat('en-US', {timeZone: 'Asia/Tokyo', hour: 'numeric', hourCycle: 'h23'});
    return f.format(Date.UTC(2020, 0, 1, 0)) === '9' && f.formatToParts(0).length > 1;
  } catch { return false; }
}

let installed = false;
export function installTimeZones(force = false) {
  if (installed || !g.Intl?.DateTimeFormat || (!force && nativeZones())) return;
  installed = true;
  const Intl = g.Intl as O;
  Intl.DateTimeFormat = zonedDateTimeFormat(Intl.DateTimeFormat);
  const values = Intl.supportedValuesOf as ((k: string) => string[]) | undefined;
  Intl.supportedValuesOf = (key: string) => key === 'timeZone' ? [...zones().values()].map(z => z.name).filter(n => n.includes('/') && !/^(Etc|US|Canada|Brazil|Chile|Mexico)\//.test(n)) : values?.(key) ?? [];
  const DP = Date.prototype as unknown as O;
  for (const [name, defaults] of [['toLocaleString', {}], ['toLocaleDateString', {year: 'numeric', month: 'numeric', day: 'numeric'}],
    ['toLocaleTimeString', {hour: 'numeric', minute: '2-digit', second: '2-digit'}]] as const) {
    const own = DP[name] as (this: Date, l?: unknown, o?: O) => string;
    Object.defineProperty(DP, name, {configurable: true, writable: true, value(this: Date, locales?: unknown, options?: O) {
      if (!options || options.timeZone === undefined) return own.call(this, locales, options);
      const zone = canonicalZone(options.timeZone);
      if (!zone) throw new RangeError(`Invalid time zone specified: ${options.timeZone}`);
      const asked = ['weekday', 'year', 'month', 'day', 'hour', 'minute', 'second', 'dateStyle', 'timeStyle'].some(k => options[k] !== undefined);
      const {timeZoneName, ...rest} = options, ms = this.getTime();
      const text = own.call(shifted(zone, ms), locales, {...(asked ? {} : defaults), ...rest, timeZone: 'UTC'});
      return timeZoneName ? `${text} ${offsetLabel(zone, ms)}` : text;
    }});
  }
}
installTimeZones();
