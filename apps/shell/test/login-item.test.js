// apps/shell/test/login-item.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldReconcileLoginItem } from '../src/lib/login-item.js';

test('never reconciles when launch-at-login is not available (dev/smoke, or non-Windows)', () => {
  assert.equal(shouldReconcileLoginItem({ canLaunchAtLogin: false, desired: true, current: false }), false);
  assert.equal(shouldReconcileLoginItem({ canLaunchAtLogin: false, desired: false, current: true }), false);
});

test('reconciles when the Run-key does not yet match the desired setting', () => {
  assert.equal(shouldReconcileLoginItem({ canLaunchAtLogin: true, desired: true, current: false }), true);
  assert.equal(shouldReconcileLoginItem({ canLaunchAtLogin: true, desired: false, current: true }), true);
});

test('does nothing once the Run-key already matches the desired setting', () => {
  assert.equal(shouldReconcileLoginItem({ canLaunchAtLogin: true, desired: true, current: true }), false);
  assert.equal(shouldReconcileLoginItem({ canLaunchAtLogin: true, desired: false, current: false }), false);
});

test('a missing/undefined current reads as false, not a crash', () => {
  assert.equal(shouldReconcileLoginItem({ canLaunchAtLogin: true, desired: true, current: undefined }), true);
  assert.equal(shouldReconcileLoginItem({ canLaunchAtLogin: true, desired: false, current: undefined }), false);
});
