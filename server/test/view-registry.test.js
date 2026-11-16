import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerView, getView, listViews, clearViews } from '../../web/shared/view-registry.js';

test.beforeEach(() => clearViews());

test('registers and retrieves a view', () => {
  registerView('memory', { label: 'Evolution', suffix: 'evaluation', load: async () => ({ renderMemory: () => {} }) });
  const v = getView('memory');
  assert.equal(v.label, 'Evolution');
  assert.equal(typeof v.load, 'function');
});

test('unknown view -> null', () => {
  assert.equal(getView('nope'), null);
});

test('listViews returns all registered views', () => {
  registerView('a', { label: 'X', suffix: 'x', load: async () => ({}) });
  registerView('b', { label: 'Y', suffix: 'y', load: async () => ({}) });
  assert.equal(listViews().length, 2);
});

test('registerView requires a name and a load() function', () => {
  assert.throws(() => registerView('', { load: async () => ({}) }));
  assert.throws(() => registerView('x', {}));
});
