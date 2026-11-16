import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import * as w from '../lib/evaluation/memory-writer.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mw-'));
const fact = { name: 'my-fact', description: 'a hook', type: 'project', body: 'the body', wikilinks: [], confidence: 0.9 };

test('writeMemoryFile creates file + index line, idempotent', () => {
  const md = tmp();
  const r1 = w.writeMemoryFile(md, fact, { sessionId: 's1' });
  assert.equal(r1.written, true);
  assert.ok(fs.existsSync(path.join(md, 'my-fact.md')));
  const idx = fs.readFileSync(path.join(md, 'MEMORY.md'), 'utf8');
  assert.match(idx, /\[my-fact\]\(my-fact\.md\)/);
  // second write refuses overwrite
  const r2 = w.writeMemoryFile(md, fact, { sessionId: 's1' });
  assert.equal(r2.written, false);
  assert.equal(r2.reason, 'exists');
  // index not duplicated
  const idx2 = fs.readFileSync(path.join(md, 'MEMORY.md'), 'utf8');
  assert.equal((idx2.match(/my-fact\.md/g) || []).length, 1);
});

test('written memory file carries frontmatter + originSessionId', () => {
  const md = tmp();
  w.writeMemoryFile(md, { ...fact, name: 'fm-fact' }, { sessionId: 'sess-x' });
  const body = fs.readFileSync(path.join(md, 'fm-fact.md'), 'utf8');
  assert.match(body, /^---\n/);
  assert.match(body, /type: project/);
  assert.match(body, /originSessionId: sess-x/);
});

test('proposal lifecycle: stage -> list (id injected) -> approve writes', () => {
  const md = tmp(); const state = tmp();
  const id = w.stageProposal(state, { fact, memoryDir: md, sessionId: 's1', poison: { clean: true }, decisionReasons: ['low-confidence'], ts: 1 });
  const listed = w.listProposals(state);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, id);
  const res = w.approveProposal(state, id);
  assert.equal(res.written, true);
  assert.ok(fs.existsSync(path.join(md, 'my-fact.md')));
  assert.equal(w.listProposals(state).length, 0);
});

test('reject removes without writing', () => {
  const md = tmp(); const state = tmp();
  const id = w.stageProposal(state, { fact, memoryDir: md, sessionId: 's1', poison: { clean: true }, decisionReasons: [], ts: 1 });
  w.rejectProposal(state, id);
  assert.equal(w.listProposals(state).length, 0);
  assert.ok(!fs.existsSync(path.join(md, 'my-fact.md')));
});

test('approve/reject tolerate a missing id', () => {
  const state = tmp();
  assert.equal(w.approveProposal(state, 'nope').written, false);
  assert.doesNotThrow(() => w.rejectProposal(state, 'nope'));
  assert.deepEqual(w.listProposals(state), []);
});
