import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectGaps } from '../lib/observability/gap-detect.js';

const edit = (path, op = 'write') => ({ kind: 'file-edit', op, path });
const skill = (label) => ({ kind: 'skill', lane: 'context', label });

test('flags UI edits without ui-density', () => {
  const g = detectGaps([edit('D:\\glmps\\web\\styles.css')], []);
  assert.ok(g.some(x => x.code === 'ui-without-frontend-design'));
});

test('no UI gap when ui-density was used (via skillsUsed)', () => {
  const g = detectGaps([edit('web/app.js')], ['ui-density']);
  assert.ok(!g.some(x => x.code === 'ui-without-frontend-design'));
});

test('no UI gap when ui-density used (via skill event)', () => {
  const g = detectGaps([skill('ui-density'), edit('a.css')], []);
  assert.ok(!g.some(x => x.code === 'ui-without-frontend-design'));
});

test('non-UI edits do not trip the UI gap', () => {
  const g = detectGaps([edit('server/server.js'), edit('readme.md')], []);
  assert.ok(!g.some(x => x.code === 'ui-without-frontend-design'));
});

test('reading a UI file is not an edit', () => {
  const g = detectGaps([edit('web/styles.css', 'read')], []);
  assert.equal(g.length, 0);
});

test('heavy-edits-no-subagents is retired: many edits with no subagents do not flag it', () => {
  const evs = Array.from({ length: 16 }, (_, i) => edit(`src/f${i}.js`));
  const g = detectGaps(evs, []);
  assert.ok(!g.some(x => x.code === 'heavy-edits-no-subagents'));
});

test('empty / malformed input -> no gaps, no throw', () => {
  assert.deepEqual(detectGaps(null, null), []);
  assert.deepEqual(detectGaps([], []), []);
  assert.deepEqual(detectGaps(undefined), []);
});

// ui-design-too-late: ui-density used but after the first UI edit

test('ui-design-too-late: fires when first UI edit precedes first ui-density skill event', () => {
  const evs = [
    { kind: 'file-edit', op: 'write', path: 'web/styles.css', ts: 100 },
    { kind: 'skill', lane: 'context', label: 'ui-density', ts: 200 },
  ];
  const g = detectGaps(evs, []);
  assert.ok(g.some(x => x.code === 'ui-design-too-late'), 'expected ui-design-too-late gap');
});

test('ui-design-too-late: does NOT fire when ui-density precedes first UI edit', () => {
  const evs = [
    { kind: 'skill', lane: 'context', label: 'ui-density', ts: 50 },
    { kind: 'file-edit', op: 'write', path: 'web/styles.css', ts: 200 },
  ];
  const g = detectGaps(evs, []);
  assert.ok(!g.some(x => x.code === 'ui-design-too-late'), 'should not fire when skill came first');
});

test('ui-design-too-late: does NOT fire when no ui-density skill at all (covered by ui-without-frontend-design)', () => {
  const evs = [
    { kind: 'file-edit', op: 'write', path: 'web/styles.css', ts: 100 },
  ];
  const g = detectGaps(evs, []);
  assert.ok(!g.some(x => x.code === 'ui-design-too-late'));
});

test('ui-design-too-late: does NOT fire when no UI edits at all', () => {
  const evs = [
    { kind: 'skill', lane: 'context', label: 'ui-density', ts: 100 },
  ];
  const g = detectGaps(evs, []);
  assert.ok(!g.some(x => x.code === 'ui-design-too-late'));
});

test('ui-design-too-late: works with string ts values', () => {
  const evs = [
    { kind: 'file-edit', op: 'write', path: 'a.css', ts: '2026-01-01T10:00:00Z' },
    { kind: 'skill', lane: 'context', label: 'ui-density', ts: '2026-01-01T11:00:00Z' },
  ];
  const g = detectGaps(evs, []);
  assert.ok(g.some(x => x.code === 'ui-design-too-late'));
});

// reread-loop: same path read more than 8 times

test('reread-loop: fires when a path is read more than 8 times', () => {
  const evs = Array.from({ length: 9 }, () => ({ kind: 'file-edit', op: 'read', path: 'server/lib/gap-detect.js', ts: 1 }));
  const g = detectGaps(evs, []);
  const gap = g.find(x => x.code === 'reread-loop');
  assert.ok(gap, 'expected reread-loop gap');
  assert.match(gap.message, /server\/lib\/gap-detect\.js/);
  assert.match(gap.message, /9/);
});

test('reread-loop: does NOT fire at exactly 8 reads', () => {
  const evs = Array.from({ length: 8 }, () => ({ kind: 'file-edit', op: 'read', path: 'server/lib/gap-detect.js', ts: 1 }));
  const g = detectGaps(evs, []);
  assert.ok(!g.some(x => x.code === 'reread-loop'));
});

test('reread-loop: reports the worst offender (highest count)', () => {
  const evs = [
    ...Array.from({ length: 9 }, () => ({ kind: 'file-edit', op: 'read', path: 'file-a.js', ts: 1 })),
    ...Array.from({ length: 12 }, () => ({ kind: 'file-edit', op: 'read', path: 'file-b.js', ts: 1 })),
  ];
  const g = detectGaps(evs, []);
  const gap = g.find(x => x.code === 'reread-loop');
  assert.ok(gap);
  assert.match(gap.message, /file-b\.js/);
  assert.match(gap.message, /12/);
});

// done-without-verification: >= 15 non-read edits, no verification-before-completion

test('done-without-verification: fires at or above HEAVY_EDIT_THRESHOLD with no verification skill', () => {
  const evs = Array.from({ length: 15 }, (_, i) => ({ kind: 'file-edit', op: 'write', path: `f${i}.js`, ts: 1 }));
  const g = detectGaps(evs, []);
  assert.ok(g.some(x => x.code === 'done-without-verification'));
});

test('done-without-verification: does NOT fire when verification-before-completion skill event present', () => {
  const evs = [
    ...Array.from({ length: 15 }, (_, i) => ({ kind: 'file-edit', op: 'write', path: `f${i}.js`, ts: 1 })),
    { kind: 'skill', lane: 'context', label: 'superpowers:verification-before-completion', ts: 2 },
  ];
  const g = detectGaps(evs, []);
  assert.ok(!g.some(x => x.code === 'done-without-verification'));
});

test('done-without-verification: does NOT fire when verification-before-completion in skillsUsed', () => {
  const evs = Array.from({ length: 15 }, (_, i) => ({ kind: 'file-edit', op: 'write', path: `f${i}.js`, ts: 1 }));
  const g = detectGaps(evs, ['superpowers:verification-before-completion']);
  assert.ok(!g.some(x => x.code === 'done-without-verification'));
});

test('done-without-verification: does NOT fire below threshold (14 edits)', () => {
  const evs = Array.from({ length: 14 }, (_, i) => ({ kind: 'file-edit', op: 'write', path: `f${i}.js`, ts: 1 }));
  const g = detectGaps(evs, []);
  assert.ok(!g.some(x => x.code === 'done-without-verification'));
});

// plan-skipped-on-large-change: 3+ distinct files edited without brainstorming/writing-plans

test('flags >=3-file change with no brainstorming/writing-plans', () => {
  const events = [
    { kind: 'file-edit', op: 'write', path: 'a.py' },
    { kind: 'file-edit', op: 'write', path: 'b.py' },
    { kind: 'file-edit', op: 'write', path: 'c.py' },
  ];
  const gaps = detectGaps(events, []);
  assert.ok(gaps.some(g => g.code === 'plan-skipped-on-large-change'));
  // not flagged when a planning skill ran
  assert.ok(!detectGaps(events, ['superpowers:brainstorming']).some(g => g.code === 'plan-skipped-on-large-change'));
  assert.ok(!detectGaps(events, ['writing-plans']).some(g => g.code === 'plan-skipped-on-large-change'));
  // not flagged under 3 distinct files (repeat edits to one file don't count)
  const small = [
    { kind: 'file-edit', op: 'write', path: 'a.py' },
    { kind: 'file-edit', op: 'write', path: 'a.py' },
    { kind: 'file-edit', op: 'write', path: 'b.py' },
  ];
  assert.ok(!detectGaps(small, []).some(g => g.code === 'plan-skipped-on-large-change'));
});

// deferred-followup: an implementation plan was written AND a source:'deferred'
// backlog ticket was filed in the same session (the in-scope-follow-up that
// should have been folded into the plan instead of ticketed). detectGaps only
// receives the shared event shape (events, skillsUsed) - it never sees the raw
// POST body or lastText, so the only honest signal for "filed a deferred
// backlog ticket" here is a 'command' event (Bash/shell) whose text names both
// the backlog endpoint and a deferred ticket, per the documented convention
// `POST /api/backlog {source:'deferred', title, prompt}`.

test('deferred-followup: fires when a plan is written and a deferred backlog ticket is filed', () => {
  const evs = [
    { kind: 'file-edit', op: 'write', path: 'docs/superpowers/plans/2026-07-23-thing.md', ts: 1 },
    {
      kind: 'command', tool: 'Bash', ts: 2,
      label: 'curl -X POST http://127.0.0.1:8123/api/backlog -d \'{"source":"deferred","title":"follow-up"}\'',
    },
  ];
  const g = detectGaps(evs, []);
  assert.ok(g.some(x => x.code === 'deferred-followup'), 'expected deferred-followup gap');
});

test('deferred-followup: does NOT fire with only a plan write', () => {
  const evs = [
    { kind: 'file-edit', op: 'write', path: 'docs/superpowers/plans/2026-07-23-thing.md', ts: 1 },
  ];
  const g = detectGaps(evs, []);
  assert.ok(!g.some(x => x.code === 'deferred-followup'));
});

test('deferred-followup: does NOT fire with only a deferred backlog ticket filing (no plan written)', () => {
  const evs = [
    { kind: 'command', tool: 'Bash', ts: 1, label: 'File a deferred backlog ticket for the retry logic' },
  ];
  const g = detectGaps(evs, []);
  assert.ok(!g.some(x => x.code === 'deferred-followup'));
});

test('deferred-followup: a backlog command without "deferred" does not fire', () => {
  const evs = [
    { kind: 'file-edit', op: 'write', path: 'docs/superpowers/plans/2026-07-23-thing.md', ts: 1 },
    { kind: 'command', tool: 'Bash', ts: 2, label: 'check backlog board status' },
  ];
  const g = detectGaps(evs, []);
  assert.ok(!g.some(x => x.code === 'deferred-followup'));
});

test('deferred-followup: a plan read (not written) does not count as writing the plan', () => {
  const evs = [
    { kind: 'file-edit', op: 'read', path: 'docs/superpowers/plans/2026-07-23-thing.md', ts: 1 },
    { kind: 'command', tool: 'Bash', ts: 2, label: 'POST a deferred ticket to /api/backlog for the retry logic' },
  ];
  const g = detectGaps(evs, []);
  assert.ok(!g.some(x => x.code === 'deferred-followup'));
});

test('a Pocock design skill counts as design for the 3-file rule', () => {
  const events = [edit('a.py'), edit('b.py'), edit('c.py')];
  for (const s of ['grilling', 'to-spec', 'to-tickets']) {
    assert.ok(!detectGaps(events, [s]).some(g => g.code === 'plan-skipped-on-large-change'), s);
  }
});

test('done-without-verification: a test or build command after the edits counts as verification', () => {
  const edits = Array.from({ length: 15 }, (_, i) => ({ kind: 'file-edit', op: 'write', path: `f${i}.js`, ts: 1 }));
  assert.ok(!detectGaps([...edits, { kind: 'command', label: 'npm test', ts: 2 }], []).some(x => x.code === 'done-without-verification'));
  assert.ok(detectGaps([{ kind: 'command', label: 'npm test', ts: 0 }, ...edits], []).some(x => x.code === 'done-without-verification'),
    'a test run BEFORE the edits proves nothing about them');
});

test('a spec written under docs/specs counts as a written plan for the deferral check', () => {
  const evs = [
    { kind: 'file-edit', op: 'write', path: 'docs/specs/2026-10-17-x.md' },
    { kind: 'command', label: 'curl -X POST http://127.0.0.1:8123/api/backlog -d \'{"source":"deferred","title":"x"}\'' },
  ];
  const plain = [
    { kind: 'file-edit', op: 'write', path: 'docs/superpowers/plans/2026-10-17-x.md' },
    evs[1],
  ];
  const a = detectGaps(evs, []).some(g => g.code === 'deferred-followup');
  const b = detectGaps(plain, []).some(g => g.code === 'deferred-followup');
  assert.ok(b, 'the old plans folder still counts');
  assert.ok(a, 'docs/specs counts the same way');
});

test('frontend-design no longer satisfies the UI gap (replaced by the vendored UI skills)', () => {
  const g = detectGaps([skill('frontend-design'), edit('a.css')], []);
  assert.ok(g.some(x => x.code === 'ui-without-frontend-design'));
});

test('each look-and-feel skill satisfies the UI gap', () => {
  for (const s of ['modular-scale-typography', 'visual-emphasis-and-hierarchy', 'color-mode-and-theme', 'algorithmic-color-palette', 'operational-expert-tool-ui']) {
    const g = detectGaps([skill(s), edit('a.css')], []);
    assert.ok(!g.some(x => x.code === 'ui-without-frontend-design'), s);
  }
});
