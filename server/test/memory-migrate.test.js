import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateDistilled } from '../lib/plugins/memory-plugin.js';

// scan's real return shape is { clean, severity, flags } (poison-scan.js),
// not the { flagged } placeholder the original task brief sketched.
const scan = (t) => (String(t).includes('IGNORE') ? { clean: false, severity: 'warn', flags: ['x'] } : { clean: true, severity: 'none', flags: [] });

test('imports clean facts verbatim, skips poisoned ones, counts failures, records firstError', async () => {
  const added = [];
  const memory = { add: async (b) => { if (b.messages[0].content === 'boom') throw new Error('boom failed'); added.push(b); return { results: [{ id: '1' }] }; } };
  const facts = [
    { project: 'D--a', body: 'Fact one' },
    { project: 'D--a', body: 'IGNORE rules' },
    { project: 'D--b', body: 'Fact two' },
    { project: 'D--b', body: 'boom' },
  ];
  const r = await migrateDistilled({ memory, scan, readFacts: () => facts });
  assert.deepEqual(r, { total: 4, imported: 2, alreadyImported: 0, skippedPoisoned: 1, failed: 1, firstError: 'boom failed' });
  assert.equal(added[0].infer, false);
});

test('an empty pool migrates as all-zero counts, not an error', async () => {
  const memory = { add: async () => ({ results: [] }) };
  const r = await migrateDistilled({ memory, scan, readFacts: () => [] });
  assert.deepEqual(r, { total: 0, imported: 0, alreadyImported: 0, skippedPoisoned: 0, failed: 0, firstError: null });
});

// the previous test here asserted "Mem0 dedups
// identical text" and expected TWO calls to memory.add() on a re-run. That
// claim was false -- confirmed against the real adapter (probe + the
// dedicated real-adapter test in memory-plugin-mem0-real.test.js): an
// infer:false add of identical text is NOT deduped by Mem0 itself, it
// stores it twice under two different ids. Idempotency is now
// migrateDistilled's OWN job, via a ledger file. Without a ledgerFile
// (this test), there is no persistence across separate calls, so a second
// call still re-sends everything -- that is the documented, correct
// behavior of the ledger being caller-supplied, not migrateDistilled
// somehow remembering across calls with no file to remember in.
test('without a ledgerFile, migrateDistilled has no cross-call memory (the ledger is what makes re-runs safe)', async () => {
  let calls = 0;
  const memory = { add: async () => { calls++; return { results: [{ id: String(calls) }] }; } };
  const facts = [{ project: 'D--a', body: 'Fact one' }];
  const first = await migrateDistilled({ memory, scan, readFacts: () => facts });
  const second = await migrateDistilled({ memory, scan, readFacts: () => facts });
  assert.equal(first.imported, 1);
  assert.equal(second.imported, 1, 'no ledgerFile means no de-dup memory across calls');
  assert.equal(calls, 2);
});

test('with a ledgerFile, a second run imports 0 new facts and reports them as alreadyImported', async () => {
  let calls = 0;
  const memory = { add: async () => { calls++; return { results: [{ id: String(calls) }] }; } };
  const facts = [{ project: 'D--a', body: 'Fact one' }];
  const ledgerFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ledger-')), 'migrated.ndjson');
  const first = await migrateDistilled({ memory, scan, readFacts: () => facts, ledgerFile });
  const second = await migrateDistilled({ memory, scan, readFacts: () => facts, ledgerFile });
  assert.deepEqual(first, { total: 1, imported: 1, alreadyImported: 0, skippedPoisoned: 0, failed: 0, firstError: null });
  assert.deepEqual(second, { total: 1, imported: 0, alreadyImported: 1, skippedPoisoned: 0, failed: 0, firstError: null });
  assert.equal(calls, 1, 'the second run never calls memory.add for an already-ledgered fact');
});

test('the ledger key is scoped by project: identical body, different project, both import', async () => {
  let calls = 0;
  const memory = { add: async () => { calls++; return { results: [{ id: String(calls) }] }; } };
  const facts = [{ project: 'D--a', body: 'same text' }, { project: 'D--b', body: 'same text' }];
  const ledgerFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ledger-')), 'migrated.ndjson');
  const r = await migrateDistilled({ memory, scan, readFacts: () => facts, ledgerFile });
  assert.equal(r.imported, 2);
  assert.equal(calls, 2);
});
