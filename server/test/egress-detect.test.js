// server/test/egress-detect.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectEgress, isSecretPath } from '../lib/governance/egress-detect.js';

test('isSecretPath: credentials/keys/env/ssh dirs', () => {
  for (const p of ['/x/.env', '/x/.env.local', '/x/.credentials.json', '/x/id_rsa', '/x/server.pem',
                   '/x/priv.key', '/home/u/.ssh/config', '/home/u/.aws/credentials']) assert.equal(isSecretPath(p), true, p);
  for (const p of ['/x/app.js', '/x/README.md', '/x/env.example', '/x/notes.txt']) assert.equal(isSecretPath(p), false, p);
});

test('clean dev-zone file reads -> no findings', () => {
  const evs = [{ sessionId: 's1', kind: 'file-edit', path: '/repo/src/app.js' }];
  assert.deepEqual(detectEgress(evs, { projectRoot: '/repo' }), []);
});

test('secret file touched -> critical egress finding', () => {
  const evs = [{ sessionId: 's1', kind: 'tool', tool: 'Read', path: '/repo/.env' }];
  const found = detectEgress(evs, { projectRoot: '/repo' });
  assert.equal(found.length, 1);
  assert.equal(found[0].reason, 'secret');
  assert.equal(found[0].severity, 'critical');
  assert.equal(found[0].sessionId, 's1');
});

test('prod-zone file touched -> warn egress finding', () => {
  const evs = [{ sessionId: 's2', kind: 'file-edit', path: '/repo/prod/config.py' }];
  const found = detectEgress(evs, { projectRoot: '/repo' });
  assert.equal(found.length, 1);
  assert.equal(found[0].reason, 'prod-zone');
});

test('worst wins per session (secret over prod-zone); events without a path skipped', () => {
  const evs = [
    { sessionId: 's3', kind: 'file-edit', path: '/repo/prod/x.py' },
    { sessionId: 's3', kind: 'tool', path: '/repo/.ssh/id_rsa' },
    { sessionId: 's3', kind: 'command', label: 'ls' }, // no path
  ];
  const found = detectEgress(evs, { projectRoot: '/repo' });
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'critical');
});

// glmps-193: the per-event egress verdict is remembered across calls, keyed on
// the event and checked against its path and the project root.
test('a repeat egress scan follows a changed path and a changed project root', () => {
  const ev = { sessionId: 's9', kind: 'file-edit', path: '/repo/prod/config.py' };
  assert.equal(detectEgress([ev], { projectRoot: '/repo' })[0].reason, 'prod-zone');
  assert.equal(detectEgress([ev], { projectRoot: '/repo' })[0].reason, 'prod-zone');
  assert.deepEqual(detectEgress([ev], { projectRoot: '/other' }), detectEgress([{ ...ev }], { projectRoot: '/other' }));
  ev.path = '/repo/.env';
  assert.equal(detectEgress([ev], { projectRoot: '/repo' })[0].reason, 'secret');
  ev.path = '/repo/src/app.js';
  assert.deepEqual(detectEgress([ev], { projectRoot: '/repo' }), []);
});
