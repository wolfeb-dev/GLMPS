// server/test/project-roots.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProjectRootCandidate } from '../lib/project-roots.js';

const antigravityDirs = [
  'C:/Users/op/.gemini/antigravity-ide',
  'C:/Users/op/.gemini/antigravity-cli',
];
const claudeDir = 'C:/Users/op/.claude';

test('rejects a cwd under an antigravity data dir (agy-cli brain/<uuid> scratch repo)', () => {
  const cwd = 'C:/Users/op/.gemini/antigravity-cli/brain/0115959d-9e75-46da-85d0-b9d0f007ae26';
  assert.equal(isProjectRootCandidate(cwd, { antigravityDirs, claudeDir }), false);
});

test('rejects a cwd under the antigravity-ide data dir too', () => {
  const cwd = 'C:/Users/op/.gemini/antigravity-ide/brain/13e71e35-333f-483b-828e-e62f3542a7f2';
  assert.equal(isProjectRootCandidate(cwd, { antigravityDirs, claudeDir }), false);
});

test('rejects a cwd under the claude data dir', () => {
  const cwd = 'C:/Users/op/.claude/projects/D--glmps';
  assert.equal(isProjectRootCandidate(cwd, { antigravityDirs, claudeDir }), false);
});

test('rejects a bare UUID basename cwd regardless of location', () => {
  const cwd = 'D:/some/other/place/0115959d-9e75-46da-85d0-b9d0f007ae26';
  assert.equal(isProjectRootCandidate(cwd, { antigravityDirs, claudeDir }), false);
});

test('accepts a real project root outside the excluded dirs', () => {
  assert.equal(isProjectRootCandidate('D:/glmps', { antigravityDirs, claudeDir }), true);
  assert.equal(isProjectRootCandidate('D:/Harbor-App', { antigravityDirs, claudeDir }), true);
});

test('accepts a project whose name merely contains uuid-like segments', () => {
  // basename must be the WHOLE uuid, not just contain hex/dashes
  assert.equal(isProjectRootCandidate('D:/repos/glmps-73-uuid-project-roots', { antigravityDirs, claudeDir }), true);
});

test('handles Windows-style backslash paths (platform-independent)', () => {
  const cwd = 'C:\\Users\\op\\.gemini\\antigravity-cli\\brain\\0115959d-9e75-46da-85d0-b9d0f007ae26';
  assert.equal(isProjectRootCandidate(cwd, { antigravityDirs, claudeDir }), false);
});

test('handles missing/empty cwd and missing options gracefully', () => {
  assert.equal(isProjectRootCandidate(null, {}), false);
  assert.equal(isProjectRootCandidate('', {}), false);
  assert.equal(isProjectRootCandidate('D:/glmps', {}), true);
});

test('exact match on an antigravity dir itself is rejected (not just nested)', () => {
  assert.equal(isProjectRootCandidate(antigravityDirs[0], { antigravityDirs, claudeDir }), false);
});
