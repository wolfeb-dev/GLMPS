// server/test/web-timezone-picker.test.js
// The Settings modal's timezone picker (card glmps-2-0-runtime-66): the
// browser copy of the zone, the save toast, and that the picker is wired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTz, saveTz, timeZoneToast, TZ_KEY } from '../../web/shared/settings.js';

const memStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('the browser copy of the zone round-trips and ignores junk', () => {
  const s = memStore();
  assert.equal(readTz(s), null);
  saveTz('America/Los_Angeles', s);
  assert.equal(readTz(s), 'America/Los_Angeles');
  saveTz('Mars/Olympus', s);
  assert.equal(readTz(s), 'America/Los_Angeles', 'an unknown zone is never stored');
  s.setItem(TZ_KEY, 'garbage');
  assert.equal(readTz(s), null);
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readTz(throwing), null);
  assert.doesNotThrow(() => saveTz('UTC', throwing));
});

test('the save toast names the zone, or the reason it was refused', () => {
  assert.equal(timeZoneToast(200, { timeZone: 'America/Los_Angeles', label: 'PT' }), 'Times now shown in America/Los_Angeles (PT)');
  assert.equal(timeZoneToast(400, { error: 'unknown timezone: X' }), 'Timezone not saved: unknown timezone: X');
  assert.equal(timeZoneToast(500, {}), 'Timezone not saved: server answered 500');
});

test('the Appearance section carries a timezone select that saves through the API', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web/shared/settings.js'), 'utf8');
  assert.match(src, /className = 'set-tz-select'/);
  assert.match(src, /listTimeZones\(\)/);
  assert.match(src, /await setTimeZone\(sel\.value\)/);
});
