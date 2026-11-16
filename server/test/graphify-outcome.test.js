import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGraphifyRun } from '../lib/observability/graphify-outcome.js';

test('classifies a successful rebuild and extracts the node count', () => {
  const r = classifyGraphifyRun({
    code: 0,
    stdout: '[graphify watch] Rebuilt: 4878 nodes, 8237 edges, 296 communities\n',
    stderr: '',
  });
  assert.equal(r.outcome, 'updated');
  assert.equal(r.nodes, 4878);
});

test('classifies a no-op (exit 0, nothing written)', () => {
  const r = classifyGraphifyRun({
    code: 0,
    stdout: '[graphify watch] No code-graph topology changes detected; outputs left untouched.\n',
    stderr: '',
  });
  assert.equal(r.outcome, 'noop');
  assert.equal(r.nodes, null);
});

test('classifies the 0.9.99 no-relevant-changes wording as a no-op', () => {
  const r = classifyGraphifyRun({
    code: 0,
    stdout: '[graphify watch] No relevant changes; graphify-out left untouched.\nCode graph updated. For doc/paper/image changes run /graphify --update in your AI assistant.\n',
    stderr: '',
  });
  assert.equal(r.outcome, 'noop');
});

// Captured from `uvx --from graphifyy==0.9.102 graphify update` on a copy of
// D:/glmps-2.0 (11-03): the live audit read it as a failure and rolled back.
test('classifies the 0.9.102 skipping-rebuild wording as a no-op', () => {
  const r = classifyGraphifyRun({
    code: 0,
    stdout: '[graphify watch] 2 file(s) not classified (no supported extension or shebang), skipped: .gitignore, .graphifyignore\n'
      + '[graphify watch] Incremental: none of the 59 scanned files differ from the last build.\n'
      + '[graphify watch] No tracked code files in change set - skipping rebuild.\n'
      + 'Code graph updated. For doc/paper/image changes run /graphify --update in your AI assistant.\n',
    stderr: '',
  });
  assert.equal(r.outcome, 'noop');
});

test('classifies a refusal at exit 0 and captures both node counts', () => {
  const r = classifyGraphifyRun({
    code: 0,
    stdout: 'Nothing to update or rebuild failed - check output above.\n',
    stderr: '[graphify] WARNING: new graph has 4478 nodes but existing graph.json has 4479. Refusing to overwrite.\n',
  });
  assert.equal(r.outcome, 'refused');
  assert.equal(r.nodes, 4478);
  assert.equal(r.existingNodes, 4479);
});

test('a non-zero exit is failed regardless of output', () => {
  const r = classifyGraphifyRun({ code: 1, stdout: '', stderr: 'boom' });
  assert.equal(r.outcome, 'failed');
});

test('unrecognised exit-0 output is failed, not silently updated', () => {
  const r = classifyGraphifyRun({ code: 0, stdout: 'something new upstream prints\n', stderr: '' });
  assert.equal(r.outcome, 'failed');
});

test('tolerates missing/undefined streams without throwing', () => {
  const r = classifyGraphifyRun({ code: 0 });
  assert.equal(r.outcome, 'failed');
});

// CORRECTION (glmps-84, found post-merge in the live server's own
// stderr): graphify does NOT exit 0 for every outcome. A REFUSAL exits 1. The
// live log carries the proof:
//   graph auto-rebuild: d:/harbor-app failed (exit 1): [graphify] WARNING: new
//   graph has 4478 nodes but existing graph.json has 4479. Refusing to overwrite
// Only `updated` and `noop` exit 0. Checking the exit code FIRST therefore
// swallowed the one outcome this module exists to name, reporting a refusal as
// a generic "exit 1" and dropping both node counts. Recognised output must win
// over the exit code; the code only decides for output we cannot classify.

test('a refusal is classified as refused even though it exits non-zero', () => {
  const r = classifyGraphifyRun({
    code: 1,
    stdout: 'Nothing to update or rebuild failed - check output above.\n',
    stderr: '[graphify] WARNING: new graph has 4478 nodes but existing graph.json has 4479. Refusing to overwrite.\n',
  });
  assert.equal(r.outcome, 'refused');
  assert.equal(r.nodes, 4478);
  assert.equal(r.existingNodes, 4479);
});

test('a successful rebuild is still updated if the exit code is odd', () => {
  // Defensive: the outcome we can read from the output is more trustworthy
  // than an exit convention that has already surprised us once.
  const r = classifyGraphifyRun({
    code: 1,
    stdout: '[graphify watch] Rebuilt: 4878 nodes, 8237 edges, 296 communities\n',
    stderr: '',
  });
  assert.equal(r.outcome, 'updated');
  assert.equal(r.nodes, 4878);
});

test('a non-zero exit with unrecognised output is still failed', () => {
  const r = classifyGraphifyRun({ code: 1, stdout: '', stderr: 'segfault' });
  assert.equal(r.outcome, 'failed');
  assert.match(r.reason, /exit 1/);
});
