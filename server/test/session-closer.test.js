// Tests for finding and ending a card's Claude sessions
// (server/lib/orchestration/session-closer.js). No real processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promptTicketOf, sessionIdOf, planSessions, createSessionCloser, lastWriteWithHelpers } from '../lib/orchestration/session-closer.js';

const PROMPT = (id) => `"Read the task described in this file and complete it, then update its backlog card status: C:\\Users\\op\\.glmps\\runner\\${id}.prompt.md"`;
const proc = (ProcessId, ParentProcessId, Name, CommandLine) => ({ ProcessId, ParentProcessId, Name, CommandLine });

test('promptTicketOf reads the card id from the prompt file path only', () => {
  assert.equal(promptTicketOf(`claude.exe --session-id x ${PROMPT('glmps-2-0-83')} --settings y`), 'glmps-2-0-83');
  assert.equal(promptTicketOf('claude.exe --resume x "/home/op/.glmps/runner/GLMPS-7.prompt.md"'), 'glmps-7');
  assert.equal(promptTicketOf('claude.exe "C:\\elsewhere\\glmps-2-0-83.prompt.md"'), null);
  assert.equal(promptTicketOf('claude.exe'), null);
  assert.equal(promptTicketOf(null), null);
});

test('sessionIdOf reads a new or resumed session id', () => {
  assert.equal(sessionIdOf('claude.exe --session-id 3B168423-9356-4742-9478-845f7eaa4b8c "x"'), '3b168423-9356-4742-9478-845f7eaa4b8c');
  assert.equal(sessionIdOf('claude.exe --resume b41bb105-2ca9-4065-ade4-9d4ab155e355 "x"'), 'b41bb105-2ca9-4065-ade4-9d4ab155e355');
  assert.equal(sessionIdOf('claude.exe --resume not-a-uuid'), null);
});

test('a session is ended from its launcher when the launcher names the same prompt file', () => {
  const procs = [
    proc(10, 1, 'explorer.exe', 'explorer.exe'),
    proc(20, 10, 'sh.exe', `"C:\\Program Files\\Git\\usr\\bin\\sh.exe" /c/npm/claude --session-id a ${PROMPT('glmps-2-0-82')}`),
    proc(21, 20, 'claude.exe', `claude.exe --session-id 3b168423-9356-4742-9478-845f7eaa4b8c ${PROMPT('glmps-2-0-82')}`),
  ];
  assert.deepEqual(planSessions(procs), [{ ticketId: 'glmps-2-0-82', sessionId: '3b168423-9356-4742-9478-845f7eaa4b8c', pid: 21, rootPid: 20 }]);
});

test('an ancestor that does not name the prompt file is never part of the tree', () => {
  const procs = [
    proc(30, 1, 'cmd.exe', 'cmd.exe'),
    proc(31, 30, 'claude.exe', `claude.exe --resume b ${PROMPT('glmps-2-0-83')}`),
    proc(40, 1, 'cmd.exe', `cmd.exe /k claude ${PROMPT('glmps-2-0-84')}`),
    proc(41, 40, 'sh.exe', `sh.exe /c/npm/claude ${PROMPT('glmps-2-0-84')}`),
    proc(42, 41, 'claude.exe', `claude.exe ${PROMPT('glmps-2-0-84')}`),
    proc(50, 1, 'sh.exe', `sh.exe /c/npm/claude ${PROMPT('glmps-2-0-8')}`),
    proc(51, 50, 'claude.exe', `claude.exe ${PROMPT('glmps-2-0-86')}`),
    proc(60, 1, 'claude.exe', 'claude.exe --resume c'),
  ];
  assert.deepEqual(planSessions(procs), [
    { ticketId: 'glmps-2-0-83', sessionId: null, pid: 31, rootPid: 31 },
    { ticketId: 'glmps-2-0-84', sessionId: null, pid: 42, rootPid: 40 },
    { ticketId: 'glmps-2-0-86', sessionId: null, pid: 51, rootPid: 51 },
  ]);
});

function fakeExec(responses) {
  const calls = [];
  const impl = (file, args, opts, cb) => { calls.push([file, args]); const r = responses.shift() ?? {}; cb(r.err ?? null, r.stdout ?? '', r.stderr ?? ''); };
  return { impl, calls };
}

test('list parses the process query, including a single object result', async () => {
  const one = proc(21, 20, 'claude.exe', `claude.exe ${PROMPT('glmps-2-0-82')}`);
  const { impl, calls } = fakeExec([{ stdout: JSON.stringify(one) }, { stdout: '' }]);
  const closer = createSessionCloser({ execFileImpl: impl, platform: 'win32' });
  assert.deepEqual(await closer.list(), [{ ticketId: 'glmps-2-0-82', sessionId: null, pid: 21, rootPid: 21 }]);
  assert.deepEqual(await closer.list(), []);
  assert.equal(calls[0][0], 'powershell.exe');
});

test('list throws with the reason when the query fails, and lists nothing off Windows', async () => {
  const { impl } = fakeExec([{ err: new Error('boom'), stderr: 'access denied' }]);
  await assert.rejects(createSessionCloser({ execFileImpl: impl, platform: 'win32' }).list(), /process list failed: boom: access denied/);
  assert.deepEqual(await createSessionCloser({ execFileImpl: impl, platform: 'linux' }).list(), []);
});

test('close ends the whole tree, and a process already gone counts as closed', async () => {
  const { impl, calls } = fakeExec([{}, { err: Object.assign(new Error('gone'), { code: 128 }) }, { err: Object.assign(new Error('x'), { code: 1 }), stderr: 'Access is denied.' }]);
  const closer = createSessionCloser({ execFileImpl: impl, platform: 'win32' });
  assert.deepEqual(await closer.close({ rootPid: 20 }), { ok: true });
  assert.deepEqual(calls[0], ['taskkill.exe', ['/PID', '20', '/T', '/F']]);
  assert.deepEqual(await closer.close({ rootPid: 20 }), { ok: true });
  assert.deepEqual(await closer.close({ rootPid: 20 }), { ok: false, error: 'Access is denied.' });
  assert.deepEqual(await closer.close({ rootPid: 0 }), { ok: false, error: 'bad pid: 0' });
});

// Card glmps-2-0-runtime-89: a session waiting on background helpers writes
// nothing to its own transcript; the helpers write to subagents/ beside it.
test('lastWriteWithHelpers is the newest of the transcript and its helper transcripts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-helpers-'));
  try {
    const transcript = path.join(dir, 'abc.jsonl');
    fs.writeFileSync(transcript, 'x');
    fs.utimesSync(transcript, new Date(1000_000), new Date(1000_000));
    assert.equal(lastWriteWithHelpers(transcript), 1000_000, 'no helpers: the transcript alone');
    fs.mkdirSync(path.join(dir, 'abc', 'subagents'), { recursive: true });
    const helper = path.join(dir, 'abc', 'subagents', 'agent-1.jsonl');
    fs.writeFileSync(helper, 'y');
    fs.utimesSync(helper, new Date(5000_000), new Date(5000_000));
    assert.equal(lastWriteWithHelpers(transcript), 5000_000);
    assert.equal(lastWriteWithHelpers(path.join(dir, 'missing.jsonl')), null, 'no transcript: unknown');
    assert.equal(lastWriteWithHelpers(null), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
