import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldOpenSetup } from '../src/lib/first-run.js';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/lib/settings.js';

test('a fresh install opens the setup wizard by itself', () => {
  assert.equal(shouldOpenSetup({ settings: { ...DEFAULT_SETTINGS }, smoke: false }), true);
});

test('a finished or dismissed wizard stays closed', () => {
  assert.equal(shouldOpenSetup({ settings: { ...DEFAULT_SETTINGS, setupCompleted: true } }), false);
  assert.equal(shouldOpenSetup({ settings: { ...DEFAULT_SETTINGS, setupWizardDismissed: true } }), false);
});

test('a smoke run never opens it', () => {
  assert.equal(shouldOpenSetup({ settings: { ...DEFAULT_SETTINGS }, smoke: true }), false);
});

test('fails open: settings that cannot be read open nothing', () => {
  assert.equal(shouldOpenSetup({ settings: null }), false);
  assert.equal(shouldOpenSetup({}), false);
});

test('setupCompleted defaults to false and only a real boolean survives normalizing', () => {
  assert.equal(DEFAULT_SETTINGS.setupCompleted, false);
  assert.equal(normalizeSettings({ version: 2, setupCompleted: true }).setupCompleted, true);
  assert.equal(normalizeSettings({ version: 2, setupCompleted: 'yes' }).setupCompleted, false);
  assert.equal(normalizeSettings({}).setupCompleted, false);
});
