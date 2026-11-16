// web/observability/session-model.js: the session page's state, sentence,
// band order, verdict slots, file groups, learning ledger and feed filter
// (session-detail spec sections 3 to 5, card glmps-2-0-runtime-60).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../web/observability/session-model.js';

const NOW = Date.parse('2026-10-27T20:00:00Z');
const page = (total) => ({ total, returned: total, hasMore: false });
const card = (gate, extra = {}) => ({ id: 'c-1', title: 'Do the thing', acceptanceCriteria: [{ text: 'AC-1', done: true }, { text: 'AC-2', done: false }],
  gate: gate ? { status: gate, risk: 'P3', evidenceCount: 2 } : null, prUrl: null, mergeQueue: null, ...extra });

test('five states: live, idle, finished, abandoned, no log', () => {
  assert.equal(M.sessionState({ state: 'working' }, { page: page(3) }).key, 'live');
  assert.equal(M.sessionState({ state: 'idle' }, { page: page(3) }).key, 'idle');
  const fin = M.sessionState({ state: 'ended' }, { page: page(3), card: card('PASS') });
  assert.deepEqual(fin, { key: 'finished', word: 'FINISHED', tone: 'ok' });
  assert.equal(M.sessionState({ state: 'ended' }, { page: page(3), card: card('FAIL') }).tone, 'danger');
  assert.equal(M.sessionState({ state: 'ended' }, { page: page(3), card: card('CONCERNS') }).tone, 'warn');
  assert.equal(M.sessionState({ state: 'ended' }, { page: page(3) }).key, 'finished', 'an interactive session finishes without a gate');
  assert.equal(M.sessionState({ state: 'ended' }, { page: page(3), card: card(null) }).key, 'abandoned');
  assert.equal(M.sessionState({ state: 'ended' }, { page: page(3), outcome: { outcomeClass: 'abandoned' } }).key, 'abandoned');
  assert.equal(M.sessionState({ state: 'ended', tool: 'antigravity' }, { page: page(0) }).key, 'nolog');
  assert.equal(M.sessionState({ state: 'working' }, { page: page(0) }).key, 'live', 'a live session with no events yet is still live');
});

test('band order: finished leads with Touching, live and idle with Doing, no log draws none', () => {
  assert.deepEqual(M.bandOrder('finished'), ['touching', 'learning', 'doing']);
  assert.deepEqual(M.bandOrder('live'), ['doing', 'touching', 'learning']);
  assert.deepEqual(M.bandOrder('idle'), ['doing', 'touching', 'learning']);
  assert.deepEqual(M.bandOrder('abandoned'), ['doing', 'touching', 'learning']);
  assert.deepEqual(M.bandOrder('nolog'), []);
});

test('title: the card id and title, else session title, else project, else short id', () => {
  assert.deepEqual(M.sessionTitle({ title: 'x' }, { card: card('PASS') }, 'abc'), { id: 'c-1', text: 'Do the thing' });
  assert.deepEqual(M.sessionTitle({ title: 'A title' }, {}, 'abc'), { id: null, text: 'A title' });
  assert.deepEqual(M.sessionTitle({ cwd: 'D:\\repo\\proj\\' }, {}, 'abc'), { id: null, text: 'proj' });
  assert.deepEqual(M.sessionTitle(null, {}, 'abcdef0123'), { id: null, text: 'abcdef01' });
});

test('verdict slots are never blank: every absent verdict says why', () => {
  const none = M.verdictSlots({}, 'finished', null);
  assert.deepEqual(none.map((s) => s.id), ['gate', 'judge', 'pr', 'approvals']);
  for (const s of none) assert.ok(s.word, `${s.id} has a word`);
  assert.equal(none[0].detail, 'not a card session');
  assert.equal(none[1].word, 'pending');

  const missing = M.verdictSlots({ card: card(null) }, 'abandoned', { requests: [] });
  assert.equal(missing[0].word, 'MISSING');
  assert.equal(missing[0].tone, 'warn');
  assert.match(missing[0].detail, /c-1/);
  assert.equal(M.verdictSlots({ card: card(null) }, 'live', {})[0].word, 'pending');

  const full = M.verdictSlots({
    card: card('PASS', { prUrl: 'https://github.com/o/r/pull/32', mergeQueue: { stage: 'reviewing', round: 2, number: 32 } }),
    outcome: { judge: { status: 'concerns', by: 'judge', comment: 'meh' } },
  }, 'finished', { requests: [{ ticketId: 'c-1', status: 'pending', action: 'deploy' }, { ticketId: 'other', status: 'pending' }] });
  assert.deepEqual(full[0], { id: 'gate', label: 'GATE', word: 'PASS', tone: 'ok', detail: 'P3  AC 1/2 done  2 evidence' });
  assert.equal(full[1].word, 'CONCERNS');
  assert.equal(full[2].word, 'REVIEWING');
  assert.equal(full[2].detail, 'PR #32 round 2');
  assert.equal(full[3].word, '1 WAITING');
  assert.equal(full[3].detail, 'deploy');
  assert.equal(M.verdictSlots({ card: card('PASS') }, 'finished', null)[3].word, 'unavailable');
});

test('state sentence is one generated line per state', () => {
  const touch = { files: [{ path: 'a', writes: 1, add: 10, del: 2 }, { path: 'b', writes: 0, add: 0, del: 0 }],
    counts: { written: 1, read: 1, commits: 0 }, span: { firstTs: NOW - 41 * 60000, lastTs: NOW - 12 * 60000 } };
  const s = { state: 'ended', status: { cost: { totalUsd: 3.1 } } };
  const data = { page: page(5), touch, card: card('PASS', { prUrl: 'https://github.com/o/r/pull/32', mergeQueue: { stage: 'requested', number: 32 } }), outcome: { judge: { status: 'pass' } } };
  assert.equal(M.stateSentence(M.sessionState(s, data), s, data, NOW),
    'Finished 12m ago. Gate PASS, judge pass, PR #32 requested. 1 file written, +10 -2. $3.10.');
  const live = { state: 'working' };
  const ld = { page: page(5), touch, loop: { key: 'execute', enteredTs: NOW - 5 * 60000 } };
  assert.equal(M.stateSentence(M.sessionState(live, ld), live, ld, NOW), 'Live in EXECUTE for 5m. 1 file written, +10 -2.');
  const idle = { state: 'idle' };
  assert.equal(M.stateSentence(M.sessionState(idle, ld), idle, ld, NOW), 'Idle, not ended; last event 12m ago. 1 file written, +10 -2.');
  const ab = { page: page(5), touch, card: card(null) };
  assert.match(M.stateSentence(M.sessionState(s, ab), s, ab, NOW), /^Ended 12m ago with no gate on c-1\./);
  const later = { page: page(5), touch, card: card('PASS'), outcome: { outcomeClass: 'abandoned' } };
  assert.ok(M.stateSentence(M.sessionState(s, later), s, later, NOW)
    .startsWith('Ended 12m ago; the judge classed this run abandoned (c-1 was gated PASS by another run).'));
  assert.match(M.stateSentence({ key: 'nolog' }, { tool: 'antigravity' }, {}, NOW), /cloud backend/);
});

test('primary action follows the state', () => {
  assert.equal(M.primaryAction({ key: 'live' }, {}).id, 'steer');
  assert.equal(M.primaryAction({ key: 'idle' }, {}).id, 'resume');
  assert.equal(M.primaryAction({ key: 'abandoned' }, { card: card(null) }).id, 'requeue');
  assert.equal(M.primaryAction({ key: 'abandoned' }, { card: card('PASS') }).id, 'card', 'a card another run gated is opened, not requeued');
  assert.equal(M.primaryAction({ key: 'finished' }, { card: card('FAIL') }).id, 'requeue');
  assert.deepEqual(M.primaryAction({ key: 'finished' }, { card: card('PASS', { prUrl: 'u' }) }), { id: 'pr', label: 'Open PR', url: 'u' });
  assert.equal(M.primaryAction({ key: 'finished' }, {}), null);
  assert.equal(M.primaryAction({ key: 'nolog' }, { card: card(null) }).id, 'card');
});

test('cost strip says "not recorded" rather than drawing nothing', () => {
  const c = M.costStrip({ status: { cost: { totalUsd: 1.234 }, context: { usedPercent: 63.4 } } },
    { touch: { span: { firstTs: NOW - 41 * 60000, lastTs: NOW } } }, 'finished');
  assert.deepEqual(c.map((x) => [x.label, x.value]), [['SPEND', '$1.23'], ['CTX LAST', '63%'], ['WALL', '41m']]);
  // Card glmps-2-0-137 phase 4 (story 36): no session summary carries a token
  // total, so there is no TOKENS card rather than a permanent "not recorded".
  assert.equal(c.some((x) => x.label === 'TOKENS'), false);
  assert.ok(M.costStrip(null, {}, 'live').every((x) => x.value), 'every cell has a value');
});

test('files group by directory under the root, writes first', () => {
  const g = M.groupFiles([
    { path: 'D:\\repo\\docs\\a.md', writes: 0, reads: 1, add: 0, del: 0 },
    { path: 'D:\\repo\\server\\lib\\x.js', writes: 2, add: 5, del: 1 },
    { path: 'D:\\repo\\server\\lib\\y.js', writes: 1, add: 1, del: 0 },
    { path: 'C:/elsewhere/z.md', writes: 1, add: 2, del: 0 },
    { path: 'D:\\repo\\README.md', writes: 0, reads: 1 },
  ], 'D:\\repo');
  assert.deepEqual(g.map((x) => x.dir), ['server/lib/', 'C:/elsewhere/', './', 'docs/']);
  assert.deepEqual(g[0].files.map((f) => f.name), ['x.js', 'y.js']);
  assert.equal(g[0].add, 6);
});

test('learning ledger: gaps, guards, memory writes, lessons, measurables, and a stated empty', () => {
  const empty = M.learningLedger({});
  assert.equal(empty.empty, true);
  const l = M.learningLedger({
    gaps: [{ id: 'g1', code: 'x', status: 'pending' }],
    learning: { items: [{ id: 'g1', source: 'gap', rule: '- do X', status: 'pending', title: 'gap' }, { id: 'p1', source: 'gepa', status: 'pending', title: 'proposal' }],
      lessons: [{ lessonId: 'legacy:g1', status: 'active', title: 'L' }] },
    touch: { files: [{ path: 'C:/m/memory/x.md', kind: 'memory', writes: 1 }, { path: 'D:/r/CLAUDE.md', kind: 'file-edit', writes: 1 }, { path: 'D:/r/a.js', kind: 'file-edit', writes: 1 }] },
    fitness: { tracked: 2, byKind: { latency: 2 } },
  });
  assert.equal(l.empty, false);
  assert.equal(l.guards[0].rule, '- do X');
  assert.deepEqual(l.others.map((o) => o.id), ['p1']);
  assert.deepEqual(l.memory.map((m) => [m.name, m.kind]), [['x.md', 'memory'], ['CLAUDE.md', 'instructions']]);
  assert.equal(l.lessons.length, 1);
  assert.deepEqual(l.measurables, [{ kind: 'latency', n: 2 }]);
  assert.equal(M.learningSummaryText(l.summary), '1 gap (1 pending)  1 guard  2 memory writes  1 lesson  2 measurables');
});

test('kind chips filter the feed; search is separate and case-blind', () => {
  const evs = [
    { kind: 'file-edit', lane: 'context', label: 'Edit a.js' },
    { kind: 'command', lane: 'feed', label: 'npm test' },
    { kind: 'skill', lane: 'context', label: 'tdd' },
    { kind: 'agent', lane: 'context', label: 'Explore' },
    { kind: 'git', lane: 'context', label: 'commit: x' },
    { kind: 'done-gate', lane: 'context', label: 'done-gate: pass' },
  ];
  const labels = (chip, q) => M.filterEvents(evs, chip, q).map((e) => e.label);
  assert.deepEqual(labels('context'), ['Edit a.js', 'tdd', 'Explore', 'commit: x']);
  assert.equal(labels('all').length, 5);
  assert.deepEqual(labels('tool'), ['Edit a.js', 'npm test']);
  assert.deepEqual(labels('gate'), ['done-gate: pass']);
  assert.deepEqual(labels('all', 'NPM'), ['npm test']);
  assert.deepEqual(M.KIND_CHIPS, ['context', 'all', 'tool', 'skill', 'agent', 'git', 'gate']);
});

test('back label names the lens, never "grid"', () => {
  assert.equal(M.backLabel('Work'), '< Work');
  assert.equal(M.backLabel(null), '< Back');
});
