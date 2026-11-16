// affected-tests: always
// server/test/cutover-deletions.test.js
// D24 applied to the dashboard: every 1.x surface the four lenses replace is
// gone, and nothing still imports it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.join(ROOT, 'web');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const webSources = () => walk(WEB).filter((f) => /\.(js|html|css)$/.test(f) && !f.includes(`${path.sep}vendor${path.sep}`) && !f.includes(`${path.sep}wiki-assets${path.sep}`) && !f.includes(`${path.sep}wiki${path.sep}`));

test('the replaced 1.x files are deleted', () => {
  // observability/wiki.(js|css) is deliberately NOT in this list: D-W owns
  // that module and /wiki/ still renders it (the brief's own Files section
  // says so verbatim: "NOT web/observability/wiki.js/wiki.css"), so it must
  // still exist, unlike dashboard.(js|css) and governance/*.
  for (const f of ['overview/dashboard.js', 'overview/dashboard.css']) {
    assert.equal(fs.existsSync(path.join(WEB, f)), false, `web/${f} still exists`);
  }
  assert.equal(fs.existsSync(path.join(WEB, 'governance')), false, 'web/governance/ still exists (D2)');
  for (const f of ['surface/declared/policy.js', 'surface/declared/policy-library.js', 'surface/declared/engagement.js', 'shared/roster.js']) {
    assert.ok(fs.existsSync(path.join(WEB, f)), `web/${f} missing`);
  }
});

test('nothing references the deleted files or the pillar nav', () => {
  // observability/wiki.(js|css) is deliberately NOT in this pattern: unlike
  // dashboard.js and governance/*, D-W owns that module and /wiki/ still
  // renders it (the brief's own Files section says so), so app.js's
  // `import('./observability/wiki.js')` is a live, correct reference, not a
  // dead one this task is supposed to catch.
  const bad = /overview\/dashboard\.(js|css)|governance\/(goals|policy|policy-library|engagement)\.|nav-pillar|pillar-banner|data-view=/;
  const hits = webSources().filter((f) => bad.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(hits, []);
});

test('the roster moved intact', async () => {
  const src = fs.readFileSync(path.join(WEB, 'shared', 'roster.js'), 'utf8');
  assert.match(src, /export function fillRoster\(/);
  assert.match(src, /export async function fillProjectNav\(/);
});
