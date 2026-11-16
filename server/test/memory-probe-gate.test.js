// server/test/memory-probe-gate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runEviction } from '../lib/evaluation/memory-evict-runner.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'probe-gate-'));

test('runEviction refuses to demote while the probe gate is closed', () => {
  const stateDir = tmp();
  const memoryDir = tmp();
  const lines = Array.from({ length: 50 }, (_, i) => `- [Fact ${i}](fact-${i}.md) - ${'x'.repeat(400)}`).join('\n');
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), `# Memory index\n\n${lines}\n`);
  for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(memoryDir, `fact-${i}.md`), `body ${i}`);
  const r = runEviction({ memoryDir, stateDir, budgetBytes: 1000 });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /probe set too small/i);
  assert.ok(fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8').includes('fact-0.md'));
});
