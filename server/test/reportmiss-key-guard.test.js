// server/test/reportmiss-key-guard.test.js
// Phase C final review, I4: about 21 reportMiss keys used to be of the form
// scut-release:<id>, scut-visibility:<id>, runner-session-record:<id>, etc.
// The registry (server/lib/adapters/health.js) never clears a miss key, so a
// per-id key accumulates forever instead of being a bounded, per-ROUTE
// health signal. The fix keys per route (scut-release, scut-visibility,
// runner-session-record, ...) and puts the id in the REASON text instead, the
// same convention guarded-spawn.js already uses (key: `spawn:<route>`,
// id/detail folded into `label`). This scans server.js and every file under
// server/lib/scut for a `reportMiss(` call whose first argument is an
// INLINE template literal containing a `${...}` substitution - the one shape
// that can embed a per-id suffix into the key itself. A plain string literal
// key, or a key built from a bare identifier/helper elsewhere (e.g.
// guardedSpawn's own already-correct `spawn:${route}`, which is a per-ROUTE
// name, never a per-id one, and is never the literal first argument of a
// reportMiss(...) call), is not flagged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeModuleFiles } from './helpers/server-source.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function findReportMissKeyViolations(text, file) {
  const violations = [];
  const re = /reportMiss\(\s*(`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g;
  let m;
  while ((m = re.exec(text))) {
    const key = m[1];
    if (key.startsWith('`') && /\$\{[^}]*\}/.test(key)) {
      const line = text.slice(0, m.index).split('\n').length;
      violations.push(`${file}:${line}: ${key}`);
    }
  }
  return violations;
}

function scannedFiles() {
  const scutDir = path.join(REPO_ROOT, 'server', 'lib', 'scut');
  const scutFiles = fs.readdirSync(scutDir).filter((f) => f.endsWith('.js')).map((f) => path.join('server', 'lib', 'scut', f));
  return [path.join('server', 'server.js'), ...routeModuleFiles(), ...scutFiles];
}

test('the scanner itself flags a template-literal reportMiss key with an interpolated id', () => {
  const violations = findReportMissKeyViolations("reportMiss(`scut-release:${ticketId}`, reason);", 'sample.js');
  assert.equal(violations.length, 1);
  assert.match(violations[0], /sample\.js:1/);
});

test('the scanner does not flag a plain string literal key, even with a colon in it', () => {
  const violations = findReportMissKeyViolations("reportMiss('scut-release', `${ticketId}: ${reason}`);", 'sample.js');
  assert.deepEqual(violations, []);
});

test('I4: no reportMiss key in server.js or server/lib/scut is a template literal with an interpolated id', () => {
  const violations = [];
  for (const rel of scannedFiles()) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    violations.push(...findReportMissKeyViolations(text, rel));
  }
  assert.deepEqual(violations, []);
});
