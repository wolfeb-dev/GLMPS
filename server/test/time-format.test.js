// server/test/time-format.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidTimeZone, systemTimeZone, formatClock, setDisplayTimeZone, displayTimeZone, zoneName, formatTime, formatDate, listTimeZones,
} from '../../web/shared/time-format.js';

const TS = Date.parse('2026-10-26T23:22:00Z');
const NOW = Date.parse('2026-10-27T01:00:00Z');

test('formats a time in the given zone with the zone named', () => {
  assert.equal(formatTime(TS, { tz: 'America/Los_Angeles', date: false }), '4:22 PM PT');
  assert.equal(formatTime(TS, { tz: 'America/New_York', date: false }), '7:22 PM ET');
});

test('the default form carries the date in that zone, and the year only when it is not this year', () => {
  assert.equal(formatTime(TS, { tz: 'America/Los_Angeles', now: NOW }), 'Oct 26, 4:22 PM PT');
  // 23:22Z is already the 27th in Berlin.
  assert.equal(formatTime(TS, { tz: 'Europe/Berlin', now: NOW }), 'Oct 27, 12:22 AM GMT+1');
  assert.equal(formatTime(Date.parse('2025-03-01T20:00:00Z'), { tz: 'America/Los_Angeles', now: NOW }), 'Mar 1, 2025, 12:00 PM PT');
});

test('output is plain ASCII spaces (ICU puts a narrow no-break space before AM/PM)', () => {
  assert.match(formatTime(TS, { tz: 'America/Los_Angeles' }), /^[\x20-\x7e]+$/);
});

test('a zone with no short generic name falls back to its offset, and UTC is named UTC', () => {
  assert.equal(zoneName('Asia/Kolkata', TS), 'GMT+5:30');
  assert.equal(zoneName('UTC', TS), 'UTC');
  assert.equal(zoneName('Etc/UTC', TS), 'UTC');
  assert.equal(zoneName('America/Los_Angeles', TS), 'PT');
});

test('accepts ISO strings and Date objects; invalid input renders empty, never "Invalid Date"', () => {
  assert.equal(formatTime('2026-10-26T23:22:00Z', { tz: 'America/Los_Angeles', date: false }), '4:22 PM PT');
  assert.equal(formatTime(new Date(TS), { tz: 'America/Los_Angeles', date: false }), '4:22 PM PT');
  assert.equal(formatTime(null), '');
  assert.equal(formatTime('nope'), '');
  assert.equal(formatDate(undefined), '');
});

test('formatDate gives the calendar day in the zone', () => {
  assert.equal(formatDate(TS, { tz: 'America/Los_Angeles', now: NOW }), 'Oct 26');
  assert.equal(formatDate(TS, { tz: 'Asia/Tokyo', now: NOW }), 'Oct 27');
});

test('the display zone is module state: set once, used when no tz is passed; an unknown zone is refused', () => {
  const before = displayTimeZone();
  try {
    assert.equal(setDisplayTimeZone('America/Chicago'), 'America/Chicago');
    assert.equal(formatTime(TS, { date: false }), '6:22 PM CT');
    assert.equal(setDisplayTimeZone('Mars/Olympus'), 'America/Chicago');
    assert.equal(displayTimeZone(), 'America/Chicago');
  } finally { setDisplayTimeZone(before); }
});

test('zone validation and listing', () => {
  assert.equal(isValidTimeZone('America/Los_Angeles'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone(42), false);
  assert.ok(isValidTimeZone(systemTimeZone()));
  const zones = listTimeZones();
  assert.ok(zones.includes('America/Los_Angeles'));
  assert.ok(zones.includes('UTC'));
});

test('formatClock is the dense 24h feed column, in the zone, with seconds', () => {
  assert.equal(formatClock(TS + 5000, { tz: 'America/Los_Angeles' }), '16:22:05');
  assert.equal(formatClock(Date.parse('2026-10-26T07:03:09Z'), { tz: 'America/Los_Angeles' }), '00:03:09');
  assert.equal(formatClock('bad'), '');
});
