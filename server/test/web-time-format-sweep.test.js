// affected-tests: always
// server/test/web-time-format-sweep.test.js
// Every time the dashboard shows goes through web/shared/time-format.js
// (card glmps-2-0-runtime-66), never the browser locale or a hand-built UTC
// stamp, so the operator's chosen zone holds on every page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web');
const PATTERNS = [
  /\.toLocaleTimeString\(/,
  /new Date\([^)]*\)\.toLocaleString\(/,
  /\.toISOString\(\)\.replace\('T'/,
  /\.get(Hours|Minutes|Seconds)\(\)/,
];
// A calendar-day key ('2026-10-26') names a day, not an instant, so it has no zone.
const ALLOWED = new Set(['observability/analytics.js:toLocaleDateString']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js') && !e.name.endsWith('.min.js') && !p.includes(`${path.sep}huddle-assets${path.sep}`) && !p.includes(`${path.sep}wiki-assets${path.sep}`)) out.push(p);
  }
  return out;
}

test('no dashboard module formats a time with the browser locale or a hand-built UTC stamp', () => {
  const hits = [];
  for (const f of walk(WEB)) {
    const rel = path.relative(WEB, f).split(path.sep).join('/');
    if (rel === 'shared/time-format.js') continue;
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
      for (const re of PATTERNS) if (re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      if (/\.toLocaleDateString\(/.test(line) && !ALLOWED.has(`${rel}:toLocaleDateString`)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, [], 'use formatTime / formatDate / formatClock from web/shared/time-format.js');
});
