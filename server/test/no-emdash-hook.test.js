// server/test/no-emdash-hook.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkEmdash } from '../../hooks/no-emdash.js';

const EM = String.fromCharCode(0x2014);
const BAR = String.fromCharCode(0x2015);
const EN = String.fromCharCode(0x2013);
const env = {};
const transcript = (...lines) => ({ readFile: () => lines.map((l) => JSON.stringify(l)).join('\n') });
const said = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('a Write, Edit or MultiEdit holding an em-dash or horizontal bar is denied', () => {
  const cases = [
    { tool_name: 'Write', tool_input: { content: `a ${EM} b` } },
    { tool_name: 'Edit', tool_input: { new_string: `a ${BAR} b` } },
    { tool_name: 'MultiEdit', tool_input: { edits: [{ new_string: 'ok' }, { new_string: `x${EM}` }] } },
  ];
  for (const input of cases) {
    const out = checkEmdash(input, { env });
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', input.tool_name);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /em-dash/);
  }
});

test('an en-dash, a clean write and an untouched old_string are allowed', () => {
  assert.deepEqual(checkEmdash({ tool_name: 'Write', tool_input: { content: `2020${EN}2021` } }, { env }), {});
  assert.deepEqual(checkEmdash({ tool_name: 'Edit', tool_input: { old_string: EM, new_string: ', ' } }, { env }), {});
});

test('Stop blocks when the last assistant text holds an em-dash, reading only the last one', () => {
  const input = { hook_event_name: 'Stop', transcript_path: 't' };
  const out = checkEmdash(input, { env, ...transcript(said('fine'), { type: 'user' }, said(`bad ${EM}`)) });
  assert.equal(out.decision, 'block');
  assert.deepEqual(checkEmdash(input, { env, ...transcript(said(`old ${EM}`), said('clean')) }), {});
});

test('Stop allows when the hook is already re-firing, or the transcript is unreadable', () => {
  const read = transcript(said(`bad ${EM}`));
  assert.deepEqual(checkEmdash({ hook_event_name: 'Stop', transcript_path: 't', stop_hook_active: true }, { env, ...read }), {});
  assert.deepEqual(checkEmdash({ hook_event_name: 'Stop', transcript_path: 't' }, { env, readFile: () => { throw new Error('ENOENT'); } }), {});
});

test('CLAUDE_ALLOW_EMDASH=1 disables both checks', () => {
  const off = { CLAUDE_ALLOW_EMDASH: '1' };
  assert.deepEqual(checkEmdash({ tool_name: 'Write', tool_input: { content: EM } }, { env: off }), {});
  assert.deepEqual(checkEmdash({ hook_event_name: 'Stop', transcript_path: 't' }, { env: off, ...transcript(said(EM)) }), {});
});

test('run as a hook it reads stdin and prints the decision; bad stdin allows', () => {
  const script = fileURLToPath(new URL('../../hooks/no-emdash.js', import.meta.url));
  const childEnv = { ...process.env };
  delete childEnv.CLAUDE_ALLOW_EMDASH;
  const deny = execFileSync(process.execPath, [script], { input: JSON.stringify({ tool_name: 'Write', tool_input: { content: EM } }), env: childEnv, encoding: 'utf8' });
  assert.equal(JSON.parse(deny).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [script], { input: 'not json', env: childEnv, encoding: 'utf8' })), {});

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-emdash-'));
  try {
    const t = path.join(dir, 't.jsonl');
    fs.writeFileSync(t, JSON.stringify(said(`x ${EM}`)) + '\n');
    const stop = execFileSync(process.execPath, [script], { input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: t }), env: childEnv, encoding: 'utf8' });
    assert.equal(JSON.parse(stop).decision, 'block');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
