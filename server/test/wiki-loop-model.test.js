// server/test/wiki-loop-model.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wikiLoopChip, rebuildPollStep, wikiRetentionLine, acceptIfNotStale } from '../../web/observability/wiki-loop-model.js';

const NOW = 1_000_000_000;

test('chip: no loop on this server', () => {
  assert.equal(wikiLoopChip(null, NOW).tone, 'none');
  assert.match(wikiLoopChip(null, NOW).title, /kernel service/);
});

test('chip: failing shows the count and the reason as the title', () => {
  const c = wikiLoopChip({ lastOutcome: 'failed:sections', lastReason: 'sections: structural stub: server', consecutiveFailures: 2, lastRunTs: NOW - 60000 }, NOW);
  assert.equal(c.tone, 'fail');
  assert.equal(c.label, 'Build failing (2x)');
  assert.equal(c.title, 'sections: structural stub: server');
});

test('chip: healthy shows when it last checked', () => {
  const c = wikiLoopChip({ lastOutcome: 'nothing-to-do', consecutiveFailures: 0, lastRunTs: NOW - 2 * 3600000, lastOkTs: NOW - 5 * 3600000 }, NOW);
  assert.equal(c.tone, 'ok');
  assert.equal(c.label, 'Checked 2h ago');
});

test('chip: never run yet', () => {
  assert.equal(wikiLoopChip({ lastOutcome: null, consecutiveFailures: 0 }, NOW).label, 'Not built yet');
});

test('poll: a new build stamp is done; a newer failed run is failed; a newer nothing-to-do is unchanged', () => {
  const before = { manifest: { generatedAt: 'g1' }, loop: { lastRunTs: 100 } };
  assert.equal(rebuildPollStep({ before, after: { manifest: { generatedAt: 'g2' }, loop: { lastRunTs: 200, lastOutcome: 'done' } }, startedTs: 0, now: 1 }), 'done');
  assert.equal(rebuildPollStep({ before, after: { manifest: { generatedAt: 'g1' }, loop: { lastRunTs: 200, lastOutcome: 'failed:head' } }, startedTs: 0, now: 1 }), 'failed');
  assert.equal(rebuildPollStep({ before, after: { manifest: { generatedAt: 'g1' }, loop: { lastRunTs: 200, lastOutcome: 'nothing-to-do' } }, startedTs: 0, now: 1 }), 'unchanged');
  assert.equal(rebuildPollStep({ before, after: before, startedTs: 0, now: 1 }), 'waiting');
  assert.equal(rebuildPollStep({ before, after: before, startedTs: 0, now: 2100001 }), 'timeout');
});


test('chip: a poll timeout shows a still-building state, overriding the loop outcome', () => {
  const c = wikiLoopChip({ lastOutcome: 'nothing-to-do', consecutiveFailures: 0, lastRunTs: NOW - 1000 }, NOW, { pending: true });
  assert.equal(c.tone, 'pending');
  assert.equal(c.label, 'Still building\u2026');
  assert.match(c.title, /still be running/);
});

test('chip: pending overrides even a null loop (loop not registered here)', () => {
  assert.equal(wikiLoopChip(null, NOW, { pending: true }).tone, 'pending');
});

test('chip: healthy title names the next scheduled check when the loop reports one', () => {
  const c = wikiLoopChip({ lastOutcome: 'nothing-to-do', consecutiveFailures: 0, lastRunTs: NOW - 3600000, nextRunTs: NOW + 5 * 3600000 }, NOW);
  assert.equal(c.tone, 'ok');
  assert.equal(c.label, 'Checked 1h ago');
  assert.match(c.title, /Next check/);
});

test('poll: a newer run with outcome done is done even when the manifest stamp did not change', () => {
  const before = { manifest: { generatedAt: 'g1' }, loop: { lastRunTs: 100 } };
  const after = { manifest: { generatedAt: 'g1' }, loop: { lastRunTs: 200, lastOutcome: 'done' } };
  assert.equal(rebuildPollStep({ before, after, startedTs: 0, now: 1 }), 'done');
});

test('retention: no loop -> no warning line', () => {
  assert.equal(wikiRetentionLine(null), null);
});

test('retention: loop with no retentionWarning -> no line', () => {
  assert.equal(wikiRetentionLine({ lastOutcome: 'done' }), null);
});

test('retention: a set retentionWarning surfaces its message verbatim', () => {
  assert.equal(
    wikiRetentionLine({ lastOutcome: 'done', retentionWarning: { ts: 123, message: 'old build(s) not removed: wiki-2026-08-01' } }),
    'old build(s) not removed: wiki-2026-08-01',
  );
});

test('retention: an empty message string is treated as no warning', () => {
  assert.equal(wikiRetentionLine({ retentionWarning: { ts: 1, message: '' } }), null);
});


test('acceptIfNotStale: a switch that lands after the parse discards the parsed body', async () => {
  let staleNow = false;
  const isStale = () => staleNow;
  // Mirrors the real race: the response's body is still being parsed
  // (bodyPromise not yet settled) when a project switch flips isStale --
  // the check right before starting the parse would have missed this.
  const bodyPromise = new Promise((resolve) => {
    queueMicrotask(() => { staleNow = true; resolve({ root: 'B', fresh: true }); });
  });
  assert.equal(await acceptIfNotStale(bodyPromise, isStale), null);
});

test('acceptIfNotStale: no switch during the parse returns the parsed body', async () => {
  const body = await acceptIfNotStale(Promise.resolve({ root: 'A' }), () => false);
  assert.deepEqual(body, { root: 'A' });
});

test('acceptIfNotStale: already stale before the parse even starts also discards it', async () => {
  assert.equal(await acceptIfNotStale(Promise.resolve({ root: 'A' }), () => true), null);
});
