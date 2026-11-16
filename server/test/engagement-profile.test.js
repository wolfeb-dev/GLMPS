import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';
import {
  validateEngagementProfile, loadEngagementProfile, loadEngagementProfileFromFile, isAllowlistedSource,
} from '../lib/evaluation/engagement-profile.js';

const dir = path.dirname(url.fileURLToPath(import.meta.url));

const validProfile = {
  id: 'test-instance',
  objective: { measurableId: 'north-star' },
  sourceAllowlist: [{ name: 'blog-a', kind: 'url', ref: 'https://example.com/feed' }],
  verifier: { kind: 'replay-set', config: {} },
};

test('a fully-formed profile validates with no errors', () => {
  const r = validateEngagementProfile(validProfile);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('missing id, objective, sourceAllowlist, verifier are all reported', () => {
  const r = validateEngagementProfile({});
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /id must be/.test(e)));
  assert.ok(r.errors.some(e => /objective\.measurableId/.test(e)));
  assert.ok(r.errors.some(e => /sourceAllowlist must be/.test(e)));
  assert.ok(r.errors.some(e => /verifier\.kind/.test(e)));
});

test('an allowlist entry with a bad kind is reported', () => {
  const bad = { ...validProfile, sourceAllowlist: [{ name: 'x', kind: 'wat', ref: 'y' }] };
  const r = validateEngagementProfile(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /kind must be one of/.test(e)));
});

test('verifier.kind accepts replay-set, rejects anything else', () => {
  assert.equal(validateEngagementProfile({ ...validProfile, verifier: { kind: 'replay-set', config: {} } }).ok, true);
  assert.equal(validateEngagementProfile({ ...validProfile, verifier: { kind: 'backtest-skeptic', config: {} } }).ok, false);
  assert.equal(validateEngagementProfile({ ...validProfile, verifier: { kind: 'other', config: {} } }).ok, false);
});

test('loadEngagementProfile returns { ok:true, profile } for a valid profile', () => {
  const r = loadEngagementProfile(validProfile);
  assert.equal(r.ok, true);
  assert.equal(r.profile.id, 'test-instance');
});

test('loadEngagementProfile returns { ok:false, errors } for an invalid profile', () => {
  const r = loadEngagementProfile({ id: '' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test('loadEngagementProfileFromFile: missing file fails cleanly, no throw', () => {
  const r = loadEngagementProfileFromFile(path.join(dir, 'does-not-exist.json'));
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes('does-not-exist.json'));
});

test('loadEngagementProfileFromFile: the real GLMPS instance profile validates', () => {
  const file = path.join(dir, '..', 'lib', 'evaluation', 'engagement-profiles', 'glmps.json');
  const r = loadEngagementProfileFromFile(file);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.profile.id, 'glmps');
});

test('isAllowlistedSource: true only for a ref literally on the allowlist', () => {
  assert.equal(isAllowlistedSource(validProfile, 'https://example.com/feed'), true);
  assert.equal(isAllowlistedSource(validProfile, 'https://not-allowlisted.example/x'), false);
  assert.equal(isAllowlistedSource(null, 'https://example.com/feed'), false);
});
