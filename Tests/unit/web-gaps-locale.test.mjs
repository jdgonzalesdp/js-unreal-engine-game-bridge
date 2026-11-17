// Time zones, collation and normalization without ICU (timeZones.ts, collation.ts, textNormalize.ts), checked against
// Node's own ICU. The page boots with the runtime's Intl (intl.ts), as in Puerts.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bootGaps, NativeIntl} from './web-gaps-page.mjs';

const g = globalThis;
const nativeCompare = String.prototype.localeCompare;
const nativeNormalize = String.prototype.normalize;

/** Node's answer: the zone's offset in minutes at ms. */
function nativeOffset(tz, ms) {
  const p = {};
  for (const x of new NativeIntl.DateTimeFormat('en-US', {timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric'}).formatToParts(ms)) p[x.type] = Number(x.value);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute) - Math.floor(ms / 60000) * 60000) / 60000);
}

const ZONES = ['America/New_York', 'America/Los_Angeles', 'America/Phoenix', 'America/Sao_Paulo', 'America/St_Johns', 'Europe/London', 'Europe/Berlin',
  'Europe/Moscow', 'Asia/Kolkata', 'Asia/Calcutta', 'Asia/Kathmandu', 'Asia/Tokyo', 'Australia/Sydney', 'Australia/Lord_Howe', 'Pacific/Auckland',
  'Pacific/Chatham', 'Africa/Casablanca', 'America/Santiago', 'Asia/Tehran', 'US/Pacific', 'Etc/GMT+5', 'UTC'];

test('a named zone gives the offset ICU gives, daylight saving included, from 2000 through 2040', async () => {
  const {canonicalZone, zoneOffset} = await bootGaps();
  const misses = [];
  for (const tz of ZONES) {
    const zone = canonicalZone(tz);
    assert.ok(zone, tz + ' is a zone');
    for (let t = Date.UTC(2000, 0, 1, 7); t < Date.UTC(2041, 0, 1); t += 9.7 * 864e5) {
      const want = nativeOffset(tz, t), got = zoneOffset(zone, t);
      if (want !== got) misses.push(`${tz} ${new Date(t).toISOString()}: ${got} not ${want}`);
    }
  }
  assert.deepEqual(misses.slice(0, 5), []);
  assert.equal(canonicalZone('america/new_york'), 'America/New_York', 'zone names are case-insensitive');
  assert.equal(canonicalZone('+0530'), '+05:30');
  assert.equal(canonicalZone('Mars/Olympus_Mons'), null);
});

test('formatToParts gives typed parts in the asked zone, so wall-clock time at a place converts to an instant', async () => {
  await bootGaps();
  const opts = {hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'};
  const typed = parts => Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  for (const tz of ['America/Los_Angeles', 'Europe/Berlin', 'Asia/Kolkata', 'Australia/Sydney']) {
    for (const t of [Date.UTC(2026, 0, 15, 3, 4, 5), Date.UTC(2026, 6, 1, 19, 0, 0), Date.UTC(2031, 2, 30, 1, 30, 0)]) {
      const ours = typed(new g.Intl.DateTimeFormat('en-US', {...opts, timeZone: tz}).formatToParts(new Date(t)));
      const theirs = typed(new NativeIntl.DateTimeFormat('en-US', {...opts, timeZone: tz}).formatToParts(new Date(t)));
      assert.deepEqual(ours, theirs, `${tz} at ${new Date(t).toISOString()}`);
    }
  }
  // The page's own conversion (wall clock at a place to UTC), as PrepViz's zonedTime.ts does it: noon in Los Angeles
  // on 1 July 2026 is 19:00 UTC.
  const f = new g.Intl.DateTimeFormat('en-US', {...opts, timeZone: 'America/Los_Angeles'});
  const p = typed(f.formatToParts(new Date(Date.UTC(2026, 6, 1, 12))));
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Date.UTC(2026, 6, 1, 12);
  assert.equal(Date.UTC(2026, 6, 1, 12) - offset, Date.UTC(2026, 6, 1, 19));
});

test('an unknown zone throws RangeError, and the default zone is the machine\'s, not UTC', async () => {
  const {localZone, zoneOffset} = await bootGaps();
  assert.throws(() => new g.Intl.DateTimeFormat('en-US', {timeZone: 'Not/AZone'}), RangeError);
  assert.throws(() => new Date(0).toLocaleString('en-US', {timeZone: 'Not/AZone'}), RangeError);
  const zone = g.Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(zone, localZone());
  for (const t of [Date.UTC(2026, 0, 10), Date.UTC(2026, 6, 10), Date.UTC(2026, 9, 30), Date.UTC(2026, 2, 20)]) {
    assert.equal(zoneOffset(zone, t), -new Date(t).getTimezoneOffset(), `${zone} follows the machine's clock`);
  }
  assert.equal(new Date(Date.UTC(2026, 6, 1, 19)).toLocaleTimeString('en-US', {timeZone: 'Asia/Tokyo', hour: 'numeric', minute: '2-digit'}), '4:00 AM');
  assert.ok(g.Intl.supportedValuesOf('timeZone').includes('Europe/Paris'));
});

test('collation orders as ICU does: case and accents after the letters, numbers by value with numeric', async () => {
  const {collate} = await bootGaps({keepIntl: true});
  const words = ['apple', 'Apple', 'APPLE', 'Zebra', 'zebra', 'banana', 'Banana', 'éclair', 'eclair', 'Eclair', 'café', 'cafe', 'Café', 'naïve', 'naive',
    'Shot 10', 'Shot 2', 'shot 1', 'shot-1', 'shot_1', 'a b', 'ab', 'a-b', '10', '9', '1a', 'A1', '_x', 'x', '', 'Ötzi', 'Oz', 'resume', 'résumé'];
  const sign = n => Math.sign(n);
  const misses = [];
  for (const opts of [{}, {sensitivity: 'base'}, {sensitivity: 'accent'}, {numeric: true}, {numeric: true, sensitivity: 'base'}, {caseFirst: 'upper'}]) {
    for (const a of words) for (const b of words) {
      const want = sign(nativeCompare.call(a, b, 'en', opts)), got = sign(collate(a, b, opts));
      if (want !== got) misses.push(`${JSON.stringify(opts)} ${a} vs ${b}: ${got} not ${want}`);
    }
  }
  assert.deepEqual(misses.slice(0, 8), []);
});

test('normalize splits and rejoins Latin letters as ICU does', async () => {
  const {normalizeText} = await bootGaps({keepIntl: true});
  for (const s of ['Café', 'naïve façade', 'Ångström', 'Đặng Thị Ấn', 'ﬁnancial ½', 'plain ascii', 'São Tomé', 'Œuvre']) {
    for (const form of ['NFD', 'NFC', 'NFKD', 'NFKC']) assert.equal(normalizeText(s, form), nativeNormalize.call(s, form), `${form} of ${s}`);
  }
  assert.equal(normalizeText('Café Crème', 'NFKD').replace(/[\u0300-\u036f]/g, ''), 'Cafe Creme');
});
