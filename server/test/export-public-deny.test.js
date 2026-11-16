// server/test/export-public-deny.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_DENY, isPublicDenied } from '../../scripts/public-deny.mjs';

test('the public mirror DENY list excludes the private add-on packs', () => {
  assert.ok(PUBLIC_DENY.includes('addons'));
  assert.equal(isPublicDenied('addons/trading/agent.md'), true);
});

test('isPublicDenied matches whole path segments in either slash form', () => {
  assert.equal(isPublicDenied('docs\\superpowers\\plans\\p.md'), true);
  assert.equal(isPublicDenied('docs/superpowers'), true);
  assert.equal(isPublicDenied('docs/superpowers-public/x.md'), false);
  assert.equal(isPublicDenied('server/server.js'), false);
  assert.equal(isPublicDenied(''), false);
});
