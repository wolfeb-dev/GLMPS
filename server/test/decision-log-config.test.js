// server/test/decision-log-config.test.js
// glmps-143 Task 2. ~/.claude/settings.json has NO version history anywhere
// (~/.claude is not a git repo), which is the surface that caused the original
// archaeology. It can also hold env values, so only key names, counts, and a
// hash are ever recorded. The secret-safety test below enforces that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, diffSettings } from '../lib/observability/decision-log-config.js';

const settings = (over = {}) => ({
  hooks: {
    Stop: [{ hooks: [{ command: '"C:\\Program Files\\nodejs\\node.exe" "D:\\glmps\\hooks\\done-gate.js"' }] }],
    PreToolUse: [{ hooks: [{ command: 'node C:\\Users\\op\\.claude\\hooks\\no-emdash.js' }] }],
  },
  permissions: { deny: ['Read(**/.env)'], allow: ['Bash(git status)'] },
  env: { GLMPS_STATE_DIR: 'D:\\state' },
  ...over,
});

test('summarize: hooks are keyed by basename, so an absolute-path move is not a change', () => {
  const a = summarize(settings());
  const b = summarize(settings({
    hooks: {
      Stop: [{ hooks: [{ command: 'node /elsewhere/done-gate.js' }] }],
      PreToolUse: [{ hooks: [{ command: 'node /elsewhere/no-emdash.js' }] }],
    },
  }));
  assert.deepEqual(a.sections['hooks.Stop'], b.sections['hooks.Stop']);
});

test('diffSettings: a hook added under Stop is reported', () => {
  const prev = summarize(settings());
  const next = summarize(settings({
    hooks: {
      Stop: [{ hooks: [{ command: 'node done-gate.js' }, { command: 'node capability-feed.js' }] }],
      PreToolUse: [{ hooks: [{ command: 'node no-emdash.js' }] }],
    },
  }));
  const d = diffSettings(prev, next);
  assert.equal(d.changed, true);
  assert.deepEqual(d.sections['hooks.Stop'].added, ['capability-feed.js']);
  assert.deepEqual(d.sections['hooks.Stop'].removed, []);
});

test('diffSettings: a hook removed is reported', () => {
  const prev = summarize(settings());
  const next = summarize(settings({ hooks: { Stop: [{ hooks: [] }], PreToolUse: [{ hooks: [{ command: 'node no-emdash.js' }] }] } }));
  const d = diffSettings(prev, next);
  assert.deepEqual(d.sections['hooks.Stop'].removed, ['done-gate.js']);
});

test('diffSettings: a changed permissions.deny entry is counted', () => {
  const prev = summarize(settings());
  const next = summarize(settings({ permissions: { deny: ['Read(**/secrets/**)'], allow: ['Bash(git status)'] } }));
  const d = diffSettings(prev, next);
  assert.equal(d.changed, true);
  assert.equal(d.sections['permissions.deny'].added.length, 1);
  assert.equal(d.sections['permissions.deny'].removed.length, 1);
});

test('a scalar permissions field (defaultMode) is tracked, not flattened to empty', () => {
  // Caught against the real settings.json: permissions.defaultMode is a bare
  // string, and an Array.isArray guard alone made changes to it invisible.
  const prev = summarize(settings({ permissions: { defaultMode: 'acceptEdits' } }));
  const next = summarize(settings({ permissions: { defaultMode: 'bypassPermissions' } }));
  assert.deepEqual(prev.sections['permissions.defaultMode'], ['acceptEdits']);
  const d = diffSettings(prev, next);
  assert.equal(d.changed, true);
  assert.deepEqual(d.sections['permissions.defaultMode'].added, ['bypassPermissions']);
  assert.deepEqual(d.sections['permissions.defaultMode'].removed, ['acceptEdits']);
});

test('diffSettings: identical input reports changed:false with no sections', () => {
  const s = summarize(settings());
  const d = diffSettings(s, s);
  assert.equal(d.changed, false);
  assert.deepEqual(d.sections, {});
});

test('diffSettings: a null prev (first run) reports additions without throwing', () => {
  const d = diffSettings(null, summarize(settings()));
  assert.equal(d.changed, true);
  assert.ok(Object.keys(d.sections).length > 0);
});

test('SECRET SAFETY: no raw env value ever reaches the summary or the diff', () => {
  const SECRET = 'sk-live-abc123-DO-NOT-LEAK';
  const withSecret = settings({ env: { GLMPS_STATE_DIR: 'D:\\state', ANTHROPIC_API_KEY: SECRET } });

  const sum = summarize(withSecret);
  const dif = diffSettings(summarize(settings()), sum);

  assert.ok(!JSON.stringify(sum).includes(SECRET), 'summarize must not carry the value');
  assert.ok(!JSON.stringify(dif).includes(SECRET), 'diffSettings must not carry the value');
  // The KEY name is fine and is what makes the entry useful.
  assert.ok(JSON.stringify(dif).includes('ANTHROPIC_API_KEY'), 'the key name is the signal we do keep');
});

test('summarize: sha256 is stable against formatting-only changes', () => {
  const a = summarize(settings());
  const b = summarize(JSON.parse(JSON.stringify(settings())));
  assert.equal(a.sha256, b.sha256);
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
});

test('summarize: a malformed settings object yields an empty summary, never throws', () => {
  assert.doesNotThrow(() => summarize(null));
  assert.doesNotThrow(() => summarize({ hooks: 'not-an-object' }));
  assert.equal(typeof summarize(null).sha256, 'string');
});
