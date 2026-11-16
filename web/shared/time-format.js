// web/shared/time-format.js
// The one formatter for every time a person reads (card glmps-2-0-runtime-66):
// the dashboard imports it, and so does the server for Slack and alert prose,
// by relative path, so the two can never drift. Pure and DOM-free. Machine
// fields (ts in JSON, logs) stay ISO UTC and never come through here.

const UTC_NAMES = new Set(['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT', 'Etc/Universal', 'Etc/Zulu', 'Zulu', 'Universal']);

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export function systemTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(tz) ? tz : 'UTC';
  } catch { return 'UTC'; }
}

let current = systemTimeZone();

export function displayTimeZone() { return current; }

// Returns the zone now in force: an unknown name leaves the old one in place.
export function setDisplayTimeZone(tz) {
  if (isValidTimeZone(tz)) current = tz;
  return current;
}

export function listTimeZones() {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* older runtime */ }
  const out = new Set(zones);
  out.add('UTC');
  out.add(current);
  return [...out].sort();
}

function toDate(ts) {
  if (ts == null || ts === '') return null;
  const d = ts instanceof Date ? ts : new Date(typeof ts === 'string' && /^\d+$/.test(ts) ? Number(ts) : ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ICU puts U+202F before AM/PM and may use U+2009 in ranges; Slack and the
// house ASCII rule both want a plain space.
const ascii = (s) => s.replace(/[\u202f\u00a0\u2009]/g, ' ');

function part(d, tz, opts, type) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).formatToParts(d).find((x) => x.type === type);
  return p ? ascii(p.value) : '';
}

// "PT", "ET"; a zone whose generic name is a phrase ("Germany Time") falls
// back to its offset ("GMT+1") so the label stays short and unambiguous.
export function zoneName(tz = current, ts = Date.now()) {
  if (UTC_NAMES.has(tz)) return 'UTC';
  const d = toDate(ts) ?? new Date();
  try {
    const generic = part(d, tz, { timeZoneName: 'shortGeneric' }, 'timeZoneName');
    if (generic && !generic.includes(' ')) return generic;
    return part(d, tz, { timeZoneName: 'short' }, 'timeZoneName') || tz;
  } catch { return tz; }
}

function yearOf(d, tz) { return part(d, tz, { year: 'numeric' }, 'year'); }

function dateText(d, tz, now) {
  const md = ascii(new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(d));
  const n = toDate(now) ?? new Date();
  return yearOf(d, tz) === yearOf(n, tz) ? md : `${md}, ${yearOf(d, tz)}`;
}

/**
 * "4:22 PM PT" (date: false) or "Oct 26, 4:22 PM PT" (the default; the year
 * is added when it is not the current one). Invalid input gives ''.
 * @param {number|string|Date} ts
 * @param {{ tz?: string, date?: boolean, now?: number }} [opts]
 */
export function formatTime(ts, { tz = current, date = true, now = Date.now() } = {}) {
  const d = toDate(ts);
  if (!d) return '';
  const zone = isValidTimeZone(tz) ? tz : current;
  const time = ascii(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(d));
  const label = `${time} ${zoneName(zone, d)}`;
  return date ? `${dateText(d, zone, now)}, ${label}` : label;
}

/** "Oct 26" in the zone (the year added when not the current one). Invalid input gives ''. */
export function formatDate(ts, { tz = current, now = Date.now() } = {}) {
  const d = toDate(ts);
  if (!d) return '';
  return dateText(d, isValidTimeZone(tz) ? tz : current, now);
}

/** "16:22:05" in the zone, for dense feed columns whose header names the zone. Invalid input gives ''. */
export function formatClock(ts, { tz = current } = {}) {
  const d = toDate(ts);
  if (!d) return '';
  const zone = isValidTimeZone(tz) ? tz : current;
  const p = (type) => part(d, zone, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }, type);
  return `${p('hour')}:${p('minute')}:${p('second')}`;
}
