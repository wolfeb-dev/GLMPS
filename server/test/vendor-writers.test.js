// server/test/vendor-writers.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPORTED_VENDORS,
  MANAGED_BEGIN,
  MANAGED_END,
  MEMORY_MANAGED_BEGIN,
  MEMORY_MANAGED_END,
  renderPolicyBody,
  renderMemoryBody,
  selectPushTargets,
  wrapManaged,
  extractManagedSection,
  mergeManagedSection,
  validatePolicyUpdate,
  applyPush,
} from '../lib/governance/vendor-writers.js';


test('renderPolicyBody: only enabled items included', () => {
  const policy = [
    { id: 'a', text: 'Rule A', enabled: true },
    { id: 'b', text: 'Rule B', enabled: false },
    { id: 'c', text: 'Rule C', enabled: true },
  ];
  const body = renderPolicyBody(policy, { vendor: 'claude-code' });
  assert.ok(body.includes('Rule A'));
  assert.ok(!body.includes('Rule B'));
  assert.ok(body.includes('Rule C'));
});

test('renderPolicyBody: items in declaration order', () => {
  const policy = [
    { id: 'z', text: 'Z rule', enabled: true },
    { id: 'a', text: 'A rule', enabled: true },
  ];
  const body = renderPolicyBody(policy, { vendor: 'claude-code' });
  assert.ok(body.indexOf('Z rule') < body.indexOf('A rule'));
});

test('renderPolicyBody: mdc format includes Cursor frontmatter', () => {
  const policy = [{ id: 'x', text: 'No shadow AI', enabled: true }];
  const body = renderPolicyBody(policy, { vendor: 'cursor' });
  assert.ok(body.startsWith('---\ndescription: GLMPS guardrails\nalwaysApply: true\n---'));
  assert.ok(body.includes('## AI Guardrails'));
  assert.ok(body.includes('No shadow AI'));
});

test('renderPolicyBody: md format has no frontmatter', () => {
  const policy = [{ id: 'x', text: 'No shadow AI', enabled: true }];
  const body = renderPolicyBody(policy, { vendor: 'claude-code' });
  assert.ok(!body.includes('---'));
  assert.ok(body.includes('## AI Guardrails'));
});

test('renderPolicyBody: wraps the guardrails in the do-not-edit notice', () => {
  const body = renderPolicyBody([{ id: 'a', text: 'Rule A', enabled: true }], { vendor: 'claude-code' });
  assert.ok(body.includes('Do not edit this section'), 'has the top notice');
  assert.ok(body.includes('Do not edit above this line'), 'has the bottom notice');
  // Notice brackets the rules: top before, bottom after.
  assert.ok(body.indexOf('Do not edit this section') < body.indexOf('Rule A'));
  assert.ok(body.indexOf('Rule A') < body.indexOf('Do not edit above this line'));
});

test('renderPolicyBody: empty policy produces empty bullet list', () => {
  const body = renderPolicyBody([], { vendor: 'agents' });
  assert.ok(body.includes('## AI Guardrails'));
});

test('renderPolicyBody: items without enabled field default to enabled', () => {
  const policy = [{ id: 'a', text: 'Rule A' }]; // no enabled field
  const body = renderPolicyBody(policy, { vendor: 'claude-code' });
  assert.ok(body.includes('Rule A'));
});


test('wrapManaged produces BEGIN and END markers', () => {
  const wrapped = wrapManaged('hello');
  assert.ok(wrapped.includes(MANAGED_BEGIN));
  assert.ok(wrapped.includes(MANAGED_END));
  assert.ok(wrapped.includes('hello'));
});

test('extractManagedSection round-trips with wrapManaged', () => {
  const body = '## AI Guardrails\n\n- Rule one\n- Rule two';
  assert.equal(extractManagedSection(wrapManaged(body)), body);
});

test('extractManagedSection: returns null when no markers', () => {
  assert.equal(extractManagedSection('no markers here'), null);
  assert.equal(extractManagedSection(''), null);
  assert.equal(extractManagedSection(null), null);
});

test('extractManagedSection: returns null when BEGIN present but END absent', () => {
  assert.equal(extractManagedSection(MANAGED_BEGIN + '\nbody'), null);
});

test('extractManagedSection: extracts body within surrounding content', () => {
  const existing = `# Preamble\n\n${wrapManaged('managed body')}\n\n# Suffix`;
  assert.equal(extractManagedSection(existing), 'managed body');
});


test('mergeManagedSection: inserts block when file is empty', () => {
  const result = mergeManagedSection('', 'body');
  assert.ok(result.includes(MANAGED_BEGIN));
  assert.ok(result.includes('body'));
  assert.ok(result.includes(MANAGED_END));
});

test('mergeManagedSection: inserts block when file is whitespace-only', () => {
  const result = mergeManagedSection('   \n  ', 'body');
  assert.ok(result.includes(MANAGED_BEGIN));
});

test('mergeManagedSection: appends when existing content has no markers', () => {
  const existing = '# Existing content\n\nSome text.';
  const result = mergeManagedSection(existing, 'body');
  assert.ok(result.startsWith('# Existing content'));
  assert.ok(result.includes(MANAGED_BEGIN));
  assert.ok(result.includes('body'));
});

test('mergeManagedSection: replaces existing managed section', () => {
  const existing = `# Preamble\n\n${wrapManaged('old body')}\n\n# Suffix\n`;
  const result = mergeManagedSection(existing, 'new body');
  assert.ok(result.includes('new body'));
  assert.ok(!result.includes('old body'));
  assert.ok(result.includes('# Preamble'));
  assert.ok(result.includes('# Suffix'));
});

test('mergeManagedSection: preserves content before and after the managed block', () => {
  const before = '# Header\n\nText before.\n\n';
  const after  = '\n\n# Footer\n\nText after.\n';
  const existing = before + wrapManaged('old') + after;
  const result = mergeManagedSection(existing, 'new');
  assert.ok(result.startsWith('# Header'));
  assert.ok(result.includes('# Footer'));
  assert.ok(result.includes('new'));
  assert.ok(!result.includes('old'));
});

test('mergeManagedSection: idempotent (merge twice === merge once)', () => {
  // Scenario 1: empty file
  const once = mergeManagedSection('', 'body');
  const twice = mergeManagedSection(once, 'body');
  assert.equal(twice, once);

  // Scenario 2: file with pre-existing content
  const existing = '# Preamble\n\nSome text.';
  const m1 = mergeManagedSection(existing, 'body');
  const m2 = mergeManagedSection(m1, 'body');
  assert.equal(m2, m1);

  // Scenario 3: file already has managed section with same body
  const alreadyManaged = wrapManaged('body') + '\n';
  const m3 = mergeManagedSection(alreadyManaged, 'body');
  assert.equal(m3, alreadyManaged);
});


test('validatePolicyUpdate: valid body passes', () => {
  const result = validatePolicyUpdate({
    policy: [{ id: 'no-shadow', text: 'No shadow AI', enabled: true }],
    targets: [{ vendor: 'claude-code', path: 'CLAUDE.md' }],
  }, { repoRoot: '/repo' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validatePolicyUpdate: rejects empty text', () => {
  const result = validatePolicyUpdate({
    policy: [{ id: 'x', text: '', enabled: true }],
    targets: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.includes('text')));
});

test('validatePolicyUpdate: rejects unknown vendor', () => {
  const result = validatePolicyUpdate({
    policy: [],
    targets: [{ vendor: 'vscode', path: 'vscode.md' }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.includes('vendor')));
});

test('validatePolicyUpdate: rejects path with ..', () => {
  const result = validatePolicyUpdate({
    policy: [],
    targets: [{ vendor: 'claude-code', path: '../outside/CLAUDE.md' }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.includes('..')));
});

test('validatePolicyUpdate: rejects absolute path', () => {
  const result = validatePolicyUpdate({
    policy: [],
    targets: [{ vendor: 'claude-code', path: '/etc/CLAUDE.md' }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.toLowerCase().includes('absolute') || e.includes('relative')));
});

test('validatePolicyUpdate: rejects duplicate ids', () => {
  const result = validatePolicyUpdate({
    policy: [
      { id: 'dupe', text: 'First', enabled: true },
      { id: 'dupe', text: 'Second', enabled: true },
    ],
    targets: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.includes('duplicate')));
});


const allowGuard = () => ({ allowed: true });
const denyGuard  = (reason) => () => ({ allowed: false, reason });

test('applyPush: creates file when it does not exist', () => {
  const fs = new Map();
  const results = applyPush({
    targets: [{ vendor: 'claude-code', path: 'CLAUDE.md' }],
    policy:  [{ id: 'a', text: 'Rule A', enabled: true }],
    readFile: p => fs.get(p) ?? '',
    exists:   p => fs.has(p),
    guard:    allowGuard,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].action, 'created');
  assert.ok(results[0].content.includes('Rule A'));
  assert.ok(typeof results[0].managedBody === 'string');
});

test('applyPush: updates file when managed section changes', () => {
  const existing = `# Existing\n\n${wrapManaged('old body')}\n`;
  const fs = new Map([['CLAUDE.md', existing]]);
  const results = applyPush({
    targets: [{ vendor: 'claude-code', path: 'CLAUDE.md' }],
    policy:  [{ id: 'a', text: 'New Rule', enabled: true }],
    readFile: p => fs.get(p),
    exists:   p => fs.has(p),
    guard:    allowGuard,
  });
  assert.equal(results[0].action, 'updated');
  assert.ok(results[0].content.includes('New Rule'));
  assert.ok(results[0].content.includes('# Existing'));
});

test('applyPush: unchanged when policy already matches', () => {
  const policy = [{ id: 'a', text: 'Rule A', enabled: true }];
  // Simulate a first push
  const body = renderPolicyBody(policy, { vendor: 'claude-code' });
  const firstContent = mergeManagedSection('', body);
  const fs = new Map([['CLAUDE.md', firstContent]]);

  const results = applyPush({
    targets: [{ vendor: 'claude-code', path: 'CLAUDE.md' }],
    policy,
    readFile: p => fs.get(p),
    exists:   p => fs.has(p),
    guard:    allowGuard,
  });
  assert.equal(results[0].action, 'unchanged');
});

test('applyPush: skipped when guard denies', () => {
  const results = applyPush({
    targets: [{ vendor: 'claude-code', path: 'CLAUDE.md' }],
    policy:  [{ id: 'a', text: 'Rule A', enabled: true }],
    readFile: () => '',
    exists:   () => false,
    guard:    denyGuard('secret file'),
  });
  assert.equal(results[0].action, 'skipped');
  assert.equal(results[0].reason, 'secret file');
  assert.equal(results[0].content, undefined);
});

test('applyPush: idempotent - second push with same policy yields all unchanged', () => {
  const policy = [
    { id: 'a', text: 'No shadow AI', enabled: true },
    { id: 'b', text: 'Use sanctioned tools', enabled: true },
  ];
  const targets = [
    { vendor: 'claude-code', path: 'CLAUDE.md' },
    { vendor: 'agents',      path: 'AGENTS.md' },
  ];

  // First push (simulate a real in-memory fs)
  const store = new Map();
  const push = () => applyPush({
    targets, policy,
    readFile: p => store.get(p) ?? '',
    exists:   p => store.has(p),
    guard:    allowGuard,
  });

  const first = push();
  for (const r of first) {
    if (r.content !== undefined) store.set(r.path, r.content);
  }
  assert.ok(first.every(r => r.action === 'created'));

  // Second push - same policy
  const second = push();
  assert.ok(second.every(r => r.action === 'unchanged'),
    `Expected all unchanged, got: ${second.map(r => r.action).join(', ')}`);

  // Third push (after manual edit outside managed section)
  const current = store.get('CLAUDE.md');
  store.set('CLAUDE.md', '# Manual addition\n\n' + current);
  const third = push();
  const claudeResult = third.find(r => r.path === 'CLAUDE.md');
  // The managed section is unchanged, but surrounding content changed
  // mergeManagedSection sees identical managed body -> 'unchanged' still
  assert.equal(claudeResult.action, 'unchanged');
});

test('applyPush: returns managedBody for caller to hash', () => {
  const policy = [{ id: 'a', text: 'Rule', enabled: true }];
  const results = applyPush({
    targets: [{ vendor: 'claude-code', path: 'CLAUDE.md' }],
    policy,
    readFile: () => '',
    exists:   () => false,
    guard:    allowGuard,
  });
  assert.ok(results[0].managedBody);
  assert.equal(results[0].managedBody, renderPolicyBody(policy, { vendor: 'claude-code' }));
});


test('wrapManaged/extractManagedSection/mergeManagedSection accept custom markers', () => {
  const custom = { begin: '<!-- X:BEGIN -->', end: '<!-- X:END -->' };
  const wrapped = wrapManaged('hello', custom);
  assert.ok(wrapped.startsWith(custom.begin));
  assert.equal(extractManagedSection(wrapped, custom), 'hello');
  const merged = mergeManagedSection('existing text', 'hello', custom);
  assert.ok(merged.includes(custom.begin));
  assert.ok(merged.includes('existing text'));
});

test('default markers unchanged when no options passed (backward compat)', () => {
  const wrapped = wrapManaged('hello');
  assert.ok(wrapped.startsWith(MANAGED_BEGIN));
  assert.equal(extractManagedSection(wrapped), 'hello');
});

test('memory and guardrail managed sections coexist in one file without colliding', () => {
  const withGuardrails = mergeManagedSection('', 'guardrail rules');
  const withBoth = mergeManagedSection(withGuardrails, 'memory facts', { begin: MEMORY_MANAGED_BEGIN, end: MEMORY_MANAGED_END });
  assert.equal(extractManagedSection(withBoth), 'guardrail rules');
  assert.equal(extractManagedSection(withBoth, { begin: MEMORY_MANAGED_BEGIN, end: MEMORY_MANAGED_END }), 'memory facts');
});

test('renderMemoryBody: renders an INDEX (name + description), never the full body', () => {
  // The corpus is distributed as an index, mirroring how MEMORY.md itself works:
  // one line per fact, full text fetched on demand. Inlining every body put 226KB
  // into a 7.9KB CLAUDE.md when this was first fed against the real memory dir.
  const entries = [{ name: 'a-fact', description: 'desc', body: 'the full body text' }];
  const body = renderMemoryBody(entries, { vendor: 'claude-code' });
  assert.ok(body.includes('a-fact'));
  assert.ok(body.includes('desc'));
  assert.ok(!body.includes('the full body text'), 'full body must NOT be inlined');
  assert.ok(body.includes('Do not edit this section'));
});

test('renderMemoryBody: one line per entry', () => {
  const entries = [
    { name: 'fact-one', description: 'first', body: 'x'.repeat(5000) },
    { name: 'fact-two', description: 'second', body: 'y'.repeat(5000) },
  ];
  const body = renderMemoryBody(entries, { vendor: 'claude-code' });
  const lines = body.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('fact-one') && lines[0].includes('first'));
  assert.ok(lines[1].includes('fact-two') && lines[1].includes('second'));
  assert.ok(body.length < 2000, `index must stay small, got ${body.length} bytes`);
});

test('renderMemoryBody: multi-line description collapses to one line', () => {
  const entries = [{ name: 'n', description: 'line one\nline two\n\nline three', body: 'b' }];
  const body = renderMemoryBody(entries, { vendor: 'claude-code' });
  const lines = body.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('line one line two line three'));
});

test('renderMemoryBody: entry with no description still renders its name', () => {
  const body = renderMemoryBody([{ name: 'bare-fact', body: 'b' }], { vendor: 'claude-code' });
  const lines = body.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('bare-fact'));
});

test('renderMemoryBody: empty list renders the placeholder, not an empty index', () => {
  const body = renderMemoryBody([], { vendor: 'claude-code' });
  assert.ok(body.includes('_(no shared memory yet)_'));
  assert.equal(body.split('\n').filter((l) => l.startsWith('- ')).length, 0);
});

test('renderMemoryBody: mdc format for cursor', () => {
  const body = renderMemoryBody([{ name: 'x', description: 'd', body: 'b' }], { vendor: 'cursor' });
  assert.ok(body.startsWith('---\ndescription: GLMPS cross-agent memory'));
});

test('applyPush: render/begin/end are overridable for a non-guardrail managed section', () => {
  const entries = [{ name: 'shared-fact', description: 'd', body: 'b' }];
  const results = applyPush({
    targets: [{ vendor: 'claude-code', path: 'CLAUDE.md' }],
    items: entries,
    render: renderMemoryBody,
    begin: MEMORY_MANAGED_BEGIN, end: MEMORY_MANAGED_END,
    readFile: () => '', exists: () => false, guard: () => ({ allowed: true }),
  });
  assert.equal(results[0].action, 'created');
  assert.ok(results[0].content.includes(MEMORY_MANAGED_BEGIN));
  assert.ok(results[0].content.includes('shared-fact'));
});


test('selectPushTargets: no argument writes every vendor (the shipped default)', () => {
  const { targets, unknown } = selectPushTargets();
  assert.deepEqual(unknown, []);
  assert.ok(targets.some(t => t.path === 'CLAUDE.md'));
  assert.ok(targets.some(t => t.path === 'GEMINI.md'));
});

test('selectPushTargets: de-duplicates by PATH (agents + codex both target AGENTS.md)', () => {
  // Both were written in sequence against the pre-write file, so the second
  // silently overwrote the first. Harmless while the renderers agree, a footgun
  // the moment they diverge.
  const paths = selectPushTargets().targets.map(t => t.path);
  assert.equal(new Set(paths).size, paths.length, 'no path written twice');
  assert.equal(paths.filter(p => p === 'AGENTS.md').length, 1);
});

test('selectPushTargets: a list narrows the push', () => {
  const { targets } = selectPushTargets(['gemini', 'agents']);
  assert.deepEqual(targets.map(t => t.path).sort(), ['AGENTS.md', 'GEMINI.md']);
  assert.ok(!targets.some(t => t.path === 'CLAUDE.md'), 'claude-code is skippable');
});

test('selectPushTargets: an unknown vendor is reported, not silently dropped', () => {
  const { targets, unknown } = selectPushTargets(['gemini', 'nope']);
  assert.deepEqual(unknown, ['nope']);
  assert.equal(targets.length, 1);
});

test('selectPushTargets: an empty array means "unspecified", so all vendors', () => {
  assert.equal(selectPushTargets([]).targets.length, selectPushTargets().targets.length);
});
