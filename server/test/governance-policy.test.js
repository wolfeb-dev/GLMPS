// server/test/governance-policy.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { resolveBaselinePath, readBaseline, writeBaseline } from '../lib/governance/baseline-store.js';
import { validatePolicyUpdate, extractManagedSection, wrapManaged, SUPPORTED_VENDORS } from '../lib/governance/vendor-writers.js';


function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gov-test-'));
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}


test('resolveBaselinePath: defaults to <root>/governance-baseline.json', () => {
  const result = resolveBaselinePath('/my/project', {});
  assert.equal(result, path.join('/my/project', 'governance-baseline.json'));
});

test('resolveBaselinePath: respects config.governanceBaseline (relative)', () => {
  const result = resolveBaselinePath('/my/project', { governanceBaseline: 'config/baseline.json' });
  assert.equal(result, path.resolve('/my/project', 'config/baseline.json'));
});

test('resolveBaselinePath: respects config.governanceBaseline (absolute)', () => {
  const abs = path.join(os.tmpdir(), 'custom-baseline.json');
  const result = resolveBaselinePath('/my/project', { governanceBaseline: abs });
  assert.equal(result, abs);
});


test('readBaseline: returns null for missing file', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'no-such-file.json');
  assert.equal(readBaseline(p), null);
  fs.rmdirSync(dir);
});

test('readBaseline: returns null for invalid JSON', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'bad.json');
  fs.writeFileSync(p, 'not json {{{');
  assert.equal(readBaseline(p), null);
  fs.rmSync(dir, { recursive: true });
});

test('writeBaseline / readBaseline: round-trip preserves object', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'baseline.json');
  const obj = {
    client: 'Acme Corp',
    policy: [{ id: 'a', text: 'Rule A', enabled: true }],
    targets: [{ vendor: 'claude-code', path: 'CLAUDE.md' }],
    requiredFiles: [],
    requiredHooks: [],
    coveredTools: ['claude-code'],
  };
  writeBaseline(p, obj);
  const read = readBaseline(p);
  assert.deepEqual(read, obj);
  fs.rmSync(dir, { recursive: true });
});

test('writeBaseline: writes pretty JSON with trailing newline', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'baseline.json');
  writeBaseline(p, { a: 1 });
  const raw = fs.readFileSync(p, 'utf-8');
  assert.ok(raw.endsWith('\n'), 'must end with newline');
  // Verify it is pretty-printed (contains newlines inside)
  assert.ok(raw.includes('\n  '), 'must be 2-space indented');
  fs.rmSync(dir, { recursive: true });
});

test('writeBaseline: creates parent directories if needed', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'nested', 'deep', 'baseline.json');
  writeBaseline(p, { ok: true });
  assert.equal(readBaseline(p)?.ok, true);
  fs.rmSync(dir, { recursive: true });
});


test('validatePolicyUpdate: accepts valid policy + targets', () => {
  const { ok, errors } = validatePolicyUpdate({
    policy: [{ id: 'no-shadow', text: 'No shadow AI', enabled: true, tags: ['shadow-ai'] }],
    targets: [{ vendor: 'claude-code', path: 'CLAUDE.md' }],
  }, { repoRoot: os.tmpdir() });
  assert.equal(ok, true, errors.join('; '));
});

test('validatePolicyUpdate: rejects policy item with empty text', () => {
  const { ok, errors } = validatePolicyUpdate({
    policy: [{ id: 'x', text: '   ', enabled: true }],
    targets: [],
  });
  assert.equal(ok, false);
  assert.ok(errors.some(e => /text/i.test(e)));
});

test('validatePolicyUpdate: rejects target with bad vendor', () => {
  const { ok, errors } = validatePolicyUpdate({
    policy: [],
    targets: [{ vendor: 'vscode', path: 'settings.json' }],
  });
  assert.equal(ok, false);
  assert.ok(errors.some(e => /vendor/i.test(e)));
});

test('validatePolicyUpdate: rejects path with ..', () => {
  const { ok, errors } = validatePolicyUpdate({
    policy: [],
    targets: [{ vendor: 'claude-code', path: '../parent/CLAUDE.md' }],
  });
  assert.equal(ok, false);
  assert.ok(errors.some(e => /\.\./i.test(e)));
});

test('validatePolicyUpdate: rejects absolute path', () => {
  const { ok, errors } = validatePolicyUpdate({
    policy: [],
    targets: [{ vendor: 'claude-code', path: '/etc/CLAUDE.md' }],
  });
  assert.equal(ok, false);
  assert.ok(errors.length > 0);
});

test('validatePolicyUpdate: rejects duplicate policy ids', () => {
  const { ok, errors } = validatePolicyUpdate({
    policy: [
      { id: 'dup', text: 'First', enabled: true },
      { id: 'dup', text: 'Second', enabled: true },
    ],
    targets: [],
  });
  assert.equal(ok, false);
  assert.ok(errors.some(e => /duplicate/i.test(e)));
});

test('validatePolicyUpdate: all supported vendors are valid', () => {
  for (const v of SUPPORTED_VENDORS) {
    const { ok, errors } = validatePolicyUpdate({
      policy: [],
      targets: [{ vendor: v.id, path: v.defaultPath }],
    }, { repoRoot: os.tmpdir() });
    assert.equal(ok, true, `vendor ${v.id} failed: ${errors.join('; ')}`);
  }
});
