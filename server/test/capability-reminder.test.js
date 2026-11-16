// Tests for the UserPromptSubmit capability-reminder rules.
//
// Guard proposer cutover: this hook no longer reads
// learning-templates.js's TEMPLATES (deleted) - every reminder carries its
// own literal `msg` text, so the anti-drift tests that used to cross-check
// RULES against TEMPLATES are gone too (nothing left to drift from).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityReminders } from '../../hooks/capability-reminder.js';

test('UI/design prompts -> UI design skills reminder', () => {
  for (const p of [
    'restyle the dashboard with a nicer color palette',
    'fix the CSS spacing on this component',
    'update the layout of app.js and styles.css',
    'make the UI more colorful',
  ]) {
    const r = capabilityReminders(p);
    assert.ok(r.some(x => /ui-density/.test(x)) && !r.some(x => /frontend-design/.test(x)), `expected UI design skills for: ${p}`);
  }
});

test('bug prompts -> diagnosing-bugs reminder', () => {
  for (const p of [
    'this is failing with an error',
    'the diff popup is broken',
    'why is the agy session not working',
  ]) {
    const r = capabilityReminders(p);
    assert.ok(r.some(x => /diagnosing-bugs/.test(x)), `expected debugging for: ${p}`);
  }
});

test('feature prompts -> grilling then to-spec reminder', () => {
  const r = capabilityReminders('implement a new feature to track git pushes');
  assert.ok(r.some(x => /grilling.*to-spec/.test(x)));
});

test('parallel work -> subagents reminder', () => {
  const r = capabilityReminders('do this across all the projects in parallel');
  assert.ok(r.some(x => /subagents/.test(x)));
});

test('unrelated prompt -> no reminders (low noise)', () => {
  assert.deepEqual(capabilityReminders('what time does the market open'), []);
  assert.deepEqual(capabilityReminders('push to origin'), []);
});

test('non-string input -> empty, never throws', () => {
  assert.deepEqual(capabilityReminders(null), []);
  assert.deepEqual(capabilityReminders(undefined), []);
  assert.deepEqual(capabilityReminders(42), []);
});

test('caps at 3 reminders', () => {
  const r = capabilityReminders('build a new UI component, it is broken, do it across all projects in parallel');
  assert.ok(r.length <= 3);
});

test('NinjaScript prompts -> headless compile reminder', () => {
  for (const p of [
    'update the NinjaScript indicator logic',
    'fix this NinjaTrader strategy',
    'edit the .cs file for the new stop rule',
  ]) {
    const r = capabilityReminders(p);
    assert.ok(r.some(x => /test_ninjascript_compile/.test(x)), `expected compile reminder for: ${p}`);
  }
});

test('codebase-orientation prompts -> graphify reminder', () => {
  for (const p of [
    'how does the event pipeline work',
    'where is the session list rendered',
    'refresh yourself on the architecture before we start',
    'trace the data flow from tap to UI',
  ]) {
    const r = capabilityReminders(p);
    assert.ok(r.some(x => /graphify/.test(x)), `expected graphify for: ${p}`);
  }
});

test('done-claim prompts -> run-the-check reminder', () => {
  for (const p of [
    'is it done?',
    'are we done here',
    'ship it',
    'it works now, ready to commit',
  ]) {
    const r = capabilityReminders(p);
    assert.ok(r.some(x => /run the check that proves it/.test(x)), `expected done-check for: ${p}`);
  }
});

test('new rules - unrelated prompts still return [] (low noise)', () => {
  assert.deepEqual(capabilityReminders('show me the session list'), []);
  assert.deepEqual(capabilityReminders('what is the current branch'), []);
});

test('bash-grep trigger surfaces the Grep/Read reminder', () => {
  const r = capabilityReminders('can you grep the codebase for the handler');
  assert.ok(r.some(x => /Grep\/Read/.test(x)), `expected the bash-grep reminder; got ${JSON.stringify(r)}`);
});

test('critique prompts -> visual-critique reminder', () => {
  for (const p of ['critique this screen', 'can you do a design review of the panel', 'the header looks off']) {
    const r = capabilityReminders(p);
    assert.ok(r.some(x => /critique-screen/.test(x)), `expected critique reminder for: ${p}`);
  }
});

test('accessibility prompts -> WCAG 2.2 reminder', () => {
  for (const p of ['run an a11y audit', 'check the contrast ratio', 'is this WCAG compliant', 'make it work with a screen reader']) {
    const r = capabilityReminders(p);
    assert.ok(r.some(x => /wcag-accessibility/.test(x)), `expected accessibility reminder for: ${p}`);
  }
});

// --- routeReminder: roster agent and skill cueing for interactive prompts ---
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReminder } from '../../hooks/capability-reminder.js';

const ROUTES = { debug: 'debugger', feature: 'tdd-implementer', research: 'web-researcher', ui: 'ui-designer' };
const VOCAB = { cues: [], operatorCues: [], defaults: { debug: 'diagnosing-bugs', feature: 'tdd', research: 'research', ui: 'prototype' } };
const OPTS = { vocab: VOCAB, routes: ROUTES, minConfidence: 0.5, minScore: 1 };
const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'capability-reminder.js');

test('routeReminder: debug prompt names debugger and diagnosing-bugs', () => {
  const r = routeReminder('the merge queue is failing with a timeout error, fix it', OPTS);
  assert.ok(Array.isArray(r), 'expected lines');
  const text = r.join('\n');
  assert.match(text, /`debugger` agent/);
  assert.match(text, /`diagnosing-bugs`/);
});

test('routeReminder: feature prompt names tdd-implementer and the ownership line', () => {
  const r = routeReminder('implement a new feature to track git pushes per session in the dashboard', OPTS);
  const text = (r ?? []).join('\n');
  assert.match(text, /`tdd-implementer`/);
  assert.match(text, /state the objective and what done means/);
  assert.match(text, /I will X unless you say otherwise/);
});

test('routeReminder: runner launch, slash command, short and wrapper-only prompts yield null', () => {
  assert.equal(routeReminder('Backlog card glmps-2-0-1 is yours, the merge queue is failing with an error', OPTS), null);
  assert.equal(routeReminder('Read the task described in this file and fix the failing error please', OPTS), null);
  assert.equal(routeReminder('/diagnose the merge queue is failing with a timeout error', OPTS), null);
  assert.equal(routeReminder('fix the bug', OPTS), null);
  assert.equal(routeReminder(null, OPTS), null);
  assert.equal(routeReminder('<system-reminder>the merge queue is failing with a timeout error, fix it now</system-reminder>', OPTS), null);
  assert.equal(routeReminder('<command-name>/clear</command-name> <command-message>clear the failing error again and again</command-message>', OPTS), null);
});

test('routeReminder: a throwing classifier yields null without throwing', () => {
  const r = routeReminder('the merge queue is failing with a timeout error, fix it', { ...OPTS, classify: () => { throw new Error('boom'); } });
  assert.equal(r, null);
});

test('hook CLI: exits 0 and prints the route line for a debug prompt', () => {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ prompt: 'the merge queue is failing with a timeout error, fix it' }),
    encoding: 'utf8',
    env: { ...process.env, HOME: process.cwd(), USERPROFILE: process.cwd() },
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /dispatch the `debugger` agent/);
  assert.match(res.stdout, /diagnosing-bugs/);
});

test('hook CLI: garbage stdin still exits 0 with no output', () => {
  const res = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});
