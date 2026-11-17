// The shared scene's quality tier and resolved sun/sky request (Runtime/src/sceneQuality.ts).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from './load-runtime.mjs';

function sceneQualityHost() {
  const host = {registry: '', sent: [], warnings: []};
  host.log = (level, text) => { if (level === 'warn') host.warnings.push(text); };
  host.sceneQuality = json => host.sent.push(json);
  return host;
}

function payload(overrides = {}) {
  return {
    tier: 'ultra',
    timeOfDay: 'magic-hour',
    intExt: 'ext',
    skyMode: 'procedural',
    skySolidColor: '#8aa0b8',
    sun: {
      on: true,
      castShadow: true,
      azDeg: 135,
      elDeg: 4,
      lux: 12000,
      cctK: 3200,
      colorHex: null,
      effectiveColorHex: '#ffb87b',
      discRadiusM: 900,
      distanceM: 260,
      falloff: 0.4,
      mode: 'sun',
    },
    ambient: {lux: 800, cctK: 5600, colorHex: null},
    ...overrides,
  };
}

test('a valid request is normalized and only carries a solid sky colour in colour mode', async () => {
  const m = await loadRuntime('sceneQuality.ts', sceneQualityHost());
  assert.deepEqual(m.sceneQualityRequest(payload()), {...payload(), skySolidColor: null});
  assert.equal(m.sceneQualityRequest(payload({skyMode: 'color'})).skySolidColor, '#8aa0b8');
});

test('numbers are held to range and malformed values reject the whole request', async () => {
  const m = await loadRuntime('sceneQuality.ts', sceneQualityHost());
  const clamped = payload();
  clamped.sun = {...clamped.sun, azDeg: 99999, elDeg: -999, lux: 999999};
  const normalized = m.sceneQualityRequest(clamped);
  assert.equal(normalized.sun.azDeg, 3600);
  assert.equal(normalized.sun.elDeg, -90);
  assert.equal(normalized.sun.lux, 250000);

  for (const bad of [null, undefined, 7, 'ultra', [], {}, payload({tier: 'max'}), payload({skyMode: 'hdri'}),
    payload({timeOfDay: 'Magic Hour'}), payload({intExt: 'interior'}), payload({sun: {...payload().sun, on: 1}}),
    payload({sun: {...payload().sun, mode: 'star'}}), payload({ambient: {lux: '800', cctK: null, colorHex: null}})]) {
    assert.equal(m.sceneQualityRequest(bad), null, JSON.stringify(bad)?.slice(0, 80));
  }
});

test('the host hears normalized JSON once per change, ignores malformed updates, and hears a drop', async () => {
  const host = sceneQualityHost();
  const m = await loadRuntime('sceneQuality.ts', host);
  assert.deepEqual(m.setSceneQuality(payload()), {...payload(), skySolidColor: null});
  assert.deepEqual(m.setSceneQuality(payload()), {...payload(), skySolidColor: null});
  assert.deepEqual(m.setSceneQuality({tier: 'bogus'}), {...payload(), skySolidColor: null});
  assert.equal(m.setSceneQuality(payload({tier: 'high'})).tier, 'high');
  assert.equal(m.sceneQuality().tier, 'high');
  m.sceneQuality().tier = 'low';
  assert.equal(m.sceneQuality().tier, 'high', 'the getter returns a copy');
  assert.equal(m.setSceneQuality(null), null);
  assert.equal(m.sceneQuality(), null);
  assert.equal(host.sent.length, 3);
  assert.equal(JSON.parse(host.sent[0]).tier, 'ultra');
  assert.equal(JSON.parse(host.sent[1]).tier, 'high');
  assert.equal(host.sent[2], '');
  assert.deepEqual(host.warnings, []);
});
