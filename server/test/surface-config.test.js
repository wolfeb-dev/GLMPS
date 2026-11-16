import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { surfaceConfig } from '../lib/surface/config.js';
import { regionFromTimeZone, TZ_REGIONS } from '../lib/surface/tz-region.js';

const OPERATOR = { city: 'Testville', lon: -100, lat: 40 };

test('the operator entry in config wins over the timezone', () => {
  const out = surfaceConfig({ surface: { localGeo: OPERATOR } }, { timeZone: 'Europe/Berlin' });
  assert.deepEqual(out, { localGeo: { ...OPERATOR, precision: 'city', source: 'operator' }, localGeoError: null });
});

test('with no entry, the OS timezone gives an approximate region, never a city', () => {
  const { localGeo, localGeoError } = surfaceConfig({}, { timeZone: 'America/Los_Angeles' });
  assert.equal(localGeoError, null);
  assert.equal(localGeo.precision, 'approximate');
  assert.equal(localGeo.source, 'timezone');
  assert.equal(localGeo.timeZone, 'America/Los_Angeles');
  assert.equal(localGeo.city, 'US Pacific');
  assert.ok(Number.isInteger(localGeo.lon) && Number.isInteger(localGeo.lat), 'whole degrees only');
});

test('an unknown or location-free zone yields null, so the globe asks for the manual entry', () => {
  for (const tz of ['UTC', 'Etc/GMT+5', 'Nowhere/Atlantis', '', undefined, null]) {
    assert.deepEqual(surfaceConfig({}, { timeZone: tz }), { localGeo: null, localGeoError: null }, String(tz));
  }
  assert.deepEqual(surfaceConfig({}), { localGeo: null, localGeoError: null });
});

test('a malformed entry keeps its error and falls through to the timezone', () => {
  const out = surfaceConfig({ surface: { localGeo: { city: 'x', lon: 'west', lat: 40 } } }, { timeZone: 'Europe/London' });
  assert.match(out.localGeoError, /surface\.localGeo needs numeric/);
  assert.equal(out.localGeo.source, 'timezone');
  assert.equal(out.localGeo.city, 'UK and Ireland');
});

test('legacy aliases resolve like their canonical zone', () => {
  assert.deepEqual(regionFromTimeZone('US/Pacific'), regionFromTimeZone('America/Los_Angeles'));
  assert.deepEqual(regionFromTimeZone('Asia/Calcutta'), regionFromTimeZone('Asia/Kolkata'));
});

test('every table entry is a valid whole-degree point with a region name', () => {
  for (const [tz, r] of Object.entries(TZ_REGIONS)) {
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: tz }), `${tz} is a real IANA zone`);
    assert.ok(typeof r.region === 'string' && r.region.length > 0, tz);
    assert.ok(Number.isInteger(r.lon) && r.lon >= -180 && r.lon <= 180, tz);
    assert.ok(Number.isInteger(r.lat) && r.lat >= -90 && r.lat <= 90, tz);
  }
});

test('the resolver modules import nothing that can reach the network', () => {
  for (const f of ['../lib/surface/config.js', '../lib/surface/tz-region.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    for (const [, spec] of src.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)) assert.match(spec, /^\.\//, `${f} imports only sibling modules, not ${spec}`);
    assert.doesNotMatch(src, /\bfetch\(|\brequire\(|import\(/, `${f} has no fetch or dynamic load`);
  }
});
