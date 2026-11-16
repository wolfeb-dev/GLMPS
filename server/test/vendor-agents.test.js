import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseModelDirective, normalizeModelField, resolveCardModel, vendorEligibility, vendorEnabled, buildVendorPrompt,
  mergeVendorsConfig, vendorRunVerdict, parseVendorResult, adapterSessionMatcher,
  tabSessionMatcher, vendorTabName, vendorTabCommand, vendorSignalCheck, vendorSummaryText, TAB_VENDORS,
} from '../lib/orchestration/vendor-agents.js';

test('AC-6: tab helpers name the tab, build a paths-only command and gate the finish signal', () => {
  assert.deepEqual([...TAB_VENDORS], ['gemini', 'gpt']);
  assert.equal(vendorTabName('gemini', 'glmps-2-0-9'), 'gemini glmps-2-0-9');
  assert.equal(vendorTabName('gpt;x', 'a b'), 'gptx ab');
  assert.equal(vendorTabCommand({ wrapper: 'D:\\live\\w.mjs', sessionFile: 'S\\runner\\c.vendor-session.json', promptFile: 'S\\runner\\c.prompt.md' }),
    'node "D:\\live\\w.mjs" "S\\runner\\c.vendor-session.json" "S\\runner\\c.prompt.md"');
  assert.throws(() => vendorTabCommand({ wrapper: 'a"b', sessionFile: 's', promptFile: 'p' }), /wrapper/);
  assert.throws(() => vendorTabCommand({ wrapper: 'w', sessionFile: 's\nx', promptFile: 'p' }), /sessionFile/);
  const session = { nonce: 'n'.repeat(32) };
  assert.equal(vendorSignalCheck({ session: null, body: {} }).status, 404);
  assert.equal(vendorSignalCheck({ session, body: { nonce: 'x', event: 'done' } }).status, 403);
  assert.equal(vendorSignalCheck({ session, body: { nonce: session.nonce, event: 'go' } }).status, 400);
  assert.deepEqual(vendorSignalCheck({ session, body: { nonce: session.nonce, event: 'done' } }), { ok: true, status: 202, already: false });
  // F4 (card glmps-2-0-172): a signal during a finish is queued, and a later round after one is a new finish.
  assert.deepEqual(vendorSignalCheck({ session, body: { nonce: session.nonce, event: 'exit' }, finishing: true }), { ok: true, status: 202, already: false, queued: true });
  assert.deepEqual(vendorSignalCheck({ session: { ...session, finishedAt: 1 }, body: { nonce: session.nonce, event: 'done' } }), { ok: true, status: 202, already: false, laterRound: true });
  assert.equal(vendorSummaryText('ok\n\u0007caf\u00e9'), 'ok\n caf ');
  assert.equal(vendorSummaryText('x'.repeat(5000)).length, 4000);
});

test('AC-4: a tab run is matched to its captured sessions by the worktree they touched', () => {
  const events = [
    { sessionId: 'agy:c1', path: 'C:\\wt\\p\\card\\server\\a.js' },
    { sessionId: 'agy:c2', path: 'C:\\other\\b.js' },
    { sessionId: 'codex:x-c3', path: 'C:\\wt\\p\\card\\b.js' },
    { sessionId: 'agy:c4', path: 'C:\\wt\\p\\card-2\\b.js' },
  ];
  const m = tabSessionMatcher('gemini', events, 'C:\\wt\\p\\card');
  assert.deepEqual(['agy:c1', 'agy:c2', 'codex:x-c3', 'agy:c4'].filter(m), ['agy:c1']);
  assert.equal(tabSessionMatcher('claude', events, 'C:\\wt')('agy:c1'), false);
});

test('AC-6: a tab run prompt hands off through the done file instead of a final message', () => {
  const p = buildVendorPrompt({ card: { id: 'c1', acceptanceCriteria: [] }, vendor: 'gemini', seed: 'SEED', doneFile: 'C:\\wt\\c1\\.glmps-vendor-done.md' });
  assert.ok(p.includes('write a short plain summary to C:\\wt\\c1\\.glmps-vendor-done.md'));
  assert.doesNotMatch(buildVendorPrompt({ card: { id: 'c1' }, vendor: 'gemini', seed: 'SEED' }), /done\.md/);
  assert.doesNotMatch(p, /stay in the session/);
  assert.match(p, /write the summary file again/);
});

test('a "use <model>" directive names the vendor through its aliases', () => {
  assert.equal(parseModelDirective('use gemini'), 'gemini');
  assert.equal(parseModelDirective('Fix the flaky clock test. Use GPT for this one.'), 'gpt');
  assert.equal(parseModelDirective('Add the panel.\nuse codex'), 'gpt');
  assert.equal(parseModelDirective('- use xai'), 'grok');
  assert.equal(parseModelDirective('Use Claude'), 'claude');
});

test('a passing mention is not a directive', () => {
  assert.equal(parseModelDirective('we use codex sessions in the adapter tests'), null);
  assert.equal(parseModelDirective('Refuse to use geminis'), null);
  assert.equal(parseModelDirective(''), null);
  assert.equal(parseModelDirective(undefined), null);
});

test('the model field normalises aliases and refuses unknown vendors', () => {
  assert.deepEqual(normalizeModelField('Gemini'), { ok: true, value: 'gemini' });
  assert.deepEqual(normalizeModelField('openai'), { ok: true, value: 'gpt' });
  assert.deepEqual(normalizeModelField('gemini:Gemini 4 Argon (High)'), { ok: true, value: 'gemini:Gemini 4 Argon (High)' });
  assert.deepEqual(normalizeModelField(''), { ok: true, value: null });
  assert.deepEqual(normalizeModelField('claude'), { ok: true, value: null });
  assert.equal(normalizeModelField('llama').ok, false);
  assert.equal(normalizeModelField('gemini:$(rm -rf)').ok, false);
  assert.equal(normalizeModelField(7).ok, false);
});

test('the field wins over the text, and blank means Claude', () => {
  assert.deepEqual(resolveCardModel({ title: 'x', prompt: 'use gemini' }), { vendor: 'gemini', model: null, source: 'text' });
  assert.deepEqual(resolveCardModel({ title: 'x', prompt: 'use gemini', model: 'gpt' }), { vendor: 'gpt', model: null, source: 'field' });
  assert.deepEqual(resolveCardModel({ title: 'x', prompt: 'use gemini', model: 'gemini:Gemini 4 Argon (High)' }), { vendor: 'gemini', model: 'Gemini 4 Argon (High)', source: 'field' });
  assert.deepEqual(resolveCardModel({ title: 'x', prompt: 'plain card' }), { vendor: 'claude', model: null, source: 'default' });
  assert.deepEqual(resolveCardModel({ title: 'x', prompt: 'plain card', model: '' }), { vendor: 'claude', model: null, source: 'default' });
});

test('Gemini is on by default; GPT and Grok switch on through runner config', () => {
  assert.equal(vendorEnabled('gemini'), true);
  assert.equal(vendorEnabled('gpt'), false);
  assert.equal(vendorEnabled('gpt', { vendors: { gpt: { enabled: true } } }), true);
  assert.equal(vendorEnabled('gemini', { vendors: { gemini: { enabled: false } } }), false);
  assert.equal(vendorEnabled('nope'), false);
});

test('AC-3: non-Claude models take code and docs cards only', () => {
  const ok = vendorEligibility({ vendor: 'gemini', card: { title: 'Fix the broken parser', prompt: 'The parser crashes on empty input.' } });
  assert.equal(ok.allowed, true);
  const docs = vendorEligibility({ vendor: 'gemini', card: { title: 'Update the readme', prompt: 'Document the new adr in the docs.' } });
  assert.equal(docs.allowed, true);
  const ops = vendorEligibility({ vendor: 'gemini', card: { title: 'Install the hook', prompt: 'Change the ci pipeline config and env.' } });
  assert.equal(ops.allowed, false);
  assert.match(ops.reason, /an ops card/);
});

test('an unclassified card runs on the model the operator named; review and research stay on Claude', () => {
  const plain = vendorEligibility({ vendor: 'gemini', card: { title: 'Use gemini to see if the tab prefix can be the glmps icon', prompt: 'this is a test' } });
  assert.equal(plain.taskClass, 'other');
  assert.equal(plain.allowed, true);
  const review = vendorEligibility({ vendor: 'gemini', card: { title: 'Review and audit the parser', prompt: 'verify coverage' } });
  assert.equal(review.allowed, false);
  assert.match(review.reason, /a review card/);
  assert.match(review.reason, /use claude/);
  const research = vendorEligibility({ vendor: 'gemini', card: { title: 'Research and compare options', prompt: 'investigate why' } });
  assert.equal(research.allowed, false);
});

test('AC-3: deploy, prod, service and secret wording stays on Claude whatever the class', () => {
  for (const prompt of ['Fix the bug, then deploy it.', 'Fix the prod crash.', 'Fix the bug and restart the service.', 'Fix the bug in how secrets are read.']) {
    const r = vendorEligibility({ vendor: 'gemini', card: { title: 'Fix a bug', prompt } });
    assert.equal(r.allowed, false, prompt);
  }
});

test('AC-3: reviews, unknown vendors and switched-off vendors are refused; Claude always runs', () => {
  const card = { title: 'Fix the broken parser', prompt: 'crash' };
  assert.equal(vendorEligibility({ vendor: 'gemini', card, reviewer: true }).allowed, false);
  assert.equal(vendorEligibility({ vendor: 'llama', card }).allowed, false);
  const off = vendorEligibility({ vendor: 'gpt', card });
  assert.equal(off.allowed, false);
  assert.match(off.reason, /codex login/);
  assert.equal(vendorEligibility({ vendor: 'claude', card: { title: 'deploy prod', prompt: '' } }).allowed, true);
});

test('the vendor prompt points the agent at its own rules file and fences push, merge and instruction files', () => {
  const p = buildVendorPrompt({ card: { id: 'c-1', acceptanceCriteria: [{ text: 'AC-1: it works' }] }, vendor: 'gemini', seed: 'SEED BODY' });
  assert.match(p, /read GEMINI\.md/);
  assert.match(p, /Do not commit, push, merge, or run gh/);
  assert.match(p, /AGENTS\.md, GEMINI\.md, hooks\//);
  assert.match(p, /- AC-1: it works/);
  assert.ok(p.endsWith('SEED BODY'));
  assert.match(buildVendorPrompt({ card: { id: 'c' }, vendor: 'gpt', seed: '' }), /read AGENTS\.md/);
});

test('the vendors config merges per vendor and refuses unknown ids or non-boolean flags', () => {
  assert.deepEqual(mergeVendorsConfig({ gemini: { enabled: true } }, { gpt: { enabled: true } }), { value: { gemini: { enabled: true }, gpt: { enabled: true } } });
  assert.ok(mergeVendorsConfig({}, { llama: { enabled: true } }).error);
  assert.ok(mergeVendorsConfig({}, { claude: { enabled: false } }).error);
  assert.ok(mergeVendorsConfig({}, { gpt: { enabled: 'yes' } }).error);
  assert.ok(mergeVendorsConfig({}, []).error);
});

const doc = (over = {}) => ({ agent: { status: 0, text: 'done', usage: { total: 10 }, authFailed: false }, changed: ['a.js'], fence: { ok: true, violations: [] }, tests: { ran: true, exitCode: 0, selection: 'ran', tail: 'ok' }, prUrl: 'https://github.com/o/r/pull/1', error: null, ...over });
const verdict = (d) => vendorRunVerdict({ vendor: 'gemini', model: null, parsed: { doc: d }, wallMs: 60000, acceptanceCount: 2 });

test('the runner gate: green tests, held fence and a PR are PASS citing every AC', () => {
  const v = verdict(doc());
  assert.equal(v.gate.status, 'PASS');
  assert.equal(v.pushed, true);
  assert.ok(v.gate.evidence.some((e) => /AC-1, AC-2/.test(e)));
});

test('the runner gate: a breach or red tests FAIL even when the result also carries an error', () => {
  assert.equal(verdict(doc({ fence: { ok: false, violations: ['.env'] }, error: 'fence breach' })).gate.status, 'FAIL');
  assert.equal(verdict(doc({ tests: { ran: true, exitCode: 1, tail: 'fail 1' }, prUrl: null, error: 'tests failed' })).gate.status, 'FAIL');
});

test('the runner gate: sign-in failure, no change, an error or no PR are CONCERNS and push nothing', () => {
  for (const d of [doc({ agent: { authFailed: true } }), doc({ changed: [] }), doc({ error: 'push failed', prUrl: null }), doc({ prUrl: null }), doc({ tests: { ran: false } })]) {
    assert.equal(verdict(d).gate.status, 'CONCERNS', JSON.stringify(d));
  }
  assert.equal(vendorRunVerdict({ vendor: 'gemini', parsed: { error: 'timed out' }, wallMs: 1 }).gate.status, 'CONCERNS');
});

// F2 (card glmps-2-0-172): exit 0 from the selection script is not green tests.
test('the runner gate: tests that selected nothing, needed the full suite, were skipped or report no selection are CONCERNS, still filed', () => {
  const cases = [
    [{ ran: true, exitCode: 0, selection: 'none', tail: 'affected-tests: nothing to run' }, /selected no test/],
    [{ ran: true, exitCode: 0, selection: 'full', tail: 'full suite needed (package.json)' }, /full suite/],
    [{ ran: true, exitCode: 0, tail: 'ok' }, /did not say which tests ran/],
    [{ ran: false, exitCode: null, tail: '', skipped: 'the change edits the test harness (package.json)' }, /test harness/],
  ];
  for (const [tests, why] of cases) {
    const v = verdict(doc({ tests }));
    assert.equal(v.gate.status, 'CONCERNS', JSON.stringify(tests));
    assert.equal(v.pushed, true);
    assert.ok(v.gate.evidence.some((e) => why.test(e)), JSON.stringify(v.gate.evidence));
    assert.doesNotMatch(v.finishText, /tests green/);
  }
});

test('the desktop result parses from stdout, and an unusable answer is an error', () => {
  assert.deepEqual(parseVendorResult({ result: { status: 0, stdout: '{"prUrl":null}' } }), { doc: { prUrl: null } });
  assert.ok(parseVendorResult({ result: { status: 1, stdout: 'boom' } }).error);
  assert.ok(parseVendorResult({ error: new Error('NO_SHELL') }).error);
  assert.ok(parseVendorResult({ result: { timedOut: true } }).error);
});

test('vendor session ids match the capture adapters\' ids', () => {
  assert.equal(adapterSessionMatcher('gemini', 'abc')('agy:abc'), true);
  assert.equal(adapterSessionMatcher('gpt', '01a1')('codex:rollout-2026-11-06T10-00-00-01a1'), true);
  assert.equal(adapterSessionMatcher('gpt', null)('codex:x'), false);
});
