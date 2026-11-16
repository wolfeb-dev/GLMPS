// server/test/analytics-calc.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cwdLastSeg,
  modelKey,
  rowTokens,
  maxOf,
  groupByModel,
  groupByProject,
  donutArcs,
  heatBuckets,
  graphifySavings,
  perToolRows,
} from '../../web/observability/analytics-calc.js';

test('perToolRows converts byTool map into ranked rows sorted by tokens desc', () => {
  const byTool = {
    'claude-code': { costUsd: 5, credits: 0, inputTokens: 500, outputTokens: 50, cacheCreateTokens: 0, avgLatencyMs: null, sessions: 1, days: 1 },
    'copilot-cli': { costUsd: 0, credits: 2, inputTokens: 3000, outputTokens: 60, cacheCreateTokens: 100, avgLatencyMs: 1500, sessions: 2, days: 1 },
  };
  const rows = perToolRows(byTool);
  assert.equal(rows.length, 2);
  // copilot-cli has more tokens -> first
  assert.equal(rows[0].key, 'copilot-cli');
  assert.equal(rows[0].tokens, 3160);           // 3000 + 60 + 100
  assert.equal(rows[0].credits, 2);
  assert.equal(rows[0].avgLatencyMs, 1500);
  assert.equal(rows[0].costUsd, 0);
  assert.equal(rows[0].sessions, 2);
  assert.equal(rows[1].key, 'claude-code');
  assert.equal(rows[1].tokens, 550);
});

test('perToolRows tolerates empty / missing byTool', () => {
  assert.deepEqual(perToolRows(undefined), []);
  assert.deepEqual(perToolRows({}), []);
});

test('cwdLastSeg handles forward/back slashes and trailing separators', () => {
  assert.equal(cwdLastSeg('D:\\glmps'), 'glmps');
  assert.equal(cwdLastSeg('/home/u/proj/'), 'proj');
  assert.equal(cwdLastSeg('C:/a/b/c\\d'), 'd');
  assert.equal(cwdLastSeg(''), '');
  assert.equal(cwdLastSeg(null), '');
  assert.equal(cwdLastSeg(undefined), '');
});

test('modelKey coarsens model strings to a tier key', () => {
  assert.equal(modelKey('claude-opus-4-8[1m]'), 'opus');
  assert.equal(modelKey('Opus 4.8 (1M context)'), 'opus');
  assert.equal(modelKey('claude-3-5-sonnet'), 'sonnet');
  assert.equal(modelKey('Haiku'), 'haiku');
  assert.equal(modelKey(''), 'unknown');
  assert.equal(modelKey(null), 'unknown');
  assert.equal(modelKey(42), 'unknown');
});

test('modelKey strips a trailing parenthetical for non-tier models', () => {
  assert.equal(modelKey('gpt-4o (preview)'), 'gpt-4o');
});

test('rowTokens sums the four token figures, treating missing as 0', () => {
  assert.equal(rowTokens({ input: 10, output: 20, cacheRead: 5, cacheCreate: 1 }), 36);
  assert.equal(rowTokens({ input: 10 }), 10);
  assert.equal(rowTokens({}), 0);
  assert.equal(rowTokens(null), 0);
});

test('maxOf returns the largest value of a key', () => {
  assert.equal(maxOf([{ c: 3 }, { c: 9 }, { c: 1 }], 'c'), 9);
  assert.equal(maxOf([], 'c'), 0);
  assert.equal(maxOf([{ c: -2 }, {}], 'c'), 0);
});

test('maxOf accepts an accessor function', () => {
  assert.equal(maxOf([{ a: 1 }, { a: 4 }], (x) => x.a * 2), 8);
});

const perSession = [
  { sid: 's1', model: 'claude-opus-4-8[1m]', costUsd: 2.0, input: 100, output: 50, cacheRead: 10, cacheCreate: 5, cwd: 'D:\\glmps', lastTs: 1 },
  { sid: 's2', model: 'Opus 4.8 (1M context)', costUsd: 1.0, input: 40, output: 20, cacheRead: 0, cacheCreate: 0, cwd: 'D:\\glmps', lastTs: 2 },
  { sid: 's3', model: 'claude-3-5-sonnet', costUsd: 3.0, input: 60, output: 30, cacheRead: 2, cacheCreate: 1, cwd: '/home/u/other', lastTs: 3 },
];

test('groupByModel collapses tiers and sorts by cost desc, tokens tie-break', () => {
  const g = groupByModel(perSession);
  // opus cost 3.0 (tokens 225) ties sonnet cost 3.0 (tokens 93) -> opus wins on tokens
  assert.deepEqual(g.map((x) => x.key), ['opus', 'sonnet']);
  const opus = g.find((x) => x.key === 'opus');
  assert.equal(opus.sessions, 2);
  assert.equal(opus.costUsd, 3.0);
  assert.equal(opus.input, 140);
  assert.equal(opus.output, 70);
  assert.equal(opus.tokens, 100 + 50 + 10 + 5 + 40 + 20);
});

test('groupByModel returns [] for empty/invalid input', () => {
  assert.deepEqual(groupByModel([]), []);
  assert.deepEqual(groupByModel(null), []);
  assert.deepEqual(groupByModel(undefined), []);
});

test('groupByProject keys by cwd last segment and sorts by cost desc, tokens tie-break', () => {
  const g = groupByProject(perSession);
  // glmps cost 3.0 (tokens 225) ties other cost 3.0 (tokens 93) -> mc wins on tokens
  assert.deepEqual(g.map((x) => x.key), ['glmps', 'other']);
  const mc = g.find((x) => x.key === 'glmps');
  assert.equal(mc.sessions, 2);
  assert.equal(mc.costUsd, 3.0);
});

test('groupByProject buckets missing cwd under (unknown)', () => {
  const g = groupByProject([{ sid: 'x', costUsd: 1, cwd: '' }]);
  assert.equal(g.length, 1);
  assert.equal(g[0].key, '(unknown)');
});

// A worktree-isolated session's cwd last-segment ("session-abc123") would
// otherwise fragment into its own bogus project row (glmps-71 task A3). When
// the row carries a stamped worktree.parent, group under that instead.
test('groupByProject groups a worktree session under worktree.parent, not its cwd last segment', () => {
  const rows = [
    { sid: 's1', costUsd: 1, cwd: 'D:\\glmps', lastTs: 1 },
    {
      sid: 's2', costUsd: 2, cwd: 'D:\\state\\runner\\worktrees\\glmps\\session-abc123',
      worktree: { branch: 'session/glmps/abc123', parent: 'glmps' }, lastTs: 2,
    },
  ];
  const g = groupByProject(rows);
  assert.deepEqual(g.map((x) => x.key), ['glmps']);
  assert.equal(g[0].sessions, 2);
  assert.equal(g[0].costUsd, 3);
});

test('groupByProject ignores a malformed worktree field and falls back to cwd', () => {
  const g = groupByProject([{ sid: 'x', costUsd: 1, cwd: 'D:/proj', worktree: { branch: 'b' } }]);
  assert.equal(g[0].key, 'proj');
});

test('donutArcs returns three segments with correct fractions', () => {
  const arcs = donutArcs({ input: 50, output: 25, cacheRead: 15, cacheCreate: 10 });
  assert.equal(arcs.length, 3);
  assert.deepEqual(arcs.map((a) => a.key), ['input', 'output', 'cache']);
  // total = 100; cache = 15+10 = 25
  assert.equal(arcs[0].fraction, 0.5);
  assert.equal(arcs[1].fraction, 0.25);
  assert.equal(arcs[2].fraction, 0.25);
  // Each non-zero segment yields a non-empty path
  for (const a of arcs) assert.ok(a.d.length > 0, `segment ${a.key} should have a path`);
});

test('donutArcs path commands are well-formed (M/A/L/Z)', () => {
  const arcs = donutArcs({ input: 50, output: 50, cacheRead: 0, cacheCreate: 0 });
  const inputSeg = arcs.find((a) => a.key === 'input');
  assert.match(inputSeg.d, /^M /);
  assert.match(inputSeg.d, / A /);
  assert.match(inputSeg.d, /Z/);
  // Numbers only - no NaN should leak into the path
  assert.ok(!/NaN/.test(inputSeg.d));
});

test('donutArcs handles all-zero with empty paths and zero fractions', () => {
  const arcs = donutArcs({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  assert.equal(arcs.length, 3);
  for (const a of arcs) {
    assert.equal(a.fraction, 0);
    assert.equal(a.d, '');
  }
});

test('donutArcs handles a single full segment by splitting the sweep', () => {
  const arcs = donutArcs({ input: 100, output: 0, cacheRead: 0, cacheCreate: 0 });
  const inputSeg = arcs.find((a) => a.key === 'input');
  assert.equal(inputSeg.fraction, 1);
  // Full circle: path is split into two arc bands -> two M commands
  const mCount = (inputSeg.d.match(/M /g) || []).length;
  assert.equal(mCount, 2);
  assert.ok(!/NaN/.test(inputSeg.d));
  // Empty segments stay empty
  assert.equal(arcs.find((a) => a.key === 'output').d, '');
});

test('donutArcs respects custom geometry options', () => {
  const arcs = donutArcs({ input: 1, output: 1, cacheRead: 0, cacheCreate: 0 }, { cx: 30, cy: 30, radius: 20, thickness: 6 });
  const seg = arcs.find((a) => a.key === 'input');
  assert.ok(seg.d.length > 0);
  assert.ok(!/NaN/.test(seg.d));
});

test('heatBuckets assigns 4 levels by quartile of max and 0 for empty days', () => {
  const heatmap = [
    { date: '2026-06-01', count: 0 },
    { date: '2026-06-02', count: 2 },   // 2/8 = .25 -> level 1
    { date: '2026-06-03', count: 3 },   // .375 -> level 2
    { date: '2026-06-04', count: 5 },   // .625 -> level 3
    { date: '2026-06-05', count: 8 },   // 1.0 -> level 4
  ];
  const b = heatBuckets(heatmap);
  assert.deepEqual(b.map((x) => x.level), [0, 1, 2, 3, 4]);
  // preserves date + count
  assert.equal(b[4].date, '2026-06-05');
  assert.equal(b[4].count, 8);
});

test('heatBuckets is all-zero level when there is no activity', () => {
  const b = heatBuckets([{ date: 'd1', count: 0 }, { date: 'd2', count: 0 }]);
  assert.deepEqual(b.map((x) => x.level), [0, 0]);
});

test('heatBuckets handles empty/invalid input', () => {
  assert.deepEqual(heatBuckets([]), []);
  assert.deepEqual(heatBuckets(null), []);
});

test('graphifySavings estimates tokens saved across graphs with defaults', () => {
  // defaults: tokensPerSourceNode=90, tokensPerGraphNode=12
  const s = graphifySavings([{ nodes: 1000 }, { nodes: 500 }]);
  assert.equal(s.graphs, 2);
  assert.equal(s.nodes, 1500);
  assert.equal(s.rawTokens, 1500 * 90);     // 135000
  assert.equal(s.graphTokens, 1500 * 12);   // 18000
  assert.equal(s.savedTokens, 135000 - 18000); // 117000
  assert.ok(Math.abs(s.ratio - 13 / 15) < 1e-9); // 117000/135000
});

test('graphifySavings accepts the /api/graph/status payload shape', () => {
  const s = graphifySavings({ graphs: [{ project: 'a', nodes: 200 }] });
  assert.equal(s.graphs, 1);
  assert.equal(s.nodes, 200);
  assert.equal(s.savedTokens, 200 * (90 - 12));
});

test('graphifySavings returns zeros for empty/invalid input', () => {
  for (const v of [[], null, undefined, {}, 42, { graphs: null }]) {
    const s = graphifySavings(v);
    assert.equal(s.graphs, 0);
    assert.equal(s.nodes, 0);
    assert.equal(s.rawTokens, 0);
    assert.equal(s.graphTokens, 0);
    assert.equal(s.savedTokens, 0);
    assert.equal(s.ratio, 0);
  }
});

test('graphifySavings ignores zero/negative/invalid node counts', () => {
  const s = graphifySavings([{ nodes: 100 }, { nodes: 0 }, { nodes: -5 }, { nodes: 'x' }, {}]);
  assert.equal(s.graphs, 1);   // only the nodes:100 graph counts
  assert.equal(s.nodes, 100);
});

test('graphifySavings honors custom per-node token overrides', () => {
  const s = graphifySavings([{ nodes: 10 }], { tokensPerSourceNode: 200, tokensPerGraphNode: 20 });
  assert.equal(s.rawTokens, 2000);
  assert.equal(s.graphTokens, 200);
  assert.equal(s.savedTokens, 1800);
});

test('graphifySavings never reports negative savings', () => {
  // graph representation costs more than the source it indexes -> clamp to 0
  const s = graphifySavings([{ nodes: 10 }], { tokensPerSourceNode: 10, tokensPerGraphNode: 12 });
  assert.equal(s.savedTokens, 0);
  assert.equal(s.ratio, 0);
});

test('actionsMinutesView: meter level follows the alert thresholds, OS split carries multipliers', async () => {
  const { actionsMinutesView } = await import('../../web/observability/analytics-calc.js');
  const base = { month: '2026-10', allowance: 2000, thresholds: [75, 90], updatedTs: 1,
    byOs: { ubuntu: { minutes: 764, billed: 764, multiplier: 1 }, windows: { minutes: 780, billed: 1560, multiplier: 2 } },
    byRepo: [{ repo: 'o/a', billed: 2324 }] };
  const v = actionsMinutesView({ ...base, billed: 2324, usedPercent: 116.2, refusedSince: '2026-10-20T03:05:48Z' });
  assert.equal(v.level, 'error');
  assert.equal(v.pctText, '116%');
  assert.equal(v.fillPct, 100, 'the bar caps at full');
  assert.equal(v.summary, '2,324 of 2,000 billed min');
  assert.equal(v.osLine, 'Ubuntu 764 \u00B7 Windows 780 x2 = 1560');
  assert.equal(v.monthLabel, 'Oct 2026');
  assert.equal(v.resets, 'Resets Nov 1');
  assert.equal(v.refused, 'Jobs refused since Oct 20 03:05 UTC');
  assert.deepEqual(v.repos, [], 'one repo needs no per-repo list');
  assert.equal(actionsMinutesView({ ...base, billed: 1600, usedPercent: 80 }).level, 'warn');
  assert.equal(actionsMinutesView({ ...base, billed: 100, usedPercent: 5 }).level, 'normal');
  assert.equal(actionsMinutesView({ ...base, month: '2026-12', billed: 0, usedPercent: 0 }).resets, 'Resets Jan 1');
  assert.equal(actionsMinutesView({ ...base, billed: 0, usedPercent: 0, updatedTs: null }).measured, false);
  assert.equal(actionsMinutesView({ ...base, billed: 10, usedPercent: 0.5, byRepo: [{ repo: 'o/a', billed: 6 }, { repo: 'o/b', billed: 4 }] }).repos.length, 2);
  assert.equal(actionsMinutesView(null), null);
  assert.equal(actionsMinutesView({ error: 'not found' }), null);
});
