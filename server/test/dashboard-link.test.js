// Scan 2026-10-15 F2: the plain-browser authorization link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { dashboardLink } from '../../scripts/dashboard-link.mjs';
import { localSessionValue } from '../lib/governance/access-guard.js';

test('dashboardLink carries the derived session in the fragment, never the raw key', () => {
  const key = 'c'.repeat(64);
  const seen = [];
  const r = dashboardLink({ stateDir: '/s', port: 8124, readFile: (f) => { seen.push(f); return `${key}\n`; } });
  assert.equal(r.link, `http://127.0.0.1:8124/local-auth.html#${localSessionValue(key)}`);
  assert.ok(!r.link.includes(key));
  assert.equal(seen[0], path.join('/s', 'local-session-key'));
});

test('dashboardLink names a missing or malformed key instead of printing a link', () => {
  const missing = dashboardLink({ stateDir: '/s', port: 1, readFile: () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; } });
  assert.equal(missing.link, null);
  assert.match(missing.reason, /start the GLMPS server once/);
  assert.match(dashboardLink({ stateDir: '/s', port: 1, readFile: () => 'nope' }).reason, /malformed/);
});
