// server/test/remote-bind-policy.test.js
// Card glmps-2-0-152 (spec 2026-11-10-glmps-2-0-171): a non-loopback bind must
// be a private address literal with TLS configured. Public, wildcard, hostname,
// link-local and the 100.64.0.0/10 shared range are refused with a named reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { remoteBindPolicy, isPrivateAddress } from '../lib/governance/access-guard.js';
import { startServer } from '../server.js';

test('loopback binds are always allowed, with or without TLS', () => {
  for (const bindHost of [undefined, '127.0.0.1', 'localhost', '::1']) {
    assert.deepEqual(remoteBindPolicy({ bindHost }), { allow: true, private: false }, String(bindHost));
  }
});

test('isPrivateAddress: RFC1918 and IPv6 ULA literals only', () => {
  for (const h of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.1', '192.168.1.5', 'fd12:3456:789a::5', 'fc00::1', '[fd00::7]', 'FD00::8']) {
    assert.equal(isPrivateAddress(h), true, h);
  }
  for (const h of ['172.15.0.1', '172.32.0.1', '192.169.0.1', '100.64.0.1', '100.101.102.103', '169.254.1.1', '8.8.8.8', '0.0.0.0', '::', 'fe80::1', '2001:db8::1', '::ffff:192.168.1.5', 'fd7a:115c:a1e0::1x', '10.0.0.256', 'glmps.internal', '', undefined]) {
    assert.equal(isPrivateAddress(h), false, String(h));
  }
});

test('a private address with TLS configured is allowed', () => {
  for (const bindHost of ['192.168.1.50', '10.0.0.4', '172.20.1.1', 'fd12:3456:789a::5']) {
    assert.deepEqual(remoteBindPolicy({ bindHost, tls: true }), { allow: true, private: true }, bindHost);
  }
});

test('every other bind is refused with a named reason', () => {
  const cases = [
    ['0.0.0.0', /wildcard/], ['::', /wildcard/], ['[::]', /wildcard/],
    ['glmps.local', /hostname/], ['glmps.internal', /hostname/], ['my-pc', /hostname/],
    ['8.8.8.8', /public/], ['2001:db8::1', /public/], ['203.0.113.9', /public/],
    ['169.254.10.1', /link-local/], ['fe80::1', /link-local/],
    ['100.64.0.1', /shared range/], ['100.101.102.103', /shared range/],
    ['127.0.0.2', /loopback-alias/], ['127.1.2.3', /loopback-alias/],
  ];
  for (const [bindHost, why] of cases) {
    for (const tls of [true, false]) {
      const r = remoteBindPolicy({ bindHost, tls });
      assert.equal(r.allow, false, `${bindHost} tls=${tls}`);
      assert.match(r.reason, /non-local bind refused/, bindHost);
      assert.match(r.reason, why, bindHost);
    }
  }
});

test('a private address without TLS is refused: the token never crosses the network in cleartext', () => {
  const r = remoteBindPolicy({ bindHost: '192.168.1.50', tls: false });
  assert.equal(r.allow, false);
  assert.match(r.reason, /no TLS configuration/);
  assert.equal(remoteBindPolicy({ bindHost: '192.168.1.50', acknowledged: true }).allow, false, 'the old plaintext acknowledgement no longer opens anything');
});

function mkEnv(config) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bind-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  const configFile = path.join(tmp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  const env = { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_STATE_DIR: path.join(tmp, 'state'), GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_UNMERGED_SCAN: 'off', GLMPS_ACCESS_TOKEN: 'secret' };
  return { tmp, env, configFile };
}

test('startServer refuses public, wildcard, hostname and untls private binds before binding anything', async () => {
  for (const [config, why] of [
    [{ host: '0.0.0.0', tls: { source: 'home' } }, /wildcard/],
    [{ host: '8.8.8.8', tls: { source: 'home' } }, /public/],
    [{ host: 'glmps.internal', tls: { source: 'home' } }, /hostname/],
    [{ host: '100.101.102.103', remotePlaintextAcknowledged: true }, /shared range/],
    [{ host: '192.168.1.50' }, /no TLS configuration/],
  ]) {
    const { tmp, env, configFile } = mkEnv(config);
    try {
      await assert.rejects(startServer({ port: 0, pollMs: 1000, env, configFile }), why, JSON.stringify(config));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
});
