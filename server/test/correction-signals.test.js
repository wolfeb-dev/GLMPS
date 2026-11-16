// Correction-signal detectors (card glmps-2-0-runtime-94, spec
// docs/specs/2026-10-28-correction-signals.md in wolfeb-dev/glmps-2.0).
// Fixtures under fixtures/correction-signals/ are the real cases from the
// 2026-10-28 30-day measurement, redacted to the fields the detector reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  scanTranscriptForCorrections,
  callFingerprint,
  errorFingerprint,
  correctionId,
  WAIT_CALLS,
} from '../lib/observability/correction-signals.js';
import { feedFromTranscript, filterDispatchedWorktreeGaps } from '../lib/observability/capability-feed-core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', 'correction-signals', name), 'utf8')
  .split('\n').filter(Boolean);

const REJECTED_TEXT = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

let seq = 0;
function call(name, input, result) {
  const id = `toolu_t${++seq}`;
  const use = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  const block = { type: 'tool_result', tool_use_id: id, content: result.text ?? 'ok' };
  if (result.error || result.rejected) block.is_error = true;
  const rec = { type: 'user', message: { role: 'user', content: [block] } };
  if (result.rejected) rec.toolUseResult = 'User rejected tool use';
  if (result.denialKind) rec.toolDenialKind = result.denialKind;
  else if (result.error) rec.toolUseResult = `Error: ${result.text}`;
  return [use, JSON.stringify(rec)];
}
const rejected = (name, input) => [
  ...call(name, input, { rejected: true, text: REJECTED_TEXT }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }),
];
const failing = (name, input, text) => call(name, input, { error: true, text });
const ok = (name, input) => call(name, input, {});

const codes = (gaps) => gaps.map(g => g.code);
const ofKind = (gaps, kind) => gaps.filter(g => g.code.startsWith(`${kind}:`));

// Positive rules

test('tool-denied: the same call rejected twice in one session emits one warn row', () => {
  const lines = [
    ...rejected('Bash', { command: 'git push origin HEAD' }),
    ...ok('Bash', { command: 'git status' }),
    ...rejected('Bash', { command: 'git push --force-with-lease' }),
  ];
  const gaps = scanTranscriptForCorrections(lines);
  assert.equal(gaps.length, 1);
  const [g] = gaps;
  assert.equal(g.code, `tool-denied:${correctionId('Bash git push')}`);
  assert.equal(g.severity, 'warn');
  assert.match(g.message, /Bash/);
  assert.match(g.message, /git push/);
  assert.match(g.message, /2x/);
});

test('tool-denied: two different call fingerprints rejected once each emit nothing', () => {
  const lines = [
    ...rejected('Bash', { command: 'git push' }),
    ...rejected('Bash', { command: 'npm test' }),
  ];
  assert.deepEqual(scanTranscriptForCorrections(lines), []);
});

test('tool-error-loop: 3 fails on one error fingerprint then a pivot emits one info row', () => {
  const err = 'Exit code 1\nError: Cannot find module C:/repo/server/lib/x.js';
  const lines = [
    ...failing('Bash', { command: 'node server/x.js' }, err),
    ...failing('Bash', { command: 'node server/x.js --flag' }, err),
    ...failing('Bash', { command: 'node server/x.js' }, err),
    ...ok('Bash', { command: 'npm test' }),
  ];
  const gaps = scanTranscriptForCorrections(lines);
  assert.equal(gaps.length, 1);
  const [g] = gaps;
  const efp = errorFingerprint('Bash node server/x.js', err);
  assert.equal(efp, 'Bash node server/x.js | Error: Cannot find module P');
  assert.equal(g.code, `tool-error-loop:${correctionId(efp)}`);
  assert.equal(g.severity, 'info');
  assert.match(g.message, /failed 3x/);
  assert.match(g.message, /Cannot find module P/);
  assert.match(g.message, /npm test/);
});

test('tool-error-loop: a retry that succeeds with the same call fingerprint is not a pivot', () => {
  const err = 'error: failed to push some refs';
  const lines = [
    ...failing('Bash', { command: 'git push' }, err),
    ...failing('Bash', { command: 'git push' }, err),
    ...failing('Bash', { command: 'git push' }, err),
    ...ok('Bash', { command: 'git push' }),
  ];
  assert.deepEqual(scanTranscriptForCorrections(lines), []);
});

test('tool-error-loop: a success before the third failure is not a pivot', () => {
  const err = 'error: failed to push some refs';
  const lines = [
    ...failing('Bash', { command: 'git push' }, err),
    ...ok('Bash', { command: 'git fetch' }),
    ...failing('Bash', { command: 'git push' }, err),
    ...failing('Bash', { command: 'git push' }, err),
  ];
  assert.deepEqual(scanTranscriptForCorrections(lines), []);
});

test('tool-error-loop: a pivot on a different tool does not count', () => {
  const err = 'String to replace not found in file.';
  const lines = [
    ...failing('Edit', { file_path: 'C:/repo/a.js' }, err),
    ...failing('Edit', { file_path: 'C:/repo/a.js' }, err),
    ...failing('Edit', { file_path: 'C:/repo/a.js' }, err),
    ...ok('Write', { file_path: 'C:/repo/a.md' }),
  ];
  assert.deepEqual(scanTranscriptForCorrections(lines), []);
});

// False-positive guard (spec lines 1 to 9)

test('guard 1: text quoting the rejection phrase never counts as a rejection', () => {
  const lines = fixture('quoted-phrase-non-rejection.jsonl');
  assert.deepEqual(ofKind(scanTranscriptForCorrections(lines), 'tool-denied'), []);
  // Same tool_use pairs, but marked structurally: now they do count.
  const marked = lines.map((l) => {
    const o = JSON.parse(l);
    if (o.type !== 'user') return l;
    o.message.content[0].is_error = true;
    o.toolUseResult = 'User rejected tool use';
    return JSON.stringify(o);
  });
  assert.equal(ofKind(scanTranscriptForCorrections(marked), 'tool-denied').length, 2);
});

test('guard 2: one bare rejection is silent, whatever the tool', () => {
  for (const [name, input] of [
    ['Bash', { command: 'git push' }],
    ['Edit', { file_path: 'C:/repo/a.js' }],
    ['Write', { file_path: 'C:/repo/a.md' }],
    ['mcp__chrome-devtools-beta__navigate_page', { url: 'http://127.0.0.1:8123/' }],
  ]) {
    assert.deepEqual(scanTranscriptForCorrections(rejected(name, input)), [], name);
  }
});

test('guard 3: park-wait rejections are dropped, each alone and all six in one session', () => {
  const lines = fixture('park-wait-rejections.jsonl');
  assert.equal(lines.length, 18);
  for (let i = 0; i < lines.length; i += 3) {
    assert.deepEqual(scanTranscriptForCorrections(lines.slice(i, i + 3)), []);
  }
  assert.deepEqual(scanTranscriptForCorrections(lines), []);
  assert.ok(WAIT_CALLS.includes('/api/scut/park'));
});

test('guard 4: AskUserQuestion rejections are dropped, even repeated', () => {
  const lines = fixture('ask-user-question-rejection.jsonl');
  assert.deepEqual(scanTranscriptForCorrections(lines.slice(0, 3)), []);
  assert.deepEqual(scanTranscriptForCorrections(lines), []);
});

test('guard 5: a repo hook blocking (plan gate) is not an error to learn from', () => {
  const lines = fixture('plan-gate-loop.jsonl');
  assert.deepEqual(scanTranscriptForCorrections(lines), []);
  const err = 'PreToolUse:Edit hook error: This is a source file beyond the first two on card x and no plan is declared.';
  const synthetic = [
    ...failing('Edit', { file_path: 'C:/repo/a.js' }, err),
    ...failing('Edit', { file_path: 'C:/repo/a.js' }, err),
    ...failing('Edit', { file_path: 'C:/repo/a.js' }, err),
    ...ok('Edit', { file_path: 'C:/repo/plan.md' }),
  ];
  assert.deepEqual(scanTranscriptForCorrections(synthetic), []);
});

test('guard 6: classifier denials and no-verdicts are dropped', () => {
  assert.deepEqual(scanTranscriptForCorrections(fixture('classifier-loop.jsonl')), []);
  for (const err of [
    'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Production Deploy].',
    'claude-opus is temporarily unavailable, so auto mode cannot determine the safety of Write right now.',
  ]) {
    const lines = [
      ...failing('Write', { file_path: 'C:/repo/a.md' }, err),
      ...failing('Write', { file_path: 'C:/repo/a.md' }, err),
      ...failing('Write', { file_path: 'C:/repo/a.md' }, err),
      ...ok('Write', { file_path: 'C:/repo/a.js' }),
    ];
    assert.deepEqual(scanTranscriptForCorrections(lines), [], err);
  }
});

test('guard 7: harness preconditions (not read yet, modified since read) are dropped', () => {
  assert.deepEqual(scanTranscriptForCorrections(fixture('not-read-yet-loop.jsonl')), []);
  const err = 'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.';
  const lines = [
    ...failing('Edit', { file_path: 'C:/repo/a.js' }, `<tool_use_error>${err}</tool_use_error>`),
    ...failing('Edit', { file_path: 'C:/repo/a.js' }, `<tool_use_error>${err}</tool_use_error>`),
    ...failing('Edit', { file_path: 'C:/repo/a.js' }, `<tool_use_error>${err}</tool_use_error>`),
    ...ok('Edit', { file_path: 'C:/repo/a.md' }),
  ];
  assert.deepEqual(scanTranscriptForCorrections(lines), []);
});

test('guards 5 and 6: a structurally marked permission denial is never an error loop', () => {
  // Newer Claude Code records: the hook's deny reason arrives without the
  // PreToolUse prefix, and the record carries toolDenialKind instead.
  const denial = (text, denialKind) => call('Edit', { file_path: 'C:/repo/a.test.js' }, { error: true, text, denialKind });
  for (const [text, kind] of [
    ['Card glmps-2-0-75 is a bug fix, so existing test files are append-only: only add new test cases.', 'permission-rule'],
    ['The declared plan docs/specs/2026-10-23-code-review-remediation.md is not committed at HEAD. Commit it first.', 'permission-rule'],
    ["ls in 'D:\\glmps-2.0-runtime\\server\\node_modules' was blocked by a deny rule", 'permission-rule'],
    ['The server-side auto mode classifier gave no verdict (the response ended before its verdict arrived).', 'automode-unavailable'],
  ]) {
    const lines = [...denial(text, kind), ...denial(text, kind), ...denial(text, kind), ...ok('Edit', { file_path: 'C:/repo/a.md' })];
    assert.deepEqual(scanTranscriptForCorrections(lines), [], text);
    const unmarked = [...failing('Edit', { file_path: 'C:/repo/a.test.js' }, text), ...failing('Edit', { file_path: 'C:/repo/a.test.js' }, text),
      ...failing('Edit', { file_path: 'C:/repo/a.test.js' }, text), ...ok('Edit', { file_path: 'C:/repo/a.md' })];
    assert.equal(scanTranscriptForCorrections(unmarked).length, 1, `control: ${text}`);
  }
});

test('guard 7: malformed tool input is a harness precondition, not a machine fact', () => {
  const err = '<tool_use_error>InputValidationError: Read was called with input that could not be parsed as JSON.\nYou sent (first 115 of 115 bytes)';
  assert.deepEqual(scanTranscriptForCorrections(loopWith(err, 'Read', { file_path: 'C:/repo/a' }, { file_path: 'C:/repo/a.js' })), []);
});

test('guard 8: a loop with no successful pivot emits nothing', () => {
  const err = 'fatal: not a git repository';
  const lines = [
    ...failing('Bash', { command: 'git status' }, err),
    ...failing('Bash', { command: 'git status' }, err),
    ...failing('Bash', { command: 'git status' }, err),
    ...failing('Bash', { command: 'git log' }, err),
  ];
  assert.deepEqual(scanTranscriptForCorrections(lines), []);
});

test('guard 9: an empty error line after normalization does not fingerprint', () => {
  assert.equal(errorFingerprint('Bash curl -s', 'Exit code 56'), null);
  assert.equal(errorFingerprint('Bash curl -s', 'Exit code 7\n\n  \n'), null);
  assert.deepEqual(scanTranscriptForCorrections(fixture('curl-empty-loop.jsonl')), []);
});

// Controls: each guard above must be the reason its case is silent. With the
// guarded text swapped for an ordinary error, the same shape fires.

const plainErrors = (lines, needle) => lines.map((l) => {
  const o = JSON.parse(l);
  const r = o.message?.content?.[0];
  if (r?.type === 'tool_result' && r.is_error && String(r.content).includes(needle)) r.content = 'Error: plain';
  return JSON.stringify(o);
});
const loopWith = (err, tool, failInput, pivotInput) => [
  ...failing(tool, failInput, err),
  ...failing(tool, failInput, err),
  ...failing(tool, failInput, err),
  ...ok(tool, pivotInput),
];

test('controls: the real classifier and not-read-yet loops fire once their guard text is ordinary', () => {
  for (const [name, needle] of [['classifier-loop.jsonl', 'auto mode'], ['not-read-yet-loop.jsonl', 'not been read']]) {
    const gaps = scanTranscriptForCorrections(plainErrors(fixture(name), needle));
    assert.equal(ofKind(gaps, 'tool-error-loop').length, 1, name);
  }
});

test('controls: the synthetic guard loops fire with an ordinary error', () => {
  const shapes = [
    ['Edit', { file_path: 'C:/repo/a.js' }, { file_path: 'C:/repo/plan.md' }],
    ['Write', { file_path: 'C:/repo/a.md' }, { file_path: 'C:/repo/a.js' }],
    ['Bash', { command: 'curl -s http://127.0.0.1:8123/healthz' }, { command: 'node probe.mjs' }],
  ];
  for (const [tool, failInput, pivotInput] of shapes) {
    assert.equal(scanTranscriptForCorrections(loopWith('Error: plain', tool, failInput, pivotInput)).length, 1, tool);
  }
  // Guard 9's empty curl body against a real curl error line.
  const curl = ['Bash', { command: 'curl -s http://127.0.0.1:8123/healthz' }, { command: 'node probe.mjs' }];
  assert.deepEqual(scanTranscriptForCorrections(loopWith('Exit code 56', ...curl)), []);
  assert.equal(scanTranscriptForCorrections(loopWith('Exit code 56\ncurl: (56) Recv failure', ...curl)).length, 1);
});

test('controls: a rejection that is not a wait or a question fires when repeated', () => {
  const lines = [
    ...rejected('Bash', { command: 'curl -s -X POST http://127.0.0.1:8123/api/backlog' }),
    ...rejected('Bash', { command: 'curl -s -X POST http://127.0.0.1:8123/api/backlog/x/devlog' }),
  ];
  assert.equal(ofKind(scanTranscriptForCorrections(lines), 'tool-denied').length, 1);
});

// Fingerprints, id, limits

test('callFingerprint: Bash takes the first two tokens after VAR=value prefixes', () => {
  assert.equal(callFingerprint('Bash', { command: 'curl -s --max-time 5 http://x' }), 'Bash curl -s');
  assert.equal(callFingerprint('Bash', { command: 'GLMPS_STATE_DIR=/tmp/x NODE_ENV=test npm test' }), 'Bash npm test');
  assert.equal(callFingerprint('Bash', { command: '  git   push\n' }), 'Bash git push');
  assert.equal(callFingerprint('Bash', { command: 'ls' }), 'Bash ls');
});

test('callFingerprint: absolute paths in the Bash tokens are normalized', () => {
  assert.equal(callFingerprint('Bash', { command: 'cd C:/Users/me/wt-94 && git push' }), 'Bash cd P');
  assert.equal(callFingerprint('Bash', { command: 'cat /etc/hosts' }), 'Bash cat P');
});

test('callFingerprint: Edit, Write and Read use the file extension', () => {
  assert.equal(callFingerprint('Edit', { file_path: 'C:\\repo\\server\\a.JS' }), 'Edit .js');
  assert.equal(callFingerprint('Write', { file_path: '/repo/docs/x.md' }), 'Write .md');
  assert.equal(callFingerprint('Read', { file_path: '/repo/Makefile' }), 'Read');
  assert.equal(callFingerprint('Read', { file_path: '/repo.d/Makefile' }), 'Read');
});

test('callFingerprint: any other tool is its name', () => {
  assert.equal(callFingerprint('Grep', { pattern: 'x' }), 'Grep');
  assert.equal(callFingerprint('mcp__chrome-devtools-beta__click', { uid: '1' }), 'mcp__chrome-devtools-beta__click');
});

test('errorFingerprint: skips Exit code lines, replaces digits and paths, cuts to 100', () => {
  assert.equal(
    errorFingerprint('Bash npm test', 'Exit code 1\n\nError at D:\\repo\\a.js:12:3 after 450ms'),
    'Bash npm test | Error at P after Nms',
  );
  assert.equal(errorFingerprint('Bash ls', 'ls: cannot access /no/such: No such file'), 'Bash ls | ls: cannot access P No such file');
  const long = errorFingerprint('Grep', 'x'.repeat(500));
  assert.equal(long, `Grep | ${'x'.repeat(100)}`);
  assert.equal(errorFingerprint('Grep', [{ type: 'text', text: 'boom 42' }]), 'Grep | boom N');
});

test('correctionId is the first 12 hex of the SHA-1 of the fingerprint', () => {
  const fp = 'Bash git push';
  assert.equal(correctionId(fp), crypto.createHash('sha1').update(fp).digest('hex').slice(0, 12));
  assert.match(correctionId(fp), /^[0-9a-f]{12}$/);
});

test('codes stay under the 100-character ingest limit and messages under 2000', () => {
  const huge = `${'a'.repeat(3000)} ${'b'.repeat(3000)}`;
  const err = `${'e'.repeat(3000)}`;
  const lines = [
    ...rejected('Bash', { command: huge }),
    ...rejected('Bash', { command: huge }),
    ...failing('Bash', { command: huge }, err),
    ...failing('Bash', { command: huge }, err),
    ...failing('Bash', { command: huge }, err),
    ...ok('Bash', { command: `c${huge}` }),
  ];
  const gaps = scanTranscriptForCorrections(lines);
  assert.deepEqual(codes(gaps).map(c => c.split(':')[0]).sort(), ['tool-denied', 'tool-error-loop']);
  for (const g of gaps) {
    assert.ok(g.code.length <= 100, g.code);
    assert.ok(g.message.length <= 2000, String(g.message.length));
  }
});

test('the message never carries raw tool output beyond the normalized error line', () => {
  const err = 'Error: boom\nSECRET-LOOKING second line\nthird';
  const lines = [
    ...failing('Bash', { command: 'node a.js' }, err),
    ...failing('Bash', { command: 'node a.js' }, err),
    ...failing('Bash', { command: 'node a.js' }, err),
    ...ok('Bash', { command: 'node b.js' }),
  ];
  const [g] = scanTranscriptForCorrections(lines);
  assert.doesNotMatch(g.message, /SECRET-LOOKING|third/);
});

test('input shapes: a newline-delimited string, null and junk lines are tolerated', () => {
  const lines = [
    ...rejected('Bash', { command: 'git push' }),
    'not json',
    '',
    ...rejected('Bash', { command: 'git push' }),
  ];
  assert.equal(scanTranscriptForCorrections(lines.join('\n')).length, 1);
  assert.deepEqual(scanTranscriptForCorrections(null), []);
  assert.deepEqual(scanTranscriptForCorrections([]), []);
});

// Wiring into the Stop-hook feeder (spec task 5)

const feedLines = () => [
  ...rejected('Bash', { command: 'git push' }),
  ...rejected('Bash', { command: 'git push' }),
  ...failing('Bash', { command: 'node a.js' }, 'Error: boom'),
  ...failing('Bash', { command: 'node a.js' }, 'Error: boom'),
  ...failing('Bash', { command: 'node a.js' }, 'Error: boom'),
  ...ok('Bash', { command: 'node b.js' }),
];

test('feedFromTranscript carries both correction codes beside the transcript gaps', () => {
  const lines = [...feedLines(), ...ok('Bash', { command: 'sleep 30' })];
  const { gaps } = feedFromTranscript({ lines, cwd: 'D:\glmps-2.0-runtime' });
  const kinds = gaps.map(g => g.code.split(':')[0]);
  assert.ok(kinds.includes('tool-denied'));
  assert.ok(kinds.includes('tool-error-loop'));
  assert.ok(kinds.includes('sleep-poll'));
});

test('filterDispatchedWorktreeGaps keeps the correction codes for a dispatched worktree', () => {
  const cwd = 'D:\glmps-2.0-runtime\.claude\worktrees\agent-a1b2c3';
  const { gaps } = feedFromTranscript({ lines: feedLines(), cwd });
  assert.equal(gaps.length, 2);
  assert.deepEqual(filterDispatchedWorktreeGaps(gaps, cwd), gaps);
});
