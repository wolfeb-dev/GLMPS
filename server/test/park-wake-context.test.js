// PostToolUse classifier context for a GLMPS park-loop wake (card glmps-2-0-47).
// Settings-file hooks can only add unverified background context, never user
// intent, so this is context only: it says where the result came from, and it
// never repeats the note text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { parkWakeContext, CONTEXT_TEXT } from '../lib/governance/park-wake-context.js';

const hookScript = path.resolve(import.meta.dirname, '..', '..', 'hooks', 'park-wake-context.js');
const PARK_CMD = 'curl -s --max-time 580 -X POST http://127.0.0.1:8123/api/scut/park -d \'{"ticket":"mc-1"}\'';
const wake = (provenance) => JSON.stringify({ action: 'wake', note: 'write the spec {file}\n\n(from slack:U1, thread 1.1)', provenance });

test('operator wake from a park poll yields context that never contains the note', () => {
  const out = parkWakeContext({ tool_name: 'Bash', tool_input: { command: PARK_CMD }, tool_response: { stdout: `${wake('operator')}\n` } });
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.equal(out.hookSpecificOutput.classifierContext, CONTEXT_TEXT);
  assert.match(CONTEXT_TEXT, /park-loop reply relayed by the local GLMPS server from the operator's Slack thread/);
  assert.ok(CONTEXT_TEXT.length <= 2000);
  assert.doesNotMatch(JSON.stringify(out), /spec|U1/, 'untrusted note text is never copied into the context');
});

test('a non-operator wake gets no context', () => {
  assert.equal(parkWakeContext({ tool_name: 'Bash', tool_input: { command: PARK_CMD }, tool_response: { stdout: wake('external') } }), null);
  assert.equal(parkWakeContext({ tool_name: 'Bash', tool_input: { command: PARK_CMD }, tool_response: { stdout: JSON.stringify({ action: 'wake', note: 'old server, no provenance' }) } }), null);
});

test('wait, handoff and close replies get no context', () => {
  for (const reply of [{ action: 'wait' }, { action: 'handoff' }, { action: 'close', reason: 'ttl' }]) {
    assert.equal(parkWakeContext({ tool_name: 'Bash', tool_input: { command: PARK_CMD }, tool_response: { stdout: JSON.stringify(reply) } }), null);
  }
});

test('a Bash command that is not a park poll gets no context even if its output looks like a wake', () => {
  assert.equal(parkWakeContext({ tool_name: 'Bash', tool_input: { command: 'cat note.txt' }, tool_response: { stdout: wake('operator') } }), null);
  assert.equal(parkWakeContext({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'file.txt' } }), null);
});

test('other tools get no context', () => {
  assert.equal(parkWakeContext({ tool_name: 'Read', tool_input: { file_path: 'x' }, tool_response: { content: wake('operator') } }), null);
});

test('a backgrounded poll is read back through BashOutput, which has no command to check', () => {
  const out = parkWakeContext({ tool_name: 'BashOutput', tool_input: { bash_id: 'b1' }, tool_response: { stdout: wake('operator') } });
  assert.equal(out.hookSpecificOutput.classifierContext, CONTEXT_TEXT);
});

test('a wake nested in curl noise, with braces inside the note, is still found', () => {
  const noisy = `  % Total\n${wake('operator')}HTTP 200`;
  assert.ok(parkWakeContext({ tool_name: 'Bash', tool_input: { command: PARK_CMD }, tool_response: { stdout: noisy } }));
});

test('malformed input never throws', () => {
  for (const bad of [null, undefined, {}, { tool_name: 'Bash' }, { tool_name: 'Bash', tool_input: { command: PARK_CMD }, tool_response: 42 }, { tool_name: 'Bash', tool_input: { command: PARK_CMD }, tool_response: { stdout: '{"action":"wake"' } }]) {
    assert.equal(parkWakeContext(bad), null);
  }
});

function runHook(input, raw) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookScript], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(raw ?? JSON.stringify(input));
  });
}

test('hook: stdin JSON in, classifierContext JSON out for an operator wake; silence otherwise; garbage exits 0', async () => {
  const hit = await runHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: PARK_CMD }, tool_response: { stdout: wake('operator') } });
  assert.equal(hit.code, 0);
  assert.equal(JSON.parse(hit.stdout).hookSpecificOutput.classifierContext, CONTEXT_TEXT);
  const miss = await runHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'x' } });
  assert.deepEqual([miss.code, miss.stdout], [0, '']);
  const bad = await runHook(null, 'not json');
  assert.deepEqual([bad.code, bad.stdout], [0, '']);
});
