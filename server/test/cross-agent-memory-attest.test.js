import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { distributeMemory, computeMemoryAttestation, recordMemoryBaseline } from '../lib/governance/cross-agent-memory.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cam-attest-')); }

test('no baseline -> configured:false, no findings', () => {
  const r = computeMemoryAttestation({ baselinePath: path.join(tmp(), 'nope.json') });
  assert.equal(r.configured, false);
  assert.deepEqual(r.findings, []);
});

test('push then attest: clean (no drift) right after a push', () => {
  const dir = tmp();
  const targetFile = path.join(dir, 'CLAUDE.md');
  const baselinePath = path.join(dir, 'baseline.json');
  const entries = [{ name: 'shared-fact', description: 'd', body: 'b' }];
  const results = distributeMemory({
    targets: [{ vendor: 'claude-code', path: targetFile }],
    entries,
    readFile: () => '', exists: () => false, guard: () => ({ allowed: true }),
  });
  fs.writeFileSync(targetFile, results[0].content);
  recordMemoryBaseline(baselinePath, results.map(r => ({ ...r, path: targetFile })));

  const r = computeMemoryAttestation({ baselinePath });
  assert.equal(r.configured, true);
  assert.equal(r.summary.critical, 0);
});

test('whole managed block deleted (both markers gone, file intact) trips drift - not silently ok (glmps-118)', () => {
  const dir = tmp();
  const targetFile = path.join(dir, 'CLAUDE.md');
  const baselinePath = path.join(dir, 'baseline.json');
  const entries = [{ name: 'shared-fact', description: 'd', body: 'b' }];
  const results = distributeMemory({
    targets: [{ vendor: 'claude-code', path: targetFile }],
    entries, readFile: () => '', exists: () => false, guard: () => ({ allowed: true }),
  });
  fs.writeFileSync(targetFile, results[0].content);
  recordMemoryBaseline(baselinePath, results.map(r => ({ ...r, path: targetFile })));

  // Human strips the ENTIRE managed block (both GLMPS:BEGIN/END markers),
  // leaving the file in place with unrelated content.
  fs.writeFileSync(targetFile, '# unrelated content \u2014 managed block fully removed\n');

  const r = computeMemoryAttestation({ baselinePath });
  assert.equal(r.summary.critical, 1, 'whole-block deletion must be flagged as critical, not ok');
  assert.equal(r.summary.ok, 0);
  assert.ok(r.findings.some(f => f.kind === 'guardrail-modified'));
});

test('hand-edit inside the memory managed block trips drift', () => {
  const dir = tmp();
  const targetFile = path.join(dir, 'CLAUDE.md');
  const baselinePath = path.join(dir, 'baseline.json');
  const entries = [{ name: 'shared-fact', description: 'd', body: 'b' }];
  const results = distributeMemory({
    targets: [{ vendor: 'claude-code', path: targetFile }],
    entries, readFile: () => '', exists: () => false, guard: () => ({ allowed: true }),
  });
  fs.writeFileSync(targetFile, results[0].content);
  recordMemoryBaseline(baselinePath, results.map(r => ({ ...r, path: targetFile })));

  // Tamper inside the managed block.
  fs.writeFileSync(targetFile, results[0].content.replace('shared-fact', 'tampered-fact'));

  const r = computeMemoryAttestation({ baselinePath });
  assert.equal(r.summary.critical, 1);
  assert.ok(r.findings.some(f => f.kind === 'guardrail-modified'));
});

// card glmps-2-0-219: a baseline written before a repo folder was renamed
// (the renamed 1.0 checkout) can never be satisfied, so it is info, not critical.
test('a missing file whose project folder is gone is info; one missing from a live project stays critical', () => {
  const dir = tmp();
  const baselinePath = path.join(dir, 'baseline.json');
  const gone = path.join(dir, 'renamed-repo');
  const live = path.join(dir, 'live-repo');
  fs.mkdirSync(live);
  fs.writeFileSync(baselinePath, JSON.stringify({ requiredFiles: [
    { label: 'claude-code', tool: 'claude-code', path: path.join(gone, 'CLAUDE.md'), sha256: 'a', managed: true },
    { label: 'cursor', tool: 'cursor', path: path.join(gone, '.cursor', 'rules', 'glmps-guardrails.mdc'), sha256: 'b', managed: true },
    { label: 'copilot', tool: 'copilot', path: path.join(live, '.github', 'copilot-instructions.md'), sha256: 'c', managed: true },
  ] }));
  const r = computeMemoryAttestation({ baselinePath });
  const bySev = (s) => r.findings.filter((f) => f.severity === s).map((f) => f.label ?? f.title);
  assert.equal(r.summary.critical, 1);
  assert.deepEqual(r.findings.filter((f) => f.severity === 'critical').map((f) => f.kind), ['guardrail-missing']);
  const info = r.findings.filter((f) => f.severity === 'info');
  assert.equal(info.length, 2, JSON.stringify(bySev('info')));
  assert.ok(info.every((f) => f.kind === 'guardrail-project-removed' && /^Guardrail project folder removed: /.test(f.title)));
});
