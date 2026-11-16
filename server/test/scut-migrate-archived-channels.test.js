// server/test/scut-migrate-archived-channels.test.js
// Tests for scripts/scut-migrate-archived-channels.mjs's two safety guards
// (HARD SEPARATION, Task 12): the real migration against the real Slack
// workspace is Task 13, held for the operator's cutover. This file never
// calls the script in a way that could reach real Slack or a real token:
// - `run`/`isTestProcess` are imported as pure parts (the module's top-level
//   `main()` only fires when the file is executed directly - see the
//   `import.meta.url` guard at the bottom of the script - so importing it
//   here never runs anything for real).
// - The two spawn tests launch the real script as a child process with a
//   clean env: HOME/USERPROFILE/GLMPS_CLAUDE_DIR/GLMPS_STATE_DIR redirected to
//   fresh temp dirs and no SCUT token anywhere, so even the "no token"
//   path's real run never touches the operator's state or credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, isTestProcess } from '../../scripts/scut-migrate-archived-channels.mjs';
import { bindTicketChannel, ticketChannelsPath, channelForTicket } from '../lib/scut/ticket-channels.js';
import * as backlogStore from '../lib/orchestration/backlog-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'scut-migrate-archived-channels.mjs');

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function fakeWeb() {
  const calls = [];
  return {
    calls,
    web: {
      call: async (method, params) => { calls.push([method, params]); return { channel: { id: params.channel, is_archived: false, is_member: true } }; },
      chatPostMessage: async (m) => { calls.push(['chat.postMessage', m]); return {}; },
      conversationsRename: async (a) => { calls.push(['conversations.rename', a]); return {}; },
      conversationsMembers: async () => ({ members: [], response_metadata: { next_cursor: '' } }),
      conversationsKick: async (a) => { calls.push(['conversations.kick', a]); return {}; },
    },
  };
}

// Phase C final review, M8: isTestProcess is now imported (re-exported) from
// test-write-guard.js rather than duplicated, so it also honors
// processEnv (the REAL process.env, independent of whatever `env` object a
// caller injects) - matching testRealGitWriteRefused's own four-signal
// contract. processEnv is pinned to {} below so this stays a pure check of
// the injected env/argv, not an accidental read of this actual test
// process's own ambient GLMPS_TEST=1 (set by test.env for every npm test run).
test('isTestProcess reads the same signals as test-write-guard.js: NODE_TEST_CONTEXT, GLMPS_TEST, and a *.test.js argv[1]', () => {
  assert.equal(isTestProcess({ env: { NODE_TEST_CONTEXT: '1' }, processEnv: {}, argv: ['node', 'x.mjs'] }), true);
  assert.equal(isTestProcess({ env: { GLMPS_TEST: '1' }, processEnv: {}, argv: ['node', 'x.mjs'] }), true);
  assert.equal(isTestProcess({ env: {}, processEnv: {}, argv: ['node', 'x.test.js'] }), true);
  assert.equal(isTestProcess({ env: {}, processEnv: {}, argv: ['node', 'scripts/scut-migrate-archived-channels.mjs'] }), false);
});

test('run() refuses inside a test process when no fake web is injected, naming the reason', async () => {
  // No env/argv override: this test file's own process IS a test process
  // (node --test's NODE_TEST_CONTEXT and/or this file's own *.test.js argv),
  // so the guard must refuse before touching any path or credential.
  await assert.rejects(() => run(), (err) => {
    assert.equal(err.code, 'test_process_refused');
    assert.match(err.message, /refus/i);
    return true;
  });
});

test('run() proceeds with an injected fake web even inside a test process, wiring paths through the injected env', async () => {
  const stateDir = tmp('mc-migscript-state-');
  const env = { GLMPS_STATE_DIR: stateDir };
  const file = ticketChannelsPath(stateDir, env);
  bindTicketChannel({ channelId: 'C1', name: 'a-1-x', ticketId: 'a-1' }, { file });
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.channels.C1.archivedTs = 10;
  fs.writeFileSync(file, JSON.stringify(stored));
  backlogStore.save(stateDir, { ...backlogStore.emptyState(), items: [{ id: 'a-1', state: 'done' }] });

  const { web } = fakeWeb();
  const report = await run({ env, web });
  assert.deepEqual({ total: report.total, unarchived: report.unarchived, hidden: report.hidden, failed: report.failed }, { total: 1, unarchived: 0, hidden: 1, failed: 0 });
  assert.equal(typeof channelForTicket('a-1', { file }).hiddenTs, 'number');
});

// Every spawned child below gets a CLEAN env: process.env minus the test
// markers that would otherwise trip isTestProcess inside the child, plus
// HOME/USERPROFILE/GLMPS_CLAUDE_DIR/GLMPS_STATE_DIR redirected to fresh temp dirs
// (rule: a child process must never resolve to the operator's real state).
function cleanEnv(extra = {}) {
  const base = { ...process.env };
  delete base.NODE_TEST_CONTEXT;
  delete base.GLMPS_TEST;
  delete base.SCUT_BOT_TOKEN;
  delete base.SCUT_APP_TOKEN;
  delete base.SCUT_SIGNING_SECRET;
  delete base.SCUT_CREDS_FILE;
  return {
    ...base,
    HOME: tmp('mc-migscript-home-'),
    USERPROFILE: tmp('mc-migscript-userprofile-'),
    GLMPS_CLAUDE_DIR: tmp('mc-migscript-claude-'),
    GLMPS_STATE_DIR: tmp('mc-migscript-mcstate-'),
    ...extra,
  };
}

test('the real script refuses with a named error when no token is configured, for a real (non-dry-run) attempt (spawned, no Slack reached)', () => {
  const res = spawnSync(process.execPath, [SCRIPT], { env: cleanEnv(), encoding: 'utf-8' });
  assert.equal(res.status, 1, `expected exit 1.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /no_token_configured/);
});

test('the real script refuses inside a test process even when spawned directly, before the token check', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--dry-run'], { env: cleanEnv({ NODE_TEST_CONTEXT: '1' }), encoding: 'utf-8' });
  assert.equal(res.status, 1, `expected exit 1.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /test_process_refused/);
});

// Fix round 1, Minor (fold): --dry-run must not require a bot token, so
// counts can be previewed before credentials exist.
test('the real script previews counts with --dry-run even when no token is configured, and never reaches Slack (Minor: dry-run without a token)', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--dry-run'], { env: cleanEnv(), encoding: 'utf-8' });
  assert.equal(res.status, 0, `expected exit 0.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(report, { total: 0, unarchived: 0, hidden: 0, failed: 0, failures: [] });
});

// the script must read the SAME CLOSED_STATES Set backlogStore
// exports, not a hardcoded duplicate - a diverged set would permanently skip a
// closed ticket's channel. Proven by mutating the shared Set object itself (not
// just adding a state with the same string value elsewhere): a duplicated LOCAL
// set would never see this mutation, so this only passes when the wiring reads
// the live backlogStore.CLOSED_STATES export.
test('isClosed reads backlogStore.CLOSED_STATES live, not a duplicated local set (I2)', async () => {
  const SYNTHETIC_CLOSED_STATE = 'synthetic-closed-for-i2-test';
  backlogStore.CLOSED_STATES.add(SYNTHETIC_CLOSED_STATE);
  try {
    const stateDir = tmp('mc-migscript-i2-');
    const env = { GLMPS_STATE_DIR: stateDir };
    const file = ticketChannelsPath(stateDir, env);
    bindTicketChannel({ channelId: 'C1', name: 'a-1-x', ticketId: 'a-1' }, { file });
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.channels.C1.archivedTs = 10;
    fs.writeFileSync(file, JSON.stringify(stored));
    backlogStore.save(stateDir, { ...backlogStore.emptyState(), items: [{ id: 'a-1', state: SYNTHETIC_CLOSED_STATE }] });

    const { web } = fakeWeb();
    const report = await run({ env, web });
    assert.equal(report.hidden, 1, 'a state only present in the shared CLOSED_STATES set must be treated as closed');
  } finally {
    backlogStore.CLOSED_STATES.delete(SYNTHETIC_CLOSED_STATE);
  }
});
