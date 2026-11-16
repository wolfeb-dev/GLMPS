// server/test/decision-log-store.test.js
// glmps-143 Task 3. Append-only JSONL because the writer is a Stop hook that
// can run while the server is also writing: appending a line is atomic enough,
// read-modify-write of a JSON array is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  append, readAll, loadWatermarks, saveWatermarks, joinEnrichment, logPath,
} from '../lib/observability/decision-log-store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-declog-'));
const row = (over = {}) => ({ ts: 1753220000000, repo: 'D:/glmps', commit: 'abc1234', what: 'merge: a thing', why: 'because', source: 'git', ...over });

test('append then readAll round-trips, newest first', () => {
  const sd = tmp();
  // Distinct timestamps: with equal ts the sort is stable and "newest first"
  // would assert nothing.
  append(sd, [row({ ts: 1000 }), row({ ts: 2000, commit: 'def5678', what: 'merge: another' })]);
  const out = readAll(sd);
  assert.equal(out.length, 2);
  assert.equal(out[0].commit, 'def5678');
  assert.equal(out[1].commit, 'abc1234');
});

test('append is a single write per call, and is additive across calls', () => {
  const sd = tmp();
  append(sd, [row()]);
  append(sd, [row({ commit: 'second' })]);
  assert.equal(readAll(sd).length, 2);
});

test('append of an empty array writes nothing and does not create noise', () => {
  const sd = tmp();
  append(sd, []);
  assert.deepEqual(readAll(sd), []);
});

test('readAll on a missing store returns empty, never throws', () => {
  assert.deepEqual(readAll(tmp()), []);
});

test('a malformed line does NOT poison the read', () => {
  const sd = tmp();
  append(sd, [row({ commit: 'good1' })]);
  fs.appendFileSync(logPath(sd), '{ this is not json\n');
  append(sd, [row({ commit: 'good2' })]);
  const out = readAll(sd);
  assert.equal(out.length, 2, 'both valid rows survive the bad line');
  assert.deepEqual(out.map(r => r.commit).sort(), ['good1', 'good2']);
});

test('readAll filters by repo', () => {
  const sd = tmp();
  append(sd, [row({ repo: 'D:/a', commit: 'r1' }), row({ repo: 'D:/b', commit: 'r2' })]);
  assert.deepEqual(readAll(sd, { repo: 'D:/b' }).map(r => r.commit), ['r2']);
});

test('readAll filters by since', () => {
  const sd = tmp();
  append(sd, [row({ ts: 1000, commit: 'old' }), row({ ts: 9000, commit: 'new' })]);
  assert.deepEqual(readAll(sd, { since: 5000 }).map(r => r.commit), ['new']);
});

test('readAll filters by q across what and why, case-insensitively', () => {
  const sd = tmp();
  append(sd, [
    row({ commit: 'c1', what: 'merge: CRLF fix', why: '' }),
    row({ commit: 'c2', what: 'merge: other', why: 'mentions crlf in the body' }),
    row({ commit: 'c3', what: 'merge: unrelated', why: 'nothing' }),
  ]);
  const hits = readAll(sd, { q: 'crlf' }).map(r => r.commit).sort();
  assert.deepEqual(hits, ['c1', 'c2']);
});

test('readAll caps with limit, keeping the newest', () => {
  const sd = tmp();
  append(sd, [row({ ts: 1, commit: 'a' }), row({ ts: 2, commit: 'b' }), row({ ts: 3, commit: 'c' })]);
  assert.deepEqual(readAll(sd, { limit: 2 }).map(r => r.commit), ['c', 'b']);
});

test('watermarks round-trip and default to empty', () => {
  const sd = tmp();
  assert.deepEqual(loadWatermarks(sd), {});
  saveWatermarks(sd, { 'D:/glmps': 1753220000000 });
  assert.equal(loadWatermarks(sd)['D:/glmps'], 1753220000000);
});

test('joinEnrichment attaches a why to a thin git row', () => {
  const rows = [
    { ts: 2, repo: 'D:/x', commit: 'abc', what: 'merge: thin', why: '', source: 'git' },
    { ts: 3, commit: 'abc', why: 'the real reason, from the session', source: 'enrichment' },
  ];
  const out = joinEnrichment(rows);
  const git = out.find(r => r.source === 'git');
  assert.equal(git.why, 'the real reason, from the session');
  assert.equal(out.filter(r => r.source === 'enrichment').length, 0, 'enrichment rows are consumed, not shown');
});

test('joinEnrichment leaves a substantive body alone', () => {
  const rows = [
    { ts: 2, repo: 'D:/x', commit: 'abc', what: 'merge: fat', why: 'an already-good explanation', source: 'git' },
    { ts: 3, commit: 'abc', why: 'should not win', source: 'enrichment' },
  ];
  const git = joinEnrichment(rows).find(r => r.source === 'git');
  assert.equal(git.why, 'an already-good explanation');
});

test('joinEnrichment keeps config rows untouched', () => {
  const rows = [{ ts: 1, repo: '~/.claude/settings.json', source: 'config', sections: { env: { added: ['X'], removed: [], changed: 0 } } }];
  assert.deepEqual(joinEnrichment(rows), rows);
});
